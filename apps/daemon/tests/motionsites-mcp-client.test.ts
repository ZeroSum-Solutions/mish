// Protocol-level coverage for the minimal MotionSites MCP-over-HTTP client
// (src/motionsites/mcp-client.ts). Every test here uses a fake `fetch` — no real network call is
// made, matching the phase-C proof requirement ("fully mocked MCP tests (no network)").

import { describe, expect, it, vi } from 'vitest';
import { callMotionSitesTool, listMotionSitesTools, McpHttpTransportError } from '../src/motionsites/mcp-client.js';

const URL_ = 'https://motionsites.example/mcp';

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: { jsonrpc: string; id?: number; method: string; params?: unknown };
}

/** Builds a fake `fetch` that answers `initialize` → 200 JSON (assigning a session id header),
 * `notifications/initialized` → 202 empty, then `tools/call` → whatever `toolsCallResponse`
 * produces. Records every request for assertions. */
function fakeFetch(
  toolsCallResponse: (req: RecordedRequest) => { status: number; contentType: string; body: string },
) {
  const requests: RecordedRequest[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ url: String(url), headers, body });

    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'motionsites', version: '1' } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session-1' } },
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (body.method === 'tools/call') {
      const { status, contentType, body: respBody } = toolsCallResponse({ url: String(url), headers, body });
      return new Response(respBody, { status, headers: { 'content-type': contentType } });
    }
    throw new Error(`unexpected method ${body.method}`);
  });
  return { fetchImpl: fn as unknown as typeof fetch, requests };
}

describe('callMotionSitesTool', () => {
  it('performs initialize -> notifications/initialized -> tools/call, carrying the session id and bearer token throughout', async () => {
    const { fetchImpl, requests } = fakeFetch((req) => {
      expect(req.headers['mcp-session-id']).toBe('fixture-session-1');
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: { isError: false, structuredContent: { results: [] } } }),
      };
    });

    const result = await callMotionSitesTool({ url: URL_, accessToken: 'fixture-token-abc', fetchImpl }, 'list_prompts', { limit: 3 });

    expect(result).toEqual({ isError: false, text: '', data: { results: [] } });
    expect(requests.map((r) => r.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    for (const req of requests) expect(req.headers.authorization).toBe('Bearer fixture-token-abc');
    expect(requests[2]!.body.params).toEqual({ name: 'list_prompts', arguments: { limit: 3 } });
  });

  it('parses a structuredContent-less text-block result and falls back to it as `text`', async () => {
    const { fetchImpl } = fakeFetch((req) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: { isError: false, content: [{ type: 'text', text: '{"id":"x"}' }] } }),
    }));
    const result = await callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'get_prompt', { id: 'x' });
    expect(result).toEqual({ isError: false, text: '{"id":"x"}', data: undefined });
  });

  it('parses a text/event-stream response (first data: line)', async () => {
    const { fetchImpl } = fakeFetch((req) => ({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: { isError: false, structuredContent: { ok: true } } })}\n\n`,
    }));
    const result = await callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'list_prompts', {});
    expect(result).toEqual({ isError: false, text: '', data: { ok: true } });
  });

  it('returns isError: true (not thrown) with the tool\'s own denial text, for a normal HTTP 200 tool-level denial', async () => {
    const { fetchImpl } = fakeFetch((req) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: req.body.id,
        result: { isError: true, content: [{ type: 'text', text: 'This prompt requires a premium plan.' }] },
      }),
    }));
    const result = await callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'get_prompt', { id: 'p1' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('This prompt requires a premium plan.');
  });

  it('throws McpHttpTransportError on a non-2xx HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
    await expect(callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'list_prompts', {})).rejects.toThrow(McpHttpTransportError);
  });

  it('throws McpHttpTransportError on a JSON-RPC error object', async () => {
    const { fetchImpl } = fakeFetch((req) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: req.body.id, error: { code: -32000, message: 'boom' } }),
    }));
    await expect(callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'list_prompts', {})).rejects.toThrow(/boom/);
  });

  it('throws McpHttpTransportError when fetch itself rejects (network error)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(callMotionSitesTool({ url: URL_, accessToken: 't', fetchImpl }, 'list_prompts', {})).rejects.toThrow(McpHttpTransportError);
  });
});

describe('read-only MCP connection check', () => {
  it('reuses the handshake for tools/list and never dispatches tools/call', async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
      methods.push(body.method);
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: [] } });
    });
    await listMotionSitesTools({ url: URL_, accessToken: 'fixture-token', fetchImpl });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });
});
