# Daemon errors

## HTTP responses

`sendInternalError` in `apps/daemon/src/http/api-errors.ts` logs the full cause
server-side and returns `{ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } }`
with HTTP 500. Route catches use this helper for unexpected failures. Existing
validation and domain error codes keep their own status and message. OAuth terminal
launch and external-browser failures also retain `ok: false`.

The helper maps typed provider HTTP errors with status 401/403 and key errors to `PROVIDER_AUTH_REJECTED`,
`PROVIDER_CREDENTIAL_MISSING`, or `PROVIDER_CREDENTIAL_UNREADABLE` and builds safe
messages from recognised provider identities. It also preserves the KIE adapter's
fixed credential-validation messages, including `PROVIDER_CREDENTIAL_INVALID`.
Upstream response detail and key-store causes stay in daemon logs. Unrecognised
errors return the generic internal-error message.
Web and CLI readers accept typed errors and legacy strings. Plugin sharing adapts
both into its existing `{ ok, message, code, log }` UI result. Skill CLI failures
keep a string `error` and expose the typed `code` in JSON output.

The final Express error middleware returns contract errors for malformed JSON
(400), oversized bodies (413), unsupported body encodings (415), incomplete
bodies (400), and rejected body verification (403). Other errors with integer
`status` or `statusCode` values in the 4xx range retain that HTTP status and use a
safe message; range failures use `RANGE_NOT_SATISFIABLE` (416). Unknown errors return
a safe 500. Route-local body policies run before this final handler.

Project plugin-folder validation errors return 400 `BAD_REQUEST`. Missing folders
return 404 `PLUGIN_FOLDER_NOT_FOUND`. Unexpected disk or database failures return
500 `INTERNAL_ERROR`. A spawn `ENOENT` returns 500 `EXECUTABLE_NOT_FOUND`,
so a missing executable does not appear as a missing plugin folder.

### Directory certainty

`POST /api/dir-exists` returns `{ exists: true }` or `{ exists: false }` when
it can verify the folder. A probe deadline returns
`{ exists: null, status: 'unknown', reason: 'timeout' }`; other unavailable
probes use `reason: 'unavailable'`. The web preserves unknown as cannot-verify.
Home submission, the working-folder warning, and the reference-project picker
block or hide only a confirmed missing folder. These probes do not replace
server-side access checks.

### SSE backpressure

The daemon sends SSE frames in transport chunks of at most 64 KiB. It preserves
frame bytes and event order across drain events, including replay before live
events and pending frames before stream end. Backpressure pauses writes until
drain; a stream closes when its backlog exceeds a byte cap.

The daemon retains at most one 32 MiB frame, a 1 MiB live-event queue, and a
1 MiB Node transport buffer per stream. It closes the stream if a frame or
buffer would exceed its cap. Stream closure releases queued frames, replay,
and heartbeat timers.

A clock-only drain deadline cannot distinguish a stalled reader from a client
still receiving bytes held in the kernel send buffer. The daemon therefore
keeps a finite pending transfer connected within its byte caps until it drains
or the connection closes. An idle reader can retain that bounded transfer;
continued events close its stream when the live queue fills.

## Origin configuration

`OD_ALLOWED_ORIGINS` accepts comma-separated HTTP or HTTPS URLs and normalizes
them to origins. Empty entries are ignored. Invalid entries fail startup with
the variable name, offending entry, and reason. This preserves the existing
fail-fast policy: the daemon does not start with a partially accepted allowlist.

## Shutdown

`apps/daemon/src/services/daemon-shutdown.ts` attempts each service drain even if
an earlier drain fails. Any failed drain, including analytics, forfeits the
clean-stop seal. Background maintenance and terminal delivery still drain before
placement releases ownership. Successful drains retain the existing sealing
checks. The HTTP server's
close handler logs rejected shutdown, runs background cleanup, and sets a
nonzero process exit code. Runtime and CLI shutdown wrappers preserve that code.

## Guard

`pnpm guard` blocks direct HTTP 500 JSON responses containing `error: String(...)`
in daemon source, including calls split across lines. Other legacy response
forms remain outside this check.
