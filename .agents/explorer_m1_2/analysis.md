# Analysis Report — Milestone 1 E2E Test Suite Design

## 1. Executive Summary
This report presents the E2E test suite design and verification script for the Node.js Webhook Splitter API. Since the workspace is currently empty (contains only agent directories) and network connectivity is restricted, we propose a **zero-dependency test framework** using Node.js built-in modules (`node:http`, `node:assert`, `node:child_process`). This ensures test verification runs successfully offline in any standard Node.js environment (v18+) without requiring an `npm install` step.

All proposed artifacts are stored in `.agents/explorer_m1_2/`:
- `proposed_TEST_INFRA.md`: Architectural overview and execution flow of the E2E test suite.
- `proposed_test_splitter.js`: Complete, ready-to-use verification script containing local mock servers and automated Tier 1-4 test cases.

---

## 2. Environment & Workspace Diagnostics
- **Workspace State**: The workspace is empty except for the `.agents/` folder and `ORIGINAL_REQUEST.md`. No `package.json`, `server.js`, or other files exist yet.
- **Node.js & npm Access**: Execution of CLI commands timed out waiting for user approval. Under this constraint, we proceed with the assumption of a standard Node.js environment (v18+ or v20+) and design a **zero-dependency** E2E test suite.
- **Approach**: Avoiding third-party testing frameworks (like Jest, Mocha, or Vitest) and HTTP clients (like Axios) removes the need for internet access, node_modules, or external dependencies, perfectly aligning with the `CODE_ONLY` network mode.

---

## 3. Test Suite Architecture

The test suite consists of:
1.  **Dual Mock Target Servers**:
    *   **Mock BGC Sixorbit Server** (port 3001)
    *   **Mock SEMPL ERPNext Server** (port 3002)
    These mock servers capture incoming HTTP requests, record the method, URL, headers, and payload, and can be dynamically configured with behaviors (delays, 5xx errors, socket terminations) to test API resiliency.
2.  **Splitter Server Process under Test**:
    *   Spawned as a child process using Node's `child_process.spawn`.
    *   Configured with test-specific environment variables for ports, API keys, and target URLs.
    *   Log output (stdout/stderr) is captured in memory for assertion checking.
3.  **Client Runner**:
    *   Sends test POST requests to the Splitter API (port 3000).
    *   Runs assertions via `node:assert` and terminates all processes cleanly on completion.

---

## 4. Verification Case Coverage (Tiers 1-4)

The test suite validates the following specific cases derived from the requirements:

### Tier 1: Immediate Acknowledgment and Authentication Check
*   **Case 1.1: Valid Webhook Acknowledgment**: Sending a valid payload and correct token returns HTTP `200 OK` with body `{"status": "done"}` immediately (< 50ms) before the requests are forwarded.
*   **Case 1.2: Invalid Token Handling**: Sending an incorrect `AuthToken` returns `200 OK` with body `{"status": "done"}` but **does not** forward anything.
*   **Case 1.3: Missing Token Handling**: Sending a payload without an `AuthToken` returns `200 OK` with body `{"status": "done"}` but **does not** forward anything.

### Tier 2: Payload Cleaning and Target Forwarding Contracts
*   **Case 2.1: Payload Forwarding**: Cleaned payloads are forwarded concurrently to both BGC Sixorbit and SEMPL ERPNext.
*   **Case 2.2: Payload Cleaning**: The forwarded request bodies **must not** contain the `AuthToken` field.
*   **Case 2.3: BGC Sixorbit Headers**: BGC Sixorbit receives the header `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`.
*   **Case 2.4: SEMPL ERPNext Headers**: SEMPL ERPNext receives the header `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`.

### Tier 3: Concurrency and Resiliency (Non-blocking Delivery)
*   **Case 3.1: Concurrency Verification**: If BGC Sixorbit is slow (e.g. 150ms delay), SEMPL ERPNext (instant response) still receives its forward immediately without waiting.
*   **Case 3.2: Target Offline (BGC)**: If BGC Sixorbit returns an error (e.g. 502 Bad Gateway), SEMPL ERPNext still receives the forward successfully.
*   **Case 3.3: Target Offline (SEMPL)**: If SEMPL ERPNext drops the connection (socket hangup), BGC Sixorbit still receives the forward successfully.
*   **Case 3.4: Splitter Resiliency**: In all failure cases, the Splitter Server handles errors asynchronously and does not crash.

### Tier 4: Resiliency, Logging, and Error Handling
*   **Case 4.1: Success Logging**: Successfully forwarded requests log a message with the target name (`BGC Sixorbit` / `SEMPL ERPNext`).
*   **Case 4.2: Failure Logging**: Unsuccessful forward attempts log a message indicating the target name and the specific error (e.g. status code or socket crash).
*   **Case 4.3: DNS/Network Exception Handling**: Splitter handles malformed target URLs gracefully without crashing.

---

## 5. Next Steps for Implementers
To pass this test suite, the developer of `server.js` should ensure:
1.  **JSON Body Parser**: The express server must use `express.json()` middleware.
2.  **Immediate Response**: The webhook route `/webhook/cams` must respond with status `200` and body `{"status": "done"}` immediately. Forwarding operations must be executed asynchronously (e.g., using `setImmediate` or spawning a promise chain) so that the response is not blocked.
3.  **Concurrency with `Promise.allSettled`**: Do not use `await` sequentially for the forwards. Use `Promise.allSettled` to make both HTTP requests concurrently and ensure one failure doesn't block the other.
4.  **Auth Token Check**: Compare `req.body.AuthToken` with `process.env.CAMS_AUTH_TOKEN`. Log unauthorized requests and skip forwarding.
5.  **Payload Cleansing**: Delete `AuthToken` from the payload body before sending it to the targets (e.g. `const { AuthToken, ...cleanedBody } = req.body;`).
6.  **Robust Error Logging**: Wrap each fetch/request in a try-catch block and log failures indicating the exact ERP system and error message.
