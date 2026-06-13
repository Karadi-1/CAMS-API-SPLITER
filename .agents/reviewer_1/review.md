# Quality and Adversarial Review — Webhook Splitter API

## Review Summary

**Verdict**: REQUEST_CHANGES

The Webhook Splitter API implementation (`server.js`) is clean, written using only Node.js built-in modules, and correctly implements core features: immediate response acknowledgment, token-based authentication, payload cleansing, and concurrent asynchronous forwarding via `Promise.allSettled`.

However, we must request changes due to a **Major gap in test suite completeness**: the test runner `test_splitter.js` does not implement all 14 test cases defined in `TEST_INFRA.md` and `TEST_READY.md`. Furthermore, due to environmental permission constraints on `run_command` (timeouts), we were unable to execute the tests locally.

---

## Findings

### [Major] Finding 1: Incomplete Test Suite Coverage in `test_splitter.js`

- **What**: The test runner `test_splitter.js` does not implement all of the 14 E2E test cases specified in the test design docs (`TEST_INFRA.md` and `TEST_READY.md`).
- **Where**: `test_splitter.js`
- **Why**: 
  - **Case 3.4 (All-Targets Offline)**: The test runner does not run a scenario where both mock servers are offline or hanging up simultaneously.
  - **Case 4.1 & 4.2 (Success & Failure Logging)**: The runner does not inspect the console stdout/stderr streams of the spawned `server.js` child process to assert that specific logging strings (e.g. `Successfully forwarded payload to...` and `Failed to forward payload to...`) are actually printed.
  - **Case 4.3 (DNS/Network Exceptions)**: There is no test case configuring the splitter with invalid/malformed target URLs to assert that the errors are handled asynchronously without crashing.
- **Suggestion**: Update `test_splitter.js` to implement these missing test cases. For log verification, capture the stdout/stderr data events from `splitterProcess` and assert that the expected log strings are printed when events are triggered.

### [Minor] Finding 2: Missing Payload Size Limits in `server.js`

- **What**: The HTTP server in `server.js` does not limit the incoming POST payload size.
- **Where**: `server.js` (lines 127-145)
- **Why**: An attacker could send an extremely large payload, leading to event loop blocking and eventual out-of-memory (OOM) crash of the server.
- **Suggestion**: Add a length check on the incoming data chunks (e.g. if cumulative data size exceeds 1MB, destroy the request and return an error).

### [Minor] Finding 3: Missing Error Handler on Client Response Stream in `server.js`

- **What**: No `'error'` event handler is attached to the client response object (`res`) in the HTTP forwarding client.
- **Where**: `server.js` (lines 43-55)
- **Why**: If the network connection drops or errors out while reading the response body, it may result in an unhandled exception or hung promise.
- **Suggestion**: Add `res.on('error', (err) => reject(err));` in the request response callback.

---

## Verified Claims

- **Immediate Acknowledgment** -> Verified via code inspection of `server.js` (lines 151-153) -> **PASS**
  - The server immediately calls `res.writeHead(200)` and `res.end()` on the incoming request before initiating the asynchronous `processForwarding` sequence.
- **Payload Cleansing** -> Verified via code inspection of `server.js` (lines 161-165) -> **PASS**
  - Uses object destructuring (`const { AuthToken, ...rest } = payload`) to cleanly strip `AuthToken` from the payload sent to the targets.
- **Header Authentication** -> Verified via code inspection of `server.js` (lines 78-104) -> **PASS**
  - Correctly structures `Authorization: Bearer <token>` for Sixorbit and `Authorization: token <key>:<secret>` for Frappe ERPNext.
- **Concurrent Forwarding** -> Verified via code inspection of `server.js` (lines 112-123) -> **PASS**
  - Utilizes `Promise.allSettled` to execute requests concurrently, ensuring one slow or offline target does not block the other.

---

## Coverage Gaps

- **Console Log Verification** — risk level: low — recommendation: investigate. Ensure the splitter logging matches spec.
- **Invalid URL/DNS Resolution Failure handling** — risk level: medium — recommendation: investigate. Confirm that the splitter handles DNS failures gracefully without crashes.

---

## Unverified Items

- **E2E Test Execution** — The E2E tests (`node test_splitter.js`) could not be executed because the `run_command` environment prompt for user permission timed out. Therefore, we could not capture live terminal logs of the run.

---

# Adversarial Challenge (Stress Test Analysis)

## Challenge Summary

**Overall risk assessment**: MEDIUM

While the application code is functional and uses correct concurrency primitives, there are resource limits and edge cases that could cause issues under load.

## Challenges

### [High] Challenge 1: Denial of Service via Large Request Payloads
- **Assumption challenged**: The incoming webhook request body is always within a reasonable size.
- **Attack scenario**: A client sends a continuous stream of large JSON files (e.g. 500MB each) to the `/webhook/cams` endpoint.
- **Blast radius**: The server buffer grows without limits, resulting in a Node.js process Out-of-Memory (OOM) crash, taking the Splitter offline.
- **Mitigation**: Implement a request body size limit check in `server.js`:
  ```javascript
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) { // 1MB limit
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large' }));
      req.destroy();
    }
  });
  ```

### [Medium] Challenge 2: Missing Validation for Missing Environment Variables
- **Assumption challenged**: The environment variables (like `CAMS_AUTH_TOKEN`, target URLs) are always correctly set.
- **Attack/Failure scenario**: The server is started in production without setting the `CAMS_AUTH_TOKEN` environment variable.
- **Blast radius**: Every incoming request will be treated as unauthorized, preventing any webhooks from being forwarded, but the server will still return `200 OK {"status": "done"}` without any visible crash. This silent failure makes it difficult to diagnose.
- **Mitigation**: Add startup-time validation checks that print errors or refuse to start the server if critical env variables are missing:
  ```javascript
  if (!CAMS_AUTH_TOKEN) {
    console.error('CRITICAL: CAMS_AUTH_TOKEN environment variable is not defined.');
    process.exit(1);
  }
  ```
