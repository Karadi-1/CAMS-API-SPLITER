# E2E Test Suite Design (TEST_INFRA.md)

This document proposes the architecture and design of the End-to-End (E2E) verification test suite for the Node.js Webhook Splitter API.

## 1. Overview & Goals
The objective is to verify that the Webhook Splitter API correctly accepts biometric gateway requests, authenticates them, returns an immediate response, strips authorization fields, and forwards the cleaned payload concurrently to BGC Sixorbit and SEMPL ERPNext, while handling target service failures gracefully.

To satisfy the **CODE_ONLY network mode** constraint, the test suite is designed with **zero external dependencies**, utilizing only Node.js built-in modules (`node:http`, `node:assert`, `node:child_process`, `node:test`). This makes the test suite completely self-contained, offline-compatible, and extremely fast.

---

## 2. Test Architecture

The E2E test suite operates by setting up a local sandboxed environment containing:
1. **Splitter Server Process**: The actual application `server.js` run as a child process.
2. **Mock BGC Sixorbit Server**: A local HTTP server listening on a mock port (e.g., `3001`).
3. **Mock SEMPL ERPNext Server**: A local HTTP server listening on a mock port (e.g., `3002`).
4. **Test Runner**: A script that sends test payloads to the Splitter Server, manipulates the behavior of the Mock target servers, and asserts the correctness of responses, headers, forward payloads, and logs.

```
                           +------------------------+
                           |      Test Runner       |
                           +-----+------------+-----+
                                 |            |
                1. POST Webhook  |            | 4. Assert requests
                (with AuthToken) |            |    received & logs
                                 v            v
                       +---------+----+  +----+--------------+
                       |   Splitter   |  | Mock Target       |
                       |  Server API  |  | Servers           |
                       | (port 3000)  |  | (ports 3001/3002) |
                       +---------+----+  +----+--------------+
                                 |            ^
                                 |            |
                                 +------------+
                               2. Async Forward
                               (AuthToken stripped,
                                target auth headers)
```

---

## 3. Tier 1-4 Test Suite Case Mapping

The test suite systematically covers all requirements across four validation tiers:

### Tier 1: Immediate Acknowledgment and Authentication Check
*   **Case 1.1: Valid Request Acknowledgment**
    *   *Input*: POST request with valid `AuthToken`.
    *   *Assertion*: Returns HTTP 200 OK with body `{"status": "done"}` immediately (< 50ms), before target forwards resolve.
*   **Case 1.2: Invalid Token Handling**
    *   *Input*: POST request with incorrect `AuthToken`.
    *   *Assertion*: Returns HTTP 200 OK with body `{"status": "done"}` immediately (< 50ms). No payloads are forwarded to target servers.
*   **Case 1.3: Missing Token Handling**
    *   *Input*: POST request without `AuthToken`.
    *   *Assertion*: Returns HTTP 200 OK with body `{"status": "done"}` immediately. No payloads are forwarded to target servers.

### Tier 2: Payload Cleaning and Headers Verification
*   **Case 2.1: Target Forward Payload Integrity**
    *   *Assertion*: Target servers receive the identical `data` structure sent by the client.
*   **Case 2.2: AuthToken Redaction**
    *   *Assertion*: The `AuthToken` field is successfully stripped from the body forwarded to both target servers.
*   **Case 2.3: BGC Sixorbit Authentication Headers**
    *   *Assertion*: BGC Sixorbit mock server receives the header `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`.
*   **Case 2.4: SEMPL ERPNext Authentication Headers**
    *   *Assertion*: SEMPL ERPNext mock server receives the header `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`.

### Tier 3: Concurrency and Resiliency (Non-blocking Delivery)
*   **Case 3.1: Asynchronous Concurrency**
    *   *Setup*: BGC Sixorbit mock server is configured with a 100ms response delay. SEMPL ERPNext responds instantly.
    *   *Assertion*: SEMPL ERPNext receives and processes the request immediately without waiting for BGC Sixorbit's delay.
*   **Case 3.2: Single-Target Offline Resilience (BGC Offline)**
    *   *Setup*: BGC Sixorbit mock server is offline/unresponsive (simulating socket connection reset/destroy). SEMPL ERPNext is online.
    *   *Assertion*: SEMPL ERPNext successfully receives the forward. The Splitter does not crash.
*   **Case 3.3: Single-Target Offline Resilience (SEMPL Offline)**
    *   *Setup*: SEMPL ERPNext mock server is offline/unresponsive. BGC Sixorbit is online.
    *   *Assertion*: BGC Sixorbit successfully receives the forward. The Splitter does not crash.
*   **Case 3.4: All-Targets Offline Resilience**
    *   *Setup*: Both target servers are offline/unresponsive.
    *   *Assertion*: The Splitter still responds with 200 OK immediately and handles the forward failures without crashing.

### Tier 4: Resiliency, Logging, and Error Handling
*   **Case 4.1: Success Logging**
    *   *Assertion*: On successful forwarding, the Splitter logs a message containing the target name (e.g. `BGC Sixorbit` and `SEMPL ERPNext`).
*   **Case 4.2: Failure Logging**
    *   *Assertion*: On forwarding failures, the Splitter logs target failures with the target name and the specific error message/status code.
*   **Case 4.3: DNS/Network Exception Handling**
    *   *Setup*: Splitter is configured with invalid/malformed target URLs.
    *   *Assertion*: Splitter process handles the DNS or connection errors asynchronously, logs the failures, and does not crash.

---

## 4. Execution Workflow

To run the verification test suite:
1.  **Configure environment variables**: Setup target mock ports and auth credentials.
2.  **Start Mock Servers**: Listen on ports `3001` and `3002`.
3.  **Spawn Splitter API**: Executed as a background process with stdout/stderr piped to capture log outputs.
4.  **Execute Assertions**: The client makes HTTP calls for each test case, modifies mock server behaviors, and performs validations.
5.  **Shutdown**: Cleanly terminate the Splitter server process and close the mock server ports to prevent resource leaks.
