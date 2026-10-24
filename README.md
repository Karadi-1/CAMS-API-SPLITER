# CAMS attendance splitter

Receives CAMS biometric attendance callbacks and durably delivers them to **BGC Sixorbit** and **SEMPL Frappe ERPNext** with independent credentials, retries and delivery state. Broadcast to both destinations remains the default. This service receives attendance; it does not manage device enrollment or calculate daily payroll attendance.

Version 2 changes the acceptance boundary: a validated event and its intended deliveries commit to SQLite before CAMS receives `200 {"status":"done"}`. ERP calls run afterwards. A failed durable commit returns 503 so the gateway can retry. Local synthetic tests are not evidence of live ERP compatibility or production deployment.

## Run and test

Use Node **22.16+ or 24**; `.nvmrc` selects 24. The runtime uses Node's built-in SQLite module, which emits an experimental warning in Node 22. No npm runtime dependencies are required.

```sh
npm ci --ignore-scripts
npm run check
npm test
cp .env.example .env
# Fill in verified device and ERP contracts, credentials, and an absolute persistent database path.
npm start
```

The environment template intentionally contains empty ERP URLs and secrets. An incomplete configuration fails startup. See [deployment and migration](DEPLOYMENT_INSTRUCTIONS.md) before selecting endpoints or switching callbacks.

## Callback contract

```json
{
  "RealTime": {
    "SerialNumber": "SERIAL-1",
    "OperationID": "operation-1",
    "AuthToken": "device-token",
    "PunchLog": {
      "UserId": "123",
      "Type": "CheckIn",
      "LogTime": "2026-10-24 09:00:00 GMT +0530",
      "InputType": "Fingerprint"
    }
  }
}
```

`POST /webhook/cams` accepts `application/json` in plaintext mode. Required attendance fields are nonempty string `SerialNumber`, `PunchLog.UserId`, `PunchLog.Type` and `PunchLog.LogTime`. Timestamps require an explicit `GMT ±HHMM` offset and accept up to millisecond precision. Supported punch types: CheckIn, CheckOut, BreakIn, BreakOut, OverTimeIn, OverTimeOut, MealIn, MealOut.

Tokens are compared as strings without coercion. Authentication uses only `RealTime.AuthToken`, or a root token in the explicit legacy-flat mode. Supplying both envelopes is rejected as ambiguous. A per-device `CAMS_DEVICES_JSON` registry binds tokens and optional destination lists to device serials; absent the registry, `CAMS_AUTH_TOKEN` authenticates callbacks and both targets receive each valid punch.

Only known scalar attendance fields are reconstructed for storage/forwarding: device serial, user ID, punch type/time, input method, and optional operation ID/device label/callback time. Other fields, nested credential copies, PINs, biometric templates, temperature, face-mask attributes and photos are excluded. Using fingerprint/face as an attendance input method remains supported.

| Situation | Response and handling |
|---|---|
| Valid event committed, or known duplicate | HTTP 200, exact `{"status":"done"}` |
| Incorrect/missing/non-string token or unsupported envelope | HTTP 200 done; rejected counter/log; no delivery |
| Authenticated event without PunchLog | HTTP 200 done; `unsupported_event` log; no delivery |
| Ambiguous envelopes, malformed JSON/UTF-8/encrypted body | HTTP 400; no delivery |
| Authenticated invalid attendance fields | HTTP 422; no delivery |
| Wrong plaintext Content-Type | HTTP 415 |
| Declared or streamed body exceeds byte cap | HTTP 413 |
| Persistence failure, queue capacity reached, shutdown | HTTP 503; no new acceptance |

Invalid authentication continues to be acknowledged as required by the original project. Monitor rejected counters: the HTTP status alone does not prove attendance delivery. Investigate permanent bad payloads instead of repeatedly replaying them.

When the CAMS portal's optional application encryption is enabled, set `CAMS_ENCRYPTION_KEY_HEX` to the 64 hex digits representing the same 32 key bytes. Bodies must be Base64 AES-256-ECB with PKCS padding; the acknowledgment remains plaintext JSON. This implements the vendor format; always use HTTPS as well. One encryption key is supported per service instance.

### Compatibility changes

Legacy **flat attendance** `{AuthToken,SerialNumber,PunchLog,...}` is available with `CAMS_ALLOW_LEGACY_FLAT=true`. The old tests' arbitrary `{AuthToken,data:{...}}` forwarding is deliberately retired: it has no validated attendance schema and would bypass event filtering. Non-attendance objects are observed and discarded. Receivers that relied on extra raw callback fields must update their contract. Version 2 also requires explicit adapter/company/timezone/success settings, persistent storage, and a newer Node runtime.

## ERP adapters and company boundaries

Configure each target independently. Do not infer the URL or authentication method from `.env.example`.

- `cams-json`: post the sanitised CAMS envelope to an existing custom receiver. It must accept requests without the CAMS token, using the target Authorization header.
- `mapped-json`: map configured destination field names to canonical `employeeId`, `userId`, `deviceId`, `occurredAt` (UTC ISO), `timestamp` (target-local datetime), `punchType`, `logType`, `eventId`, or `company`. Field names are flat identifiers. Both generic modes require a dotted `SUCCESS_PATH` and JSON scalar `SUCCESS_VALUE`; `{"success":true}` is only an example contract.
- `frappe-checkin` (SEMPL): call the installed Frappe HR Employee Checkin method. POSTs `employee_field_value`, `timestamp`, `device_id`, `log_type`, and `employee_fieldname=attendance_device_id`; success requires `message.name`. Requires the correct Frappe HR version/route, a scoped API user and employee Attendance Device IDs. It does not mark daily Attendance itself.

Authentication: BGC defaults to `BGC_SIXORBIT_AUTH_MODE=bearer` with `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`. For the [SO Framework external API contract](https://staging.sixorbit.ai/docs/auth-methods), set `BGC_SIXORBIT_AUTH_MODE=api-key-hmac` and `BGC_SIXORBIT_API_KEY`: each request carries `API-Key` and `X-API-Signature`, computed as HMAC-SHA256 over the exact transmitted UTF-8 JSON body using that key. Confirm which scheme the actual attendance endpoint uses; framework documentation does not establish an attendance route or BGC tenant binding. SEMPL uses `Authorization: token <key>:<secret>`. Credentials and signing headers never cross to the other target.

Every request also carries `Idempotency-Key: <event-id>`. No redirects are followed. A 2xx status alone is insufficient: response JSON must satisfy the configured acceptance rule and must not report an application error. 408/425/429/5xx, timeouts and connection failures retry with capped exponential backoff and jitter; other errors require operator review. Downstream response text and credentials are never logged.

`<PREFIX>_EMPLOYEE_MAP_JSON` optionally maps `"serial:user-id"` to the receiver's employee lookup value; otherwise the original device user ID is used. Each side of the colon is URI-component encoded, so a literal colon in an ID becomes `%3A` and cannot collide with another device's mapping. Native Frappe lookup values are **Attendance Device IDs**, not necessarily Employee document names. Set unique IDs and restrict the receiver API user's permissions to the intended company. `<PREFIX>_COMPANY` identifies and pins the contract; it does not enforce company permissions inside an ERP. Do not deploy broadcast unless both receivers are intended to process that stream. Optional registry `targets:["bgc"]`/`["sempl"]` routing must follow approved ownership rules.

Native Frappe defaults to mapping CheckIn/CheckOut only. Unmapped break/meal/overtime events remain as dead SEMPL deliveries for explicit mapping/rebuild, while BGC can still succeed. Approve `SEMPL_ERPNEXT_PUNCH_TYPE_MAP_JSON` semantics before enabling these types. Generic mapped `logType` uses the event's In/Out suffix; use `punchType` when the receiver must distinguish breaks and overtime.

## Delivery guarantees and recovery

SQLite WAL with `synchronous=FULL` commits event identity plus target payloads atomically. Deploy a **single service instance on a durable local mounted disk**, with tested backup/restore; do not put the queue in an ephemeral filesystem, Git, OneDrive, a network share, or separate per-instance disks. Database and sidecars contain attendance while pending; protect the host and use encrypted storage/backups. Size the disk for expected outage backlog and monitor it.

Event identity is a SHA-256 digest of device serial + user ID + normalized punch time + punch type. OperationID changes on resends do not bypass duplicate suppression. Two otherwise identical punches within the device's timestamp precision are treated as one. Confirm that rule against your devices. Delivered rows erase their payload/source while retaining event tombstones, target outcome and optional receiver record ID; duplicate protection persists across restarts. Pending/dead work is retained for recovery up to the configured capacity; there is no automatic destructive purge. Define retention and recovery responsibilities before production. Removing the database also removes duplicate protection.

One worker per target processes persisted arrival order. Retrying the oldest event delays later events for that target; the other target continues. Exhausted/permanent failures become dead and later events proceed. This is not global ordering by punch time: late arrivals retain their original timestamps. Inflight leases recover after a hard crash (outbound deadline + 2 seconds). SIGTERM/SIGINT stop new acceptance, drain or interrupt sends within the shutdown budget, and preserve unfinished work.

Transport is **at least once**: if an ERP commits and its response is lost, a retry can reach it again. The ERP/custom receiver must honour the idempotency key or provide equivalent duplicate handling. Native Frappe does not promise support for this header; verify its duplicate behaviour or use an idempotent custom receiver. Such ambiguous duplicates remain visible for review rather than being guessed successful.

Receiver URL, adapter/authentication mode, company, timezone, mapping and success contract are hashed into every delivery. Changing them cannot silently retarget old work; mismatched work becomes dead. Credential rotation does not change the binding. Replaying or rebuilding always acts on one failed target, never a completed peer. If moving a queue created by the initial version 2 PR candidate to the candidate with explicit authentication modes, review/rebuild pending rows against the new fingerprints; no live migration is automatic.

```sh
npm run queue -- status
npm run queue -- replay --event <64-character-event-id> --target bgc
```

For an intentional receiver/mapping change, inspect the original and new tenant/contract first. `status` shows old and active contract fingerprints. Explicitly consent to rebuilding that single failed delivery using the current adapter:

```sh
npm run queue -- replay --event <event-id> --target sempl --rebuild-for-contract <active-contract-fingerprint>
```

The command requires retained source and dead status; it will not reset a delivered row. Fix unmapped punch types before rebuilding. Queue commands require filesystem access and environment credentials; no public replay/admin endpoint exists.

## Operations and release gates

- `/healthz`: process liveness. `/readyz`: storage readable, queue counts/oldest age and rejection/storage-failure counters; returns 503 for dead work, full active backlog, unavailable storage or shutdown. Do not use readiness as a liveness/restart probe or stop routing recoverable callbacks solely because an old delivery is dead. Keep these endpoints internal at the ingress; no record bodies or tokens are exposed.
- Emit structured event IDs, target, attempt and safe error categories. Alert on dead work, growing oldest age, storage errors, rejected callbacks, disk usage and sustained retry rates. Counters are per-process; queue counts survive restarts. No external alert provider is installed by this code.
- Run staging with real account-shaped redacted fixtures and approved synthetic employees. Independently verify the employee, company, original time, direction, created record and duplicate behaviour in **each ERP**.
- Test outage recovery and a forced process restart, then measure hosted acknowledgment latency including durable disk writes. The original under-50-ms target remains a deployment measurement, not a promise inferred from local mocks.
- Agree cutover/rollback and reconciliation procedures before changing CAMS callback URLs. No portal changes, live ERP writes, deployment or production migration is performed by this PR.

Sources: [CAMS callback example](https://camsbiometrics.com/), [CAMS fields/encryption](https://camsbiometrics.com/application/biometric-api-reference.html), [CAMS setup/Handle Response](https://forum.camsbiometrics.com/comprehensive-user-guide-for-api-configuration-with-biometric-machines-and-admin-tools-a-first-time-setup-guide/), [Frappe HR integration](https://docs.frappe.io/hr/integrating-frappe-hr-with-biometric-attendance-devices).
