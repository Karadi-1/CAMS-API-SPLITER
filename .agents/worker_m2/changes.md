# Changes Document - Milestone 2 & 3 Implementation

## Files Modified / Created
- `server.js` (Created in project root)

## Implementation Details

### Architecture
The Webhook Splitter API (`server.js`) is implemented as a lightweight middleware using Node.js built-in `http` and `https` modules. This design guarantees zero external dependencies, 100% offline compatibility, and zero-setup execution.

### Key Components

1. **HTTP Server Listener**:
   - Listens on `PORT` (defaults to `3000` or configured port via environment variable, e.g., `13000` for testing).
   - Only accepts HTTP `POST` requests targeted at `/webhook/cams`.
   - Rejects other paths or methods with a `404 Not Found` response.

2. **JSON Parsing & Validation**:
   - Stream-reads the incoming request body using standard `req.on('data')` and `req.on('end')` events.
   - Parses the request body as JSON within a `try-catch` block.
   - If parsing fails, logs the error, bypasses forwarding, and returns `200 OK` with `{"status": "done"}` (as required by resiliency guidelines).

3. **Authentication Check**:
   - Matches the `AuthToken` from the payload against the `CAMS_AUTH_TOKEN` environment variable.
   - If authentication fails, logs the attempt, returns `200 OK` with `{"status": "done"}`, and does not forward the payload.

4. **Immediate Acknowledgment**:
   - Responds to the client with `200 OK` and `{"status": "done"}` immediately after parsing and auth check, before commencing any downstream forwarding. This ensures the response is delivered in < 50ms, meeting the SLA.

5. **Concurrent Forwarding**:
   - Cleans the payload by stripping the `AuthToken` field.
   - Prepares headers for both downstream systems:
     - **BGC Sixorbit**: Sets `Authorization: Bearer <BGC_SIXORBIT_TOKEN>` if configured.
     - **SEMPL ERPNext**: Sets `Authorization: token <SEMPL_ERPNEXT_API_KEY>:<SEMPL_ERPNEXT_API_SECRET>` if configured.
   - Uses `Promise.allSettled` to concurrently forward the payload to all configured target systems.
   - Includes a request timeout of 10 seconds for each target connection.
   - Logs success or failure status for each target downstream system, ensuring that if one target is slow, offline, or returns an error (500), it does not impact other targets or crash the splitter server.
