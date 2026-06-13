# CAMS Webhook Splitter — Team Guide & Deployment Instructions

This document provides detailed instructions for the development, QA, and DevOps teams to set up, test, configure, and deploy the **CAMS Webhook Splitter API** middleware.

---

## 1. Overview & Architecture

Camsunit Biometric Gateway pushes real-time attendance punch logs via webhooks but allows only a single callback URL per device. This middleware acts as a high-performance, resilient router that intercepts incoming webhooks, validates credentials, instantly returns a success response, and concurrently duplicates the payload to both ERP systems:

```
                            +------------------------+
                            |   Camsunit Gateway     |
                            +-----------+------------+
                                        |
                         1. POST Webhook| 2. Immediate 200 OK Response
                         (with Token)   |    {"status": "done"} (<50ms)
                                        v
                            +-----------+------------+
                            | Webhook Splitter API   |
                            | (Node.js Keep-Alive)   |
                            +-----+------------+-----+
                                  |            |
           3a. POST Clean Body    |            | 3b. POST Clean Body
           (Bearer Authorization) |            | (Token API_KEY:SECRET)
                                  v            v
                            +-----+----+  +----+--------------+
                            | Sixorbit |  | Frappe ERPNext    |
                            | (Company |  | (Company SEMPL)   |
                            |  A - BGC)|  +-------------------+
                            +----------+
```

### Key Technical Specs:
* **Zero Dependencies**: Implemented natively using Node.js core modules (`http`, `https`, `url`, `assert`, `child_process`). Does not require `express` or `axios`, reducing security vulnerabilities and start-up latency.
* **Socket Reuse**: Persistent keep-alive connections are established via custom HTTP/HTTPS global agents to avoid TCP socket exhaustion.
* **Immediate Acknowledgment**: Flushes an HTTP `200` with `{"status": "done"}` immediately upon parsing the incoming webhook body to prevent the biometric device from triggering retries.
* **Authentication**: Incoming requests are verified using the `AuthToken` field in the JSON body. If unauthorized, the event is logged (with credentials masked to prevent log-based token exposure) and skipped from forwarding, but still returns `200 OK` to satisfy Camsunit's retry suppression logic.
* **Resiliency**: Webhooks are dispatched concurrently using `Promise.allSettled`. If one ERP server times out, goes offline, or returns a `500` error, the other ERP's delivery is unaffected.

---

## 2. File Deliverables in the Repository

Your workspace contains:
1. `server.js`: Webhook splitter server logic.
2. `package.json`: Project manifest (includes scripts for Render and local development).
3. `.env.example`: Env configuration template.
4. `.gitignore`: Ignores `.env` and local package builds.
5. `test_splitter.js`: Primary E2E test runner covering 14 core functional cases and 6 security edge cases.
6. `test_splitter_adversarial.js`: Verifies target server timeouts, connection drops, and TCP resets.
7. `test_adversarial.js`: Stress tests the middleware with large payloads, concurrent load spikes, and malformed inputs.
8. `TEST_INFRA.md` & `TEST_READY.md`: Test architecture and coverage details.

---

## 3. Configuration & Environment Variables

Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

Set the following variables:

| Variable Name | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Port the splitter API server will listen on. |
| `CAMS_AUTH_TOKEN` | Yes | - | Authentication token expected from the Camsunit portal. |
| `BGC_SIXORBIT_URL` | Yes | - | Endpoint URL for the Sixorbit (BGC) attendance route. |
| `BGC_SIXORBIT_TOKEN` | Yes | - | Bearer token for Sixorbit (`Authorization: Bearer <TOKEN>`). |
| `SEMPL_ERPNEXT_URL` | Yes | - | Endpoint URL for the Frappe ERPNext (SEMPL) route. |
| `SEMPL_ERPNEXT_API_KEY` | Yes | - | API Key for Frappe integration. |
| `SEMPL_ERPNEXT_API_SECRET`| Yes | - | API Secret for Frappe integration (`Authorization: token <KEY>:<SECRET>`). |

---

## 4. How to Run Locally

### Option A: Using Modern Node.js (Recommended)
If your team is running **Node.js 20.6.0 or higher**, you can load environment variables directly from `.env` without installing any NPM packages:
```bash
node --env-file=.env server.js
```

### Option B: Using standard script
For environments running older versions of Node.js:
1. Install dependencies (installs the optional `dotenv` library):
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```

---

## 5. Verification & Testing Guide

To verify correctness before deploying, run the test suites locally. The testing framework requires no setup, database, or external networks because it launches local mock servers on ports `13001` and `13002` to validate payloads.

### Command Execution:

1. **Standard E2E Tests (20 Test Cases)**:
   ```bash
   node test_splitter.js
   ```
   *Verifies:* Endpoint validation, correct acknowledgment, payload parsing, `AuthToken` stripping, header creation, concurrent routing, offline targets, and 1MB size caps.
   
2. **Network Resilience & TCP Reset Tests**:
   ```bash
   node test_splitter_adversarial.js
   ```
   *Verifies:* Behavior under network drops, target server hangs, socket closures, and TCP reset errors.

3. **Stress & Payload Injections**:
   ```bash
   node test_adversarial.js
   ```
   *Verifies:* High concurrency loads (50 simultaneous requests), malicious JSON formatting, and memory resilience.

---

## 6. Production Deployment Steps (Render)

This application is ready for instant deployment to cloud platforms like **Render**, **Heroku**, or **AWS ECS**. Follow these steps for Render:

1. **Create Web Service**:
   - Link your Git repository on Render.
   - Set **Runtime** to `Node`.
   - Set **Build Command** to `npm install` (optional, as the server uses core modules).
   - Set **Start Command** to `node server.js`.

2. **Configure Variables**:
   - Go to the **Environment** tab on Render.
   - Add all env variables defined in `.env.example` (e.g. `CAMS_AUTH_TOKEN`, `BGC_SIXORBIT_URL`, etc.).

3. **Scale Settings**:
   - The keep-alive agent is configured internally. Do not run behind proxies that force HTTP/1.0 connections or strip the `Keep-Alive` header.

---

## 7. Camsunit Gateway Setup

Once the API is deployed, configure the webhook in the Camsunit developer portal:

1. Set the **Callback URL** to:
   ```
   https://your-render-app-domain.com/webhook/cams
   ```
2. Define the **AuthToken** in the portal to match the `CAMS_AUTH_TOKEN` string specified in your production environment variables.

---

## 8. Log Reference & Troubleshooting

### Successful Delivery Log:
```text
Splitter server listening on port 3000
Successfully forwarded payload to BGC Sixorbit. Status code: 200
Successfully forwarded payload to SEMPL ERPNext. Status code: 200
```

### Unauthorized Request Log (Token Masked):
```text
Unauthorized access attempt. Provided token: ab...yz (length: 12)
```

### Payload Size Exceeded (HTTP 413):
The server automatically blocks payloads exceeding 1MB (to mitigate memory exhaustion DoS) and closes the socket immediately. The logs will indicate the closed connection.

### Address Conflict (`EADDRINUSE`):
If the server fails to bind because the port is occupied, it outputs:
```text
[Error] Port 3000 is already in use.
```
To fix, change the `PORT` variable in `.env` or terminate the process occupying the port.
