# Security and Functionality Review

Date: 2026-06-13

## Result

Repository-wide review completed for all runtime, configuration, test, and documentation files.

- Security findings fixed: 2
- Open exploitable findings: 0
- Residual operational risks: 1
- Functionality test execution: blocked because `node` and `npm` are not installed or available on PATH

## Fixed Findings

### SEC-001: Unsupported target URL protocols were accepted

**Severity:** Medium

`server.js` parsed configured target URLs but treated every non-HTTPS protocol as HTTP. A configuration such as `ftp://host/path` could therefore be silently misrouted rather than rejected.

**Fix:** `forwardRequest` now rejects every protocol except `http:` and `https:`.

### SEC-002: ERP forwarding could occur without target credentials

**Severity:** Medium

When a target URL was configured but its credential was missing, the service forwarded biometric payloads without an `Authorization` header.

**Fix:** Each target is now skipped unless its complete URL and credential set is configured. The skipped forward is logged as an error.

## Residual Risk

### REL-001: Acknowledged events are not durably queued

The required immediate `200 OK` response is sent before forwarding completes. If the process exits after acknowledgment but before delivery, that webhook event is lost. For delivery guarantees, place a durable queue between acknowledgment and ERP forwarding.

## Reviewed Surfaces

| Surface | Disposition |
|---|---|
| Webhook authentication and token removal | No finding |
| Request parsing and 1 MB body limit | No finding |
| Outbound protocol selection | Fixed, SEC-001 |
| Outbound target credentials | Fixed, SEC-002 |
| Outbound timeout and response-size limit | No finding |
| Error and unauthorized-attempt logging | No finding |
| Secret files and `.gitignore` | No finding |
| Test-process spawning | Test-only, not applicable |
| Documentation | Not applicable |

## Functionality Assessment

Static review confirms the implementation retains:

- `POST /webhook/cams`
- Exact successful acknowledgment body `{"status":"done"}`
- Rejection of unauthorized forwarding
- Top-level `AuthToken` removal
- Concurrent forwarding through `Promise.allSettled`
- Per-target success and failure logging
- 10-second outbound timeout
- 1 MB inbound and outbound body limits

The supplied tests could not be executed in this environment because both `node` and `npm` returned `command not found`.

