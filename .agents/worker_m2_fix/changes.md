# Code Changes

## Hardening Improvements in `server.js`

1. **Persistent Connection Reuse**:
   - Initialized persistent global HTTP and HTTPS agents (`httpAgent` and `httpsAgent`) with `keepAlive: true`.
   - Enabled TCP socket reuse for target system forwardings.

2. **Startup Environment Validation**:
   - Added checks on startup to detect missing `CAMS_AUTH_TOKEN`, `BGC_SIXORBIT_URL`, or `SEMPL_ERPNEXT_URL`.
   - Logs visible warnings without halting startup so the host remains configurable.

3. **Incoming Webhook Payload Limits**:
   - Implemented request body size limit of 1MB.
   - Evaluates `Content-Length` header on arrival and returns HTTP 413 immediately if too large.
   - Tracks data chunk sizes during consumption and destroys the request/stream if they accumulate beyond 1MB.

4. **Outgoing Response Limits**:
   - Added response stream `res` body size limit of 1MB inside `forwardRequest`.
   - Stream is destroyed and request is rejected if target response body exceeds 1MB.

5. **Stream Decoding (UTF-8 Characters)**:
   - Configured `req.setEncoding('utf8')` in main HTTP server.
   - Configured `res.setEncoding('utf8')` in `forwardRequest` response stream.
   - Prevents character bleeding on multi-byte UTF-8 data chunks.

6. **Error Event Listening**:
   - Bound an `'error'` handler to target response `res` stream to prevent unhandled exceptions and process crashes if a connection terminates abruptly.
   - Bound an `'error'` handler to the main HTTP `server` to handle address binding conflicts (`EADDRINUSE`) gracefully.

7. **Token Redaction in Logs**:
   - Sanitized printouts for unauthorized AuthToken tokens by masking values (showing only first/last 2 characters and length) to prevent leakage of credentials.

---

## Expanded Test Coverage in `test_splitter.js`

1. **14 Core Cases Implemented**:
   - Added all 14 test cases matching `TEST_INFRA.md`, including Case 3.4 (All targets offline) and Case 4.3 (DNS/network errors under malformed URLs).

2. **Process Output Verification**:
   - Implemented stdout and stderr listeners to intercept logs for verification.
   - Asserts console message formats on success (Case 4.1) and failure (Case 4.2).

3. **Custom Env Sandbox Helper**:
   - Added `runCustomSplitterTest` helper to test startup alerts, port conflict handling, and malformed URL configurations safely.

4. **Adversarial & Robustness Test Cases**:
   - Implemented Case 5.1 (payload size limit / 413 verification).
   - Implemented Case 5.2 (downstream response limit verification).
   - Implemented Case 5.3 (credential masking verification).
   - Implemented Case 5.4 (UTF-8 character preservation).
   - Implemented Case 5.5 (startup environment variable validation warnings).
   - Implemented Case 5.6 (port conflict EADDRINUSE handling).
