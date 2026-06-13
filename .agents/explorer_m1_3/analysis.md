# E2E Test Suite Design Analysis

This report outlines the environment analysis, E2E test suite architecture, and Tier 1-4 test coverage designed for the CAMS API Splitter project.

## 1. Environment & Workspace Findings
- **Workspace State**: The workspace is empty except for the `.agents/` metadata directory and the `ORIGINAL_REQUEST.md` at the root level.
- **Node.js Environment**: Command-line execution requests timed out due to lack of user interaction. To ensure the design is fully robust and works without dependency resolution blockers, the E2E verification script `test_splitter.js` is designed to be **entirely dependency-free**, using only Node.js core library modules (`http`, `child_process`, `assert`).
- **No package.json**: As there is no pre-existing `package.json` in the root, our zero-dependency test runner can run immediately once `node server.js` is implemented, without requiring `npm install` for testing.

---

## 2. Test Suite Architecture and Mock Mappings
The proposed E2E framework uses local mock HTTP servers to act as the downstream ERP systems:
1. **BGC Sixorbit Mock Server**: Listens on port `13001` (mocking `BGC_SIXORBIT_URL`).
2. **SEMPL ERPNext Mock Server**: Listens on port `13002` (mocking `SEMPL_ERPNEXT_URL`).
3. **Splitter API Under Test**: Spawned as a child process on port `13000` (`server.js`).

Mock server states are updated dynamically per test to assert headers, bodies, response times, and resilience.

---

## 3. Tier 1-4 Case Implementations in `test_splitter.js`

### Tier 1: Webhook Endpoint and Immediate Acknowledgment
- **Verification**: Validates that `POST /webhook/cams` immediately acknowledges requests.
- **Latency Independence**: Mock servers are configured with `delayMs = 200`. The test asserts that the splitter's response time is `< 100ms` (ideally `< 50ms`), proving it does not block on downstream forwarding.
- **Response Format**: Asserts that the response is `200 OK` with JSON `{"status": "done"}`.

### Tier 2: Webhook Authentication
- **Verification**: Asserts CAMS authentication behavior against the `CAMS_AUTH_TOKEN` variable:
  - **Valid Token**: Returns `200 OK` / `{"status": "done"}` and forwards payloads to both mock servers.
  - **Invalid Token**: Returns `200 OK` / `{"status": "done"}` but does **not** forward payloads (asserts mock queue length remains 0).
  - **Missing Token**: Returns `200 OK` / `{"status": "done"}` and does **not** forward.

### Tier 3: Payload Cleaning and Concurrent Forwarding
- **Verification**: Checks payload modification and routing headers:
  - **Payload Cleaning**: Asserts that `body.AuthToken` is `undefined` on requests received by both mock servers.
  - **Auth Headers**: Asserts that BGC Sixorbit receives `Authorization: Bearer <BGC_SIXORBIT_TOKEN>` and SEMPL ERPNext receives `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`.
  - **Payload Structure**: Verifies that the nested `data` object remains intact.

### Tier 4: Resiliency and Error Handling
- **Verification**: Verifies that failure/unresponsiveness of one ERP system does not impact the other:
  - **Target returns 500**: Mock Sixorbit returns `500`. Asserts that SEMPL ERPNext still receives the payload.
  - **Target is slow**: Mock Sixorbit is slow (500ms). Asserts that SEMPL ERPNext receives the payload instantly, and the overall test assertion isn't blocked.
  - **Socket Hangup**: Mock ERPNext drops the connection instantly. Asserts that BGC Sixorbit still receives the payload and the splitter does not crash.

---

## 4. Proposed Files Created
- **`TEST_INFRA.md`**: Technical specification and documentation of the E2E test suite.
- **`test_splitter.js`**: Core verification test script containing the mock servers and assertions.
