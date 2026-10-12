/**
 * A minimal MCP-over-HTTP client for the user's configured MotionSites endpoint —
 * design doc §1, §4. The daemon has no existing outbound MCP *client* to reuse:
 * `apps/daemon/src/mcp.ts` is the daemon's own MCP *server* (stdio, exposing Mishh Mashh's tools
 * to other agents — the opposite direction), and `mcp-config.ts`/`mcp-oauth.ts`/`mcp-tokens.ts` own
 * external-MCP-server config/OAuth/tokens but hand the resulting Bearer token to an *agent's own*
 * MCP client (Claude Code's `.mcp.json`) rather than calling tools from the daemon process itself.
 *
 * "Minimal" on purpose: one JSON-RPC 2.0 `initialize` handshake, the `notifications/initialized`
 * notification, then a single `tools/call` — no resumable-stream/reconnection machinery, since the
 * daemon opens one short-lived connection per catalog/build-start call and never keeps a session
 * alive between requests (matching the "fetch transiently, never cache" posture the design doc
 * requires for prompt bodies). Handles both response shapes the MCP streamable-HTTP transport
 * allows: a single `application/json` body, and a `text/event-stream` body (the first `data:`
 * event's JSON-RPC message — sufficient for a request that gets exactly one response, which is
 * every tool call this bridge makes).
 */

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpHttpTransportError extends Error {
  /** HTTP status of a non-2xx answer; absent for network, abort and protocol failures. */
  readonly status: number | undefined;
  /** Parsed `Retry-After` seconds of a non-2xx answer, when the upstream sent one. */
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, options?: { cause?: unknown; status?: number; retryAfterSeconds?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpHttpTransportError';
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function isJsonRpcFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response;
}

/** One tool call's outcome. `isError` mirrors the MCP `CallToolResult.isError` field — a tool-level
 * denial (e.g. "sign in required", "premium prompt") that the upstream still answered with HTTP
 * 200, distinct from `McpHttpTransportError` (thrown, never returned) for a transport-level
 * failure. `data` is the tool's `structuredContent` when the server provided one, else `undefined`
 * — callers fall back to parsing `text` as JSON when they need structured data and `data` is
 * absent. */
export interface MotionSitesToolCallResult {
  isError: boolean;
  text: string;
  data: unknown;
  /** Present only when this call froze its selected schema from tools/list. */
  schemaDigest?: string;
}

async function postJsonRpc(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  body: JsonRpcRequest,
  sessionId: string | undefined,
  configuredHeaders: Record<string, string> | undefined,
): Promise<{ response: JsonRpcResponse | null; sessionId: string | undefined }> {
  let headers: Headers;
  try {
    headers = new Headers(configuredHeaders);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    // Match the existing external-MCP transport: a non-empty pinned Authorization wins.
    // With neither a pinned header nor a token, send no Authorization header at all;
    // a no-auth server must never receive an empty `Bearer ` credential.
    if (!headers.get('authorization')?.trim()) {
      if (accessToken.trim()) headers.set('authorization', `Bearer ${accessToken}`);
      else headers.delete('authorization');
    }
    headers.set('mcp-protocol-version', MCP_PROTOCOL_VERSION);
    if (sessionId) headers.set('mcp-session-id', sessionId);
  } catch {
    // Headers' TypeError can contain private names/values. Never expose it, even as a cause.
    throw new McpHttpTransportError('Configured MotionSites headers are not valid HTTP headers');
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new McpHttpTransportError(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const nextSessionId = res.headers.get('mcp-session-id') ?? sessionId;
  if (!res.ok) {
    const detail = await safeText(res);
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    throw new McpHttpTransportError(`${url} answered HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`, {
      status: res.status, ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }
  // A notification (no `id` in the request) gets no JSON-RPC response body — 202 Accepted with an
  // empty body is the documented shape.
  if (body.id === undefined) return { response: null, sessionId: nextSessionId };

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const parsed = await parseFirstSseJsonRpcMessage(res);
    return { response: parsed, sessionId: nextSessionId };
  }
  const raw = await safeText(res);
  try {
    return { response: JSON.parse(raw) as JsonRpcResponse, sessionId: nextSessionId };
  } catch (err) {
    throw new McpHttpTransportError(`${url} returned a response that could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reads only far enough to get the first `data:` SSE event's JSON-RPC message — every call this
 * client makes expects exactly one response message per request. */
async function parseFirstSseJsonRpcMessage(res: Response): Promise<JsonRpcResponse> {
  const raw = await safeText(res);
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload) continue;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch (err) {
      throw new McpHttpTransportError(`could not parse SSE data line as JSON-RPC: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new McpHttpTransportError('event-stream response carried no data: line');
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

let nextRequestId = 1;

/**
 * Performs the `initialize` → `notifications/initialized` → `tools/call` sequence against
 * `opts.url` and returns the one tool call's result. Throws `McpHttpTransportError` for any
 * transport/protocol-level failure (network error, non-2xx, malformed JSON-RPC, a JSON-RPC
 * `error` object). A tool-level denial is NOT thrown — it comes back as `{ isError: true, ... }`,
 * matching the MCP `CallToolResult.isError` contract, so a caller can distinguish "the endpoint is
 * broken" from "the endpoint answered normally and said no."
 */
export async function callMotionSitesTool(
  opts: { url: string; accessToken: string; fetchImpl: typeof fetch; headers?: Record<string, string>; freezeSchema?: (catalog: unknown, name: string, args: Record<string, unknown>) => string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<MotionSitesToolCallResult> {
  const freeze = opts.freezeSchema;
  const { result, schemaDigest } = await requestMotionSitesMcp(
    opts,
    'tools/call',
    { name: toolName, arguments: args },
    freeze ? (catalog) => freeze(catalog, toolName, args) : undefined,
  );
  return { ...extractToolCallResult(result), ...(schemaDigest ? { schemaDigest } : {}) };
}

/** Reuses the authorized HTTP handshake for a cheap connection-only tools/list check. */
export async function listMotionSitesTools(opts: { url: string; accessToken: string; fetchImpl: typeof fetch; headers?: Record<string, string> }): Promise<void> {
  const { result } = await requestMotionSitesMcp(opts, 'tools/list', {});
  if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) throw new McpHttpTransportError('Invalid tools list');
}

async function requestMotionSitesMcp(
  opts: { url: string; accessToken: string; fetchImpl: typeof fetch; headers?: Record<string, string> },
  method: string,
  params: Record<string, unknown>,
  freezeSchema?: (catalog: unknown) => string,
): Promise<{ result: unknown; schemaDigest?: string }> {
  const { url, accessToken, fetchImpl } = opts;

  const init = await postJsonRpc(url, accessToken, fetchImpl, {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mishh-mashh-daemon', version: '1' },
    },
  }, undefined, opts.headers);
  if (!init.response) throw new McpHttpTransportError('initialize returned no response');
  if (isJsonRpcFailure(init.response)) {
    throw new McpHttpTransportError(`initialize failed: ${init.response.error.message}`);
  }

  // Fire-and-forget per the MCP spec — no response body is expected for a notification.
  await postJsonRpc(url, accessToken, fetchImpl, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId, opts.headers);

  let schemaDigest: string | undefined;
  let sessionId = init.sessionId;
  if (freezeSchema) {
    const listed = await postJsonRpc(url, accessToken, fetchImpl, { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/list', params: {} }, sessionId, opts.headers);
    if (!listed.response || isJsonRpcFailure(listed.response)) throw new McpHttpTransportError('tools/list failed');
    schemaDigest = freezeSchema(listed.response.result);
    sessionId = listed.sessionId;
  }

  const call = await postJsonRpc(url, accessToken, fetchImpl, {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method, params,
  }, sessionId, opts.headers);
  if (!call.response) throw new McpHttpTransportError('MCP request returned no response');
  if (isJsonRpcFailure(call.response)) {
    throw new McpHttpTransportError(`${method} failed: ${call.response.error.message}`);
  }

  return { result: call.response.result, ...(schemaDigest ? { schemaDigest } : {}) };
}

function extractToolCallResult(result: unknown): MotionSitesToolCallResult {
  if (typeof result !== 'object' || result === null) {
    throw new McpHttpTransportError('tools/call result was not an object');
  }
  const r = result as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  const textBlock = Array.isArray(r.content) ? r.content.find((block) => block?.type === 'text' && typeof block.text === 'string') : undefined;
  return {
    isError: r.isError === true,
    text: textBlock?.text ?? '',
    data: r.structuredContent,
  };
}
