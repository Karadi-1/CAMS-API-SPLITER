# Project: Node.js Webhook Splitter API

## Architecture
- Incoming webhook is parsed at `POST /webhook/cams`.
- Checks `AuthToken` from body against `CAMS_AUTH_TOKEN` environment variable.
- Responds immediately with `{"status": "done"}` (status 200) without blocking on forwarding.
- Cleans payload: strips `AuthToken` field.
- Forwards concurrently via `Promise.allSettled` using HTTP POST requests:
  - BGC Sixorbit: `BGC_SIXORBIT_URL` with header `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`.
  - SEMPL ERPNext: `SEMPL_ERPNEXT_URL` with header `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`.
- Logs success/failure of forwarding asynchronously.
- Robust error handling for network timeouts, DNS errors, etc.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | E2E Test Suite Design | Establish test infra, mock servers, write `test_splitter.js` with Tier 1-4 cases | None | DONE |
| 2 | Basic Server & Auth Setup | Create `server.js`, route `POST /webhook/cams`, validate `AuthToken`, clean payload, immediate response | M1 | DONE |
| 3 | Concurrent Forwarding & Logging | Integrate async forwarding using `Promise.allSettled`, authorization headers, resilient logging | M2 | DONE |
| 4 | Verification & Hardening | Run verification test suite, run Challenger/Auditor checks, address gaps | M3 | DONE |

## Interface Contracts
### Webhook Input Formats
- Headers: `Content-Type: application/json`
- Body:
  ```json
  {
    "AuthToken": "your_cams_auth_token",
    "data": { ... }
  }
  ```

### Target Forwarding Contracts
- **BGC Sixorbit**:
  - URL: `BGC_SIXORBIT_URL` (POST)
  - Headers:
    - `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`
    - `Content-Type: application/json`
  - Body: same as input but without `AuthToken`.
- **SEMPL ERPNext**:
  - URL: `SEMPL_ERPNEXT_URL` (POST)
  - Headers:
    - `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`
    - `Content-Type: application/json`
  - Body: same as input but without `AuthToken`.

## Code Layout
- `server.js`: Webhook splitter server application.
- `package.json`: Project manifest (dependencies like express, axios/undici).
- `test_splitter.js` or `test/test_splitter.js`: Verification test script.
