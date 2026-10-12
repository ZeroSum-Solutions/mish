// `od cult preview`: the CLI side of the Catalog live preview, over a stubbed daemon.

import { describe, expect, it } from 'vitest';

import { runCultPreviewCli } from '../src/cult-preview-cli.js';

const BASE = 'http://127.0.0.1:7456';

function daemon(routes: Record<string, { status?: number; body: string; type?: string }>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    seen.push(href);
    const hit = routes[href.slice(BASE.length)];
    if (!hit) return new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { 'content-type': hit.type ?? 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, seen, resolveBaseUrl: async () => BASE };
}

describe('od cult preview', () => {
  it('prints whether a row previews live and the frame URL', async () => {
    const d = daemon({ '/api/cult/preview/cult%3Aglow-badge': { body: '{"preview":{"live":true,"mode":"harness","supportsDark":true,"mockNote":null}}' } });
    const result = await runCultPreviewCli(['glow-badge', '--theme', 'dark'], d);
    expect(result).toEqual({
      kind: 'done', code: 0, stderr: [],
      stdout: `Id\tcult:glow-badge\nLive\tyes\nMode\tharness\nDark theme\tyes\nFrame\t${BASE}/api/cult/preview/cult%3Aglow-badge/frame?theme=dark\n`,
    });
  });

  it('prints the reason when it cannot preview live, and --html fails with it', async () => {
    const d = daemon({ '/api/cult/preview/cult%3Achat-app': { body: '{"preview":{"live":false,"mode":"harness","reason":"it needs server keys"}}' } });
    const text = await runCultPreviewCli(['cult:chat-app'], d);
    expect(text).toMatchObject({ kind: 'done', code: 0 });
    expect((text as { stdout: string }).stdout).toContain("Reason\tcan't preview live: it needs server keys");
    expect(await runCultPreviewCli(['cult:chat-app', '--html'], d)).toEqual({ kind: 'done', code: 1, stdout: '', stderr: ["[cult] can't preview live: it needs server keys"] });
  });

  it('prints the frame page with --html', async () => {
    const d = daemon({
      '/api/cult/preview/cult%3Ahero-glow': { body: '{"preview":{"live":true,"mode":"converted","supportsDark":true,"mockNote":null}}' },
      '/api/cult/preview/cult%3Ahero-glow/frame?theme=light': { body: '<!doctype html><p>hero</p>', type: 'text/html' },
    });
    expect(await runCultPreviewCli(['cult:hero-glow', '--html'], d)).toEqual({ kind: 'done', code: 0, stdout: '<!doctype html><p>hero</p>', stderr: [] });
  });

  it('passes a refusal through as an HTTP failure, and rejects bad input', async () => {
    const d = daemon({ '/api/cult/preview/cult%3Ax': { status: 403, body: '{"error":{"code":"FORBIDDEN"}}' } });
    expect((await runCultPreviewCli(['cult:x'], d)).kind).toBe('http-failure');
    expect(await runCultPreviewCli([], d)).toMatchObject({ kind: 'usage' });
    expect(await runCultPreviewCli(['../etc'], d)).toMatchObject({ kind: 'usage' });
    expect(await runCultPreviewCli(['x', '--theme', 'blue'], d)).toMatchObject({ kind: 'usage' });
    expect(await runCultPreviewCli(['--help'], d)).toEqual({ kind: 'help', code: 0 });
  });
});
