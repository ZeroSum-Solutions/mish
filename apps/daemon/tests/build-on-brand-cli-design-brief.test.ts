// Flagship step 4 on the CLI: `od build-on-brand project` makes the Improve-prompt project, and a
// build names the accepted brief with --project and --design-brief* (same POST the card sends).
import { describe, expect, it } from 'vitest';

import { BUILD_ON_BRAND_EXIT, runBuildOnBrandCli } from '../src/build-on-brand-cli.js';

const HASH = 'c'.repeat(64);

function harness(answer: (url: string, body: any) => { status: number; body: unknown }) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Array<{ url: string; body: any }> = [];
  const io = {
    baseUrl: 'http://daemon',
    stdout: (text: string) => { out.push(text); },
    stderr: (text: string) => { err.push(text); },
    readStdin: async () => '',
    readFile: async () => '',
    writeFile: async () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url, body });
      const reply = answer(url, body);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return { io, out, err, sent };
}

describe('od build-on-brand with Improve prompt', () => {
  it('makes the Improve-prompt project', async () => {
    const h = harness(() => ({ status: 201, body: { projectId: 'bob-empty' } }));
    const code = await runBuildOnBrandCli(['project', '--design-system', 'neutral-product', '--json'], h.io);
    expect(code).toBe(BUILD_ON_BRAND_EXIT.done);
    expect(h.sent).toEqual([{ url: 'http://daemon/api/build-on-brand/project', body: { designSystemId: 'neutral-product' } }]);
    expect(JSON.parse(h.out.join(''))).toEqual({ projectId: 'bob-empty' });
  });

  it('sends the accepted brief binding with the build', async () => {
    const h = harness(() => ({ status: 202, body: { projectId: 'bob-empty', conversationId: 'c', runId: 'r', plan: { pages: [] } } }));
    const code = await runBuildOnBrandCli([
      '--no-wait', '--json', '--design-system', 'neutral-product', '--brief', 'Dentistry',
      '--project', 'bob-empty', '--design-brief', 'brief_1', '--design-brief-revision', '2', '--design-brief-hash', HASH,
    ], h.io);
    expect(code).toBe(BUILD_ON_BRAND_EXIT.done);
    expect(h.sent[0]!.body.designBrief).toEqual({ projectId: 'bob-empty', id: 'brief_1', revision: 2, hash: HASH });
  });

  it('refuses a partial binding before sending anything', async () => {
    const h = harness(() => ({ status: 500, body: {} }));
    const code = await runBuildOnBrandCli(['--design-system', 'neutral-product', '--brief', 'x', '--design-brief', 'brief_1'], h.io);
    expect(code).toBe(BUILD_ON_BRAND_EXIT.usage);
    expect(h.err.join('')).toContain('--design-brief-revision');
    expect(h.sent).toEqual([]);
  });

  it('exits 2 on a stale brief', async () => {
    const h = harness(() => ({ status: 409, body: { error: { code: 'brief-stale', message: 'The brief changed since it was accepted; review it again' } } }));
    const code = await runBuildOnBrandCli([
      '--no-wait', '--design-system', 'neutral-product', '--brief', 'x',
      '--project', 'bob-empty', '--design-brief', 'brief_1', '--design-brief-revision', '2', '--design-brief-hash', HASH,
    ], h.io);
    expect(code).toBe(BUILD_ON_BRAND_EXIT.usage);
    expect(h.err[0]).toContain('review it again');
  });
});
