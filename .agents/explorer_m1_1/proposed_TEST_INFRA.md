# E2E Test Suite Design (TEST_INFRA.md Proposal)

## Overview
This document describes the design of the End-to-End (E2E) Test Suite for the Node.js Webhook Splitter API. The E2E tests are designed to verify the correctness of the API under all functional scenarios, including normal operations, authentication, cleaning, concurrency, and error conditions, without requiring external network connections.

To ensure compatibility with environment constraints (such as `CODE_ONLY` network mode, which prevents downloading packages via npm), the test suite is built entirely using **Node.js built-in modules** (`http`, `assert`, `child_process`, `fs`). It requires zero external dependencies.

---

## Test Architecture
The test suite consists of the following components run within a single test execution cycle:
1. **Mock Target Servers**: Two mock HTTP servers started on distinct ports to simulate:
   - **BGC Sixorbit** (listening on `localhost:8001`)
   - **SEMPL ERPNext** (listening on `localhost:8002`)
   The mock servers can be dynamically configured in each test case to introduce artificial latency (delay), return specific HTTP status codes (e.g., `500 Internal Server Error`), or drop connections. They also log all incoming headers and request payloads to verify correct forwarding.
2. **Splitter Server Process**: The actual `server.js` is spawned as a child process. It is configured via environment variables to target the mock servers.
3. **Test Runner**: A sequential async runner that sends HTTP requests to the Splitter API, asserts the immediate response performance, verifies mock target invocations, and parses the Splitter API's stdout/stderr logs.

```
           +-----------------------+
           |      Test Runner      |
           +-----------------------+
             /                  \
            / (POST Webhook)     \ (Asserts & Controls)
           v                      v
  +------------------+     +----------------------+
  | Splitter Server  | --> | Mock BGC Server      | (Port 8001)
  | (server.js)      |     +----------------------+
  | (Port 3000)      | --> | Mock SEMPL Server    | (Port 8002)
  +------------------+     +----------------------+
```

---

## Configuration & Environment Variables
The test script runs the Splitter Server with the following environment configuration:
- `PORT=3000`
- `CAMS_AUTH_TOKEN=cams_secret_token_123`
- `BGC_SIXORBIT_URL=http://localhost:8001/sixorbit`
- `BGC_SIXORBIT_TOKEN=bgc_token_abc`
- `SEMPL_ERPNEXT_URL=http://localhost:8002/erpnext`
- `SEMPL_ERPNEXT_API_KEY=sempl_key_xyz`
- `SEMPL_ERPNEXT_API_SECRET=sempl_secret_uvw`

---

## E2E Test Cases (Tiers 1-4)

### Tier 1: Basic Endpoint & Immediate Response
Ensures the endpoint is operational, responds immediately (< 50ms), and denies unauthorized requests without forwarding them.
* **Test Case 1.1: Unauthorized Access (Invalid Token)**
  - Request: `POST /webhook/cams` with payload containing `"AuthToken": "wrong_token"`.
  - Assertions:
    - Splitter responds with HTTP 200 and body `{"status": "done"}` in < 50ms.
    - Mock servers receive `0` requests.
    - Console logs contain an unauthorized access warning.
* **Test Case 1.2: Unauthorized Access (Missing Token)**
  - Request: `POST /webhook/cams` with payload containing no `"AuthToken"` field.
  - Assertions:
    - Splitter responds with HTTP 200 and body `{"status": "done"}` in < 50ms.
    - Mock servers receive `0` requests.
    - Console logs contain an unauthorized access warning.

### Tier 2: Request Validation, Authentication, & Payload Cleansing
Verifies that valid requests trigger payload modification.
* **Test Case 2.1: Authorized Request Cleaning**
  - Request: `POST /webhook/cams` with payload containing `"AuthToken": "cams_secret_token_123"` and `"data": { "metric": "test" }`.
  - Assertions:
    - Splitter responds with HTTP 200 and body `{"status": "done"}` in < 50ms.
    - Forwards to both mock targets.
    - In both forwarded requests, the `"AuthToken"` field is stripped from the request body.

### Tier 3: Concurrent Forwarding with Correct Headers
Checks header configuration and concurrency of the targets.
* **Test Case 3.1: Forwarding Headers Validation**
  - Request: Same as 2.1.
  - Assertions:
    - BGC Sixorbit mock receives request with header `Authorization: Bearer bgc_token_abc`.
    - SEMPL ERPNext mock receives request with header `Authorization: token sempl_key_xyz:sempl_secret_uvw`.
    - Both requests contain `Content-Type: application/json`.
* **Test Case 3.2: Concurrent Target Execution**
  - Verify that the forwarding starts asynchronously and concurrently using `Promise.allSettled` to make requests in parallel.

### Tier 4: Concurrency Isolation & Resilient Error Handling
Ensures target server delays or failures do not block each other or crash the splitter.
* **Test Case 4.1: Slow Target Non-Blocking Execution**
  - Configure Mock BGC to delay response by `1000ms`. Keep Mock SEMPL fast (`0ms` delay).
  - Request: Valid authorized webhook.
  - Assertions:
    - Splitter responds immediately (< 50ms).
    - Mock SEMPL receives and processes the payload immediately.
    - Mock BGC receives and processes the payload after `1000ms`.
    - Total client round-trip is not delayed.
* **Test Case 4.2: Target Failure Resilience & Error Logging**
  - Configure Mock BGC to return HTTP `500 Internal Server Error` (or simulate offline/connection reset). Keep Mock SEMPL responding normally.
  - Request: Valid authorized webhook.
  - Assertions:
    - Splitter responds immediately (< 50ms).
    - Mock SEMPL receives and processes the payload.
    - Splitter logs the BGC failure including the specific error/status code.
    - Splitter logs the SEMPL success.
    - Splitter remains alive for subsequent requests.

---

## Log Verification Strategy
The test runner captures stdout and stderr of the Splitter server child process. It scans the accumulated logs to verify that:
1. Unauthorized attempts log the request IP and the invalid token.
2. Successful forwarding events log: `[BGC Sixorbit] Forward success` or similar.
3. Failed forwarding events log: `[SEMPL ERPNext] Forward failed: <error_message_or_status>` or similar.
This verifies the requirement for resilient logging (R4).
