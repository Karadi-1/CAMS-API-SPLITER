# Analysis Report: E2E Test Suite Design

## Executive Summary
This report presents the design and proposal for the E2E Test Suite of the Node.js Webhook Splitter API, covering functional and non-functional requirements categorized across **Tiers 1 to 4**. 

Given the sandbox constraints, including the `CODE_ONLY` network mode (which blocks external internet/npm package downloads) and the user-approval requirement for shell commands, the proposed test infrastructure relies **exclusively on Node.js built-in modules** (`http`, `assert`, `child_process`). This ensures that the test runner can execute successfully in any offline environment that has Node.js installed, with zero package dependencies.

---

## 1. Environment & Workspace Exploration
- **Workspace State**: The project root is currently empty except for `.agents/` and `ORIGINAL_REQUEST.md`. Implementation files (such as `server.js` and `package.json`) will be built in subsequent milestones.
- **Node.js & npm availability**:
  - The test suite has been designed defensively to assume a standard modern Node.js environment (v18+).
  - Rather than relying on external libraries (like `jest`, `mocha`, `supertest`, or `axios`) which cannot be installed without internet access in `CODE_ONLY` network mode, the test suite uses Node.js standard libraries:
    - `http` for mock servers and sending requests.
    - `assert` for assertions.
    - `child_process.spawn` to spin up the target server.
  - This dependency-free architecture ensures immediate execution with `node test_splitter.js`.

---

## 2. Test Suite Architecture
The test suite utilizes a "Dual-Mock Concurrency" architecture:
- **Mock BGC Sixorbit Server** (Port 8001) and **Mock SEMPL ERPNext Server** (Port 8002) are launched inline within the test process.
- **Dynamic Config**: Each mock server has an in-memory configuration (`delay`, `status`) and stores received requests in arrays (`bgcRequests`, `semplRequests`). This allows each test case to control the mock server's latency/status and verify the headers and payload forwarded by the splitter.
- **Isolated Spawn**: The Splitter server (`server.js`) is spawned as a child process using `child_process.spawn`. This isolates the server environment and logs, allowing the runner to scan `stdout` and `stderr` for log messages.

---

## 3. Tiered Test Coverage
The suite covers the requirements across four distinct tiers:

| Tier | Focus | Requirement | Verification Method |
|---|---|---|---|
| **Tier 1** | Endpoint & Immediate Acknowledgment | R1 (Endpoint), R2 (Auth) | Verifies `POST /webhook/cams` returns `200 OK` + `{"status": "done"}` in **< 50ms**. Verifies unauthorized (invalid/missing token) requests receive acknowledgment but are **not** forwarded. |
| **Tier 2** | Request Validation & Cleansing | R3 (Cleaning) | Verifies the Splitter server successfully strips the `AuthToken` from the payload body before forwarding. |
| **Tier 3** | Concurrent Forwarding & Headers | R3 (Forwarding) | Verifies concurrent target requests: BGC gets `Authorization: Bearer <token>`, SEMPL gets `Authorization: token <key>:<secret>`. |
| **Tier 4** | Resilience, Isolation & Logging | R3 (Concurrency), R4 (Resilience/Logs) | Verifies that a slow target (1000ms delay) does not block the other target or delay client response. Verifies target failures (500 errors) are handled gracefully (non-crashing) and logged with specific errors. |

---

## 4. Key Proposed Files
The complete proposed designs are saved in the working directory:
1. **`proposed_TEST_INFRA.md`**: Detailed architectural specification, port allocations, environment variables, and test definitions.
2. **`proposed_test_splitter.js`**: Complete, executable Javascript code implementing the dual-mock servers, sequential async test runner, and all assertions.

---

## 5. Verification Plan
Once `server.js` is created, the E2E suite can be verified by running:
```bash
node test_splitter.js
```
The exit code will be `0` on success and `1` on failure, making it ideal for continuous integration or reviewer gates.
