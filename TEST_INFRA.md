# Verification architecture

The maintained suites use `node:test`, Node HTTP mocks bound to loopback on ephemeral ports, and a temporary SQLite file per integration test. They require Node 22.16+ or 24 and no live credentials or network destinations. Tests clean up their workers, connections and temporary data.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:adversarial
```

Legacy entry points remain: `node test_splitter.js` runs integration tests; `node test_splitter_adversarial.js` and `node test_adversarial.js` run adversarial tests. They no longer assert that 5–10 MB bodies should be accepted. The concurrency test measures receipt separately from completion: both mocks may receive promptly while one delays its response.

## Coverage

- `test/attendance.test.js`: actual CAMS envelope, strict auth values, root/RealTime ambiguity, allowlisted fields and credential/template exclusion, explicit flat compatibility, stable physical event identity, calendar/timezone parsing, midnight handling, adapters, device/employee mapping, encryption and startup validation.
- `test/integration.test.js`: committed rows visible to an independent SQLite reader before acknowledgment; auth headers and payload mapping; independent target completion/logging; retries without repeating a successful peer; restart and SIGKILL recovery; storage failure; dead-letter replay and explicit contract rebinding; unmapped Frappe types; per-device routing; capacity; encrypted callbacks; probes; 50 concurrent unique events.
- `test/adversarial.test.js`: object-token crash regression; malformed/ambiguous/non-attendance payloads; deep and prototype-shaped subtrees; received-byte bounds for chunked multibyte input; abrupt uploads; drip-fed and aborted responses; HTTP/application failures; response size limits; native Frappe acceptance criteria.
- `test/queue.test.js`: actual operator CLI status/replay/rebuild, completed-target protection, private queue file permissions, and atomic rollback of a failed partial enqueue.

CI runs syntax and the full suite on Node 22 and 24. Success is represented by the test process exit status, not static review labels. No test launches real CAMS or ERP calls. Test timing tolerances isolate waiting for an ERP response; hosted under-50-ms acceptance remains a staging measurement.

## Required staging evidence

Real account-shaped redacted callbacks, verified tenant/employee permissions, record creation in both intended ERPs, response-loss duplicate handling, outage/restart recovery, actual disk durability/backup restore, reverse-proxy behaviour and hosted latency must be checked before callback cutover. See DEPLOYMENT_INSTRUCTIONS.md.
