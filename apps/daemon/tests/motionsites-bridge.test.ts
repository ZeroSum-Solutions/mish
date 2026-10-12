import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
// Catalog merge (src/motionsites/catalog.ts) and design-reference dispatch
// (src/motionsites/design-reference.ts). No real network — every MCP call goes through a fake
// `fetch` that answers the minimal JSON-RPC sequence mcp-client.ts drives.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setToken } from '../src/mcp-tokens.js';
import { fetchMotionSitesCatalogEntries } from '../src/motionsites/catalog.js';
import { fetchMotionSitesDesignReference } from '../src/motionsites/design-reference.js';
import { MotionSitesLoginRequiredError, MotionSitesPaidAccessRequiredError, MotionSitesUpstreamError } from '../src/motionsites/errors.js';
import { MOTIONSITES_MCP_SERVER_ID, MOTIONSITES_MCP_URL } from '../src/motionsites/config.js';
import { resetLocalCorpusCache } from '../src/motionsites/local-corpus-source.js';
import type { LocalCorpusRow } from '@mish/section-catalog/local-corpus';

const ZEROSUM_ROW: LocalCorpusRow = {
  id: 'zs-fixture-01',
  our_title: 'Fixture Trust Hero',
  title: 'Trust Hero',
  category: 'Local Presence',
  type: null,
  kind: 'section',
  slot: 'hero',
  use_case: 'local-presence',
  niche: 'generic',
  vertical: 'local-services',
  action: 'contact',
  motion_level: 'micro',
  requires_motion_review: 0,
  risk_reasons: null,
  image_preview_url: null,
  video_preview_url: null,
  source_url: null,
  origin: 'zerosum',
  status: 'rewritten',
  our_text: 'Fixture-only owner-authored prompt text, invented for this test.',
};

/** A fake `fetch` implementing initialize -> notifications/initialized -> tools/call, where the
 * tools/call response is produced by `handler`. */
function fakeMcpFetch(handler: (toolName: string, args: unknown) => { isError?: boolean; structuredContent?: unknown; text?: string }) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/call') {
      const outcome = handler(body.params.name, body.params.arguments);
      const result: Record<string, unknown> = { isError: outcome.isError === true };
      if (outcome.structuredContent !== undefined) result.structuredContent = outcome.structuredContent;
      if (outcome.text !== undefined) result.content = [{ type: 'text', text: outcome.text }];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected method ${body.method}`);
  }) as unknown as typeof fetch;
}

describe('motionsites bridge', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-motionsites-bridge-'));
    resetLocalCorpusCache([ZEROSUM_ROW]);
  });

  afterEach(async () => {
    resetLocalCorpusCache(null);
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('fetchMotionSitesCatalogEntries', () => {
    it('returns only the local-corpus entries when there is no MotionSites connection', async () => {
      const { entries, upstream } = await fetchMotionSitesCatalogEntries(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.sourceKind).toBe('local-corpus');
      // Never carries our_text.
      expect(JSON.stringify(entries)).not.toContain(ZEROSUM_ROW.our_text);
      // No connection is not an upstream failure — the field must be entirely absent, not
      // undefined-valued, so a caller can tell the two cases apart with `'upstream' in result`.
      expect(upstream).toBeUndefined();
    });

    it('merges local-corpus entries first, then federated entries, when connected', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({
        structuredContent: {
          results: [{ id: 'ms-1', title: 'Fixture Hero', category: 'Hero', kind: 'website', access: 'free', url: 'https://motionsites.ai/?prompt=ms-1' }],
        },
      }));
      const { entries, upstream } = await fetchMotionSitesCatalogEntries(dataDir, { fetchImpl });
      expect(entries.map((e) => e.sourceKind)).toEqual(['local-corpus', 'motionsites-prompt']);
      expect(entries[1]!.id).toBe('motionsites-prompt:ms-1');
      expect(upstream).toBeUndefined();
    });

    it('uses search_prompts (not list_prompts) when a query is given', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      let calledTool = '';
      const fetchImpl = fakeMcpFetch((toolName) => {
        calledTool = toolName;
        return { structuredContent: { results: [] } };
      });
      await fetchMotionSitesCatalogEntries(dataDir, { fetchImpl, query: 'dark fintech hero' });
      expect(calledTool).toBe('search_prompts');
    });

    it('degrades the federated half to empty (not an error), with no upstream field, on a tool-level denial', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({ isError: true, text: 'nope' }));
      const { entries, upstream } = await fetchMotionSitesCatalogEntries(dataDir, { fetchImpl });
      expect(entries).toHaveLength(1); // local only
      expect(upstream).toBeUndefined();
    });

    it('degrades the federated half to empty on a transport failure, and surfaces a structured upstream field (FIX 3)', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
      const { entries, upstream } = await fetchMotionSitesCatalogEntries(dataDir, { fetchImpl });
      expect(entries).toHaveLength(1); // local only
      expect(upstream).toEqual({ code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: expect.stringContaining('HTTP 500') });
    });

    it('logs a warning on a transport failure, with no response-body payload in the log line', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = vi.fn(async () => new Response('SENTINEL_UPSTREAM_BODY_never_logged', { status: 500 })) as unknown as typeof fetch;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { upstream } = await fetchMotionSitesCatalogEntries(dataDir, { fetchImpl });
        // The response body DOES reach the structured field returned to the caller...
        expect(upstream!.message).toContain('SENTINEL_UPSTREAM_BODY_never_logged');
        // ...but never the console.warn call, which must stay a bare, payload-free notice.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        for (const call of warnSpy.mock.calls) {
          expect(call.join(' ')).not.toContain('SENTINEL_UPSTREAM_BODY_never_logged');
        }
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('fetchMotionSitesDesignReference', () => {
    it('resolves a zerosum-kit id from the local corpus, in memory, with the full entry id preserved', async () => {
      const ref = await fetchMotionSitesDesignReference(dataDir, 'zerosum-kit:zs-fixture-01');
      expect(ref).toEqual({ promptId: 'zerosum-kit:zs-fixture-01', text: ZEROSUM_ROW.our_text });
    });

    it('throws a plain Error for an unknown zerosum-kit id', async () => {
      await expect(fetchMotionSitesDesignReference(dataDir, 'zerosum-kit:does-not-exist')).rejects.toThrow(/No local-corpus row/);
    });

    it('throws MotionSitesLoginRequiredError for a motionsites-prompt id with no connection', async () => {
      await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:dreamcore-landing')).rejects.toThrow(MotionSitesLoginRequiredError);
    });

    it('rejects an unrecognized id prefix', async () => {
      await expect(fetchMotionSitesDesignReference(dataDir, 'hyperui:marketing/hero/1')).rejects.toThrow(/not a recognized MotionSites bridge designReferenceId/);
    });

    it('fetches a motionsites-prompt body transiently and returns it in memory', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch((toolName, args) => {
        expect(toolName).toBe('get_prompt');
        expect(args).toEqual({ id: 'dreamcore-landing' });
        return { structuredContent: { id: 'dreamcore-landing', text: 'FIXTURE prompt body text, invented for this test.' } };
      });
      const ref = await fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:dreamcore-landing', fetchImpl);
      expect(ref).toEqual({ promptId: 'motionsites-prompt:dreamcore-landing', text: 'FIXTURE prompt body text, invented for this test.' });
    });

    it('throws MotionSitesPaidAccessRequiredError when the tool reports a paid-plan denial, WITHOUT the prompt text ever appearing in the thrown error', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({ isError: true, text: 'This prompt requires a premium plan. Upgrade at https://motionsites.ai/unlimited' }));
      let caught: unknown;
      try {
        await fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:premium-1', fetchImpl);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MotionSitesPaidAccessRequiredError);
      expect((caught as MotionSitesPaidAccessRequiredError).promptId).toBe('premium-1');
      // The tool's own denial text names no prompt body, so this simply asserts the thrown
      // error's message is the denial reason, not fabricated prompt content.
      expect((caught as Error).message).toMatch(/premium plan/);
    });

    it('throws MotionSitesUpstreamError on a malformed/empty get_prompt result', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({ structuredContent: {} }));
      await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:empty-1', fetchImpl)).rejects.toThrow(MotionSitesUpstreamError);
    });

    it('does not fall back to the raw tool-result text when structuredContent carries no recognized text field (FIX 4)', async () => {
      // Regression for the delta audit: `isError: false` with a `structuredContent` shaped like an
      // error (or any other unrecognized shape) must not silently hand back the tool's raw text
      // block as if it were the prompt body — it must throw an explicit MotionSitesUpstreamError
      // instead of returning content the caller would treat as trustworthy prompt text.
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({
        structuredContent: { error: 'SENTINEL_ERROR_SHAPED_never_used_as_prompt_text' },
        text: 'SENTINEL_ERROR_SHAPED_never_used_as_prompt_text',
      }));
      await expect(fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:error-shaped-1', fetchImpl))
        .rejects.toThrow(MotionSitesUpstreamError);
    });

    it('never logs the fetched prompt text (console.log/error/warn stay silent on success)', async () => {
      await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
      const fetchImpl = fakeMcpFetch(() => ({ structuredContent: { text: 'SENTINEL_PROMPT_TEXT_never_logged' } }));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await fetchMotionSitesDesignReference(dataDir, 'motionsites-prompt:sentinel', fetchImpl);
        for (const spy of [logSpy, errorSpy, warnSpy]) {
          for (const call of spy.mock.calls) {
            expect(call.join(' ')).not.toContain('SENTINEL_PROMPT_TEXT_never_logged');
          }
        }
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
