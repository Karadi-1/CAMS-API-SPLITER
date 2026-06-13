# Original User Request

## Initial Request — 2026-06-13T07:55:33Z

A production-ready Node.js Webhook Splitter API that acts as a middleware between the Camsunit Biometric Gateway and two ERP systems: Sixorbit (BGC) and Frappe ERPNext (SEMPL).

Working directory: /Users/sunitj/Library/CloudStorage/OneDrive-Personal/Documents OD/WORK/Files/BGC/IT/CAMS API SPLITER
Integrity mode: development

## Requirements

### R1. Webhook Endpoint and Immediate Acknowledgment
Create a `POST /webhook/cams` route in `server.js`.
- It must parse JSON payloads.
- It must immediately return a `200 OK` status with the exact JSON body `{"status": "done"}`.
- This response must be sent before starting or waiting for the forwarding operations to finish.

### R2. Webhook Authentication
- Inspect the incoming payload for the `AuthToken` field.
- Compare it against the `CAMS_AUTH_TOKEN` environment variable.
- If it does not match, log the unauthorized attempt but still immediately return `200 OK` with `{"status": "done"}`. Do NOT forward unauthorized payloads to the ERP systems.

### R3. Payload Cleaning and Concurrent Forwarding
If the request is authorized, strip the `AuthToken` field from the body. Then forward the remaining payload concurrently to both systems:
- **Sixorbit (BGC)**: Post to `BGC_SIXORBIT_URL` using header `Authorization: Bearer <BGC_SIXORBIT_TOKEN>`.
- **Frappe ERPNext (SEMPL)**: Post to `SEMPL_ERPNEXT_URL` using header `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>`.
Forwarding must occur asynchronously using `Promise.allSettled`. Ensure a failure or slow response from one ERP system does not delay or prevent forwarding to the other.

### R4. Resiliency and Logging
- Log successful forwards with the ERP system name.
- Log failures with the ERP system name and the specific error message or status code.
- Ensure the server is robust against network timeouts, DNS resolution failures, and connection resets.

## Acceptance Criteria

### API Response & Performance
- [ ] `POST /webhook/cams` is functional.
- [ ] Normal response times for acknowledging incoming requests are under 50ms.
- [ ] Requests without or with incorrect `AuthToken` receive `200 OK` with `{"status": "done"}` and are not forwarded.

### Authentication & Forwarding Verification
- [ ] Forwarded payloads to BGC Sixorbit contain the header `Authorization: Bearer <token_value>`.
- [ ] Forwarded payloads to SEMPL Frappe ERPNext contain the header `Authorization: token <api_key>:<api_secret>`.
- [ ] The `AuthToken` field is successfully stripped from the body forwarded to both ERPs.
- [ ] One offline/unresponsive ERP system does not block, delay, or prevent delivery to the other.

### Verification Script
- [ ] A verification/test script `test_splitter.js` exists in the codebase (e.g. in a `test/` directory or root).
- [ ] Running the test script validates the immediate response, payload stripping, header authentication, and concurrency requirements by running mock target servers.
