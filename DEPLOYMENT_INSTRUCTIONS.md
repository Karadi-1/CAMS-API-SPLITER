# Deployment and migration — version 2

This guide replaces the June 2026 instant-deployment advice. A passing mock test suite is not proof of a live ERP integration. The maintained contracts and recovery behaviour are in [README.md](README.md).

## Prepare contracts and hosting

1. Identify each CAMS device/serial and company ownership. Capture redacted real attendance and any relevant break/meal/overtime callbacks. Compare them with the supported `RealTime.PunchLog` schema. Confirm token and optional encryption settings. Use per-device registry credentials when devices have different tokens.
2. Obtain the **actual Sixorbit endpoint and receiving schema**, its authorization method, employee identifier and response acceptance rule. The service supports the original requested Bearer header and the SO Framework external API's API-Key/HMAC signature scheme via `BGC_SIXORBIT_AUTH_MODE`. Confirm which applies to the attendance receiver; framework docs alone do not identify that route or tenant. The repository does not invent a Sixorbit API URL.
3. Verify SEMPL's exact tenant URL, installed Frappe/HRMS version and Employee Checkin method. Current Frappe HR documents `/api/method/hrms.hr.doctype.employee_checkin.employee_checkin.add_log_based_on_employee_field`; that is a candidate route to verify on the intended tenant, not an assumed endpoint. Custom CAMS receivers can use `cams-json` or `mapped-json` instead.
4. Establish employee Attendance Device IDs and optional device-scoped lookup mappings. Verify uniqueness and company permissions. Approve native Frappe punch-type mappings, shift/auto-attendance setup and original timestamp timezone. The company label in this service is not an ERP permission boundary.
5. Select a long-lived single-instance Node 22.16+ or 24 service and a **mounted durable local disk**. Run the queue outside the Git checkout and outside OneDrive/network-synchronised folders. Set `QUEUE_DB_PATH` to an absolute file path on that disk. Do not use ephemeral serverless compute or replicas with separate local queues. Confirm filesystem flush durability, disk capacity, backup encryption and restore procedure with the host.

## Configure and stage

```sh
npm ci --ignore-scripts
npm run check
npm test
cp .env.example .env
# Supply real staging contract values, scoped staging credentials and persistent queue path.
npm start
```

Use `NODE_ENV=production` on the deployed service; both ERP URLs must use HTTPS. Expose inbound HTTPS with a valid certificate and bounded body/upload time at the reverse proxy. For local HTTP mocks only, use a development environment. The process uses the hosting provider's `PORT` if set.

- Set the exact `/webhook/cams` URL; query strings/trailing slashes are not accepted aliases.
- Plaintext callbacks require `Content-Type: application/json`. With CAMS payload encryption enabled, configure the same key bytes as `CAMS_ENCRYPTION_KEY_HEX` and test the raw Base64 vendor format.
- `cams-json` now contains only scalar attendance fields and excludes the CAMS token and biometric data. An existing receiver must use the separately supplied Authorization header and accept the sanitised schema.
- `mapped-json` requires a field map and verified response path/value. `frappe-checkin` expects a returned Employee Checkin `message.name`. Confirm error and duplicate behaviour. Do not count HTTP 200 alone as success.
- The old arbitrary `{AuthToken,data:{...}}` format is no longer a supported generic relay. Root-level **attendance** payloads require `CAMS_ALLOW_LEGACY_FLAT=true` and the documented SerialNumber/PunchLog fields.
- Configure callback Handle Response according to CAMS documentation and test how 503/non-done responses are retried. Authorised work is acknowledged only after durable commit. Invalid auth and non-attendance events are observed and acknowledged without ERP delivery. Review rejection logs/counters.

Verify synthetic records independently in each staging ERP: correct company and employee, original punch time, timezone, direction, record ID and shift behaviour. Test BGC down/SEMPL up, the reverse, both down, credential failure, response loss after commit, duplicate/resend, forced process death, disk failure and failed-target replay. Native Frappe does not promise support for the Idempotency-Key header: establish receiver duplicate handling before production.

Measure hosted acknowledgment latency, including SQLite durable writes and reverse-proxy/TLS cost. The original normal-under-50-ms target needs real measurement. Monitor queue throughput and oldest age: one serial worker per target deliberately bounds connections and preserves persisted arrival order; it must meet actual punch volume.

## Operations

- Probe `/healthz` for liveness. Monitor `/readyz` for storage, backlog and dead-work attention; a 503 due to an old failed delivery must not trigger endless restarts or automatically prevent new recoverable callbacks reaching the app. Restrict probe endpoints at the proxy.
- Configure external alerts for dead count, queue age, rejection count, storage failures and disk space. Built-in counters are per-process; delivery state is durable. This repository does not install an alerting provider.
- Inspect `npm run queue -- status`. Replay one dead destination after fixing its credentials/availability. A changed receiver contract requires an explicit fingerprint-confirmed rebuild; see README. Do not reset successful peer deliveries or delete the database as a retry mechanism.
- Pending/dead payloads contain attendance only. Successful payloads/source are cleared; event tombstones and receiver IDs remain. Define retention, encrypted backups, access and reconciliation ownership. SQLite deletion does not guarantee forensic erasure from prior WAL pages/backups.
- Handle SIGTERM with a host grace period longer than `SHUTDOWN_TIMEOUT_MS`. Hard crashes recover inflight claims after the delivery timeout plus two seconds. Expect possible repeated requests after an ambiguous response; receiver idempotency is required.
- Before changing receiver URL/company/mapping/timezone, drain or review queued work. The fingerprint prevents silent retargeting. Credential rotations preserve the original binding.

## Cutover and rollback

1. Obtain review/approval for the tested candidate and verified account/tenant bindings.
2. Back up the previous callback settings, deploy the exact candidate with its persistent disk and verify readiness. Avoid overlapping active old/new consumers unless duplicate handling has been proven.
3. Switch only the approved CAMS devices to the new callback. Record the cutover time and reconcile punch counts/created records in both ERPs. Leave unrelated company settings untouched.
4. On rollback, stop acceptance and drain/preserve the new queue before restoring the prior callback. Retain its database for outstanding deliveries and reconciliation. Do not run an old fire-and-forget version against the new queue or discard pending attendance.

No live portal change, ERP write or production deployment is implied by this guide or the PR.

Primary references: [CAMS setup and response handling](https://forum.camsbiometrics.com/comprehensive-user-guide-for-api-configuration-with-biometric-machines-and-admin-tools-a-first-time-setup-guide/), [Frappe biometric integration](https://docs.frappe.io/hr/integrating-frappe-hr-with-biometric-attendance-devices).
