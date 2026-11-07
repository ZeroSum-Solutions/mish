import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LinkPageBuildRequest, LinkPageModelInfo, LinkPageModelLaneChoice } from '@mish/contracts';
import type { Llm } from '@mish/linkpage';
import { createJevGate } from '../src/linkpage/gate.js';
import { createLinkPageService } from '../src/linkpage/service.js';
import { createLinkPageStore } from '../src/linkpage/store.js';

const SITE = '<html><head><title>Studio</title><meta property="og:site_name" content="Studio Name"/><meta name="description" content="Hand made."/></head><body></body></html>';
const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith('https://studio.example.com') ? new Response(SITE, { status: 200 }) : new Response('missing', { status: 404 });
}) as typeof fetch;

const BUILD: LinkPageBuildRequest = { slug: 'studio', sources: [{ connector: 'website', ref: 'https://studio.example.com' }] };
const PERSON = (headline: string) => ({ headline, bio: 'Makes hand-thrown pots.', about: 'About.', themes: ['ceramics', 'forex signals'], voice: 'warm', offerings: [], confidence: 'high' });

/** A model lane that reads the person with a fixed headline and reports a given lane. */
const lane = (name: LinkPageModelInfo['lane'], headline: string): Llm & { report: () => LinkPageModelInfo } => ({
  json: async () => PERSON(headline),
  report: () => ({ lane: name, calls: 1 }),
});

/** A Jev that scores `sufficient` by the headline in the state, and drops the theme 'forex signals'. */
function jev(byHeadline: Record<string, number>) {
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const text = (body.state[id] as { text?: string } | undefined)?.text;
      answers[id] = { type: 'noul', noul: id === 'sufficient' ? (byHeadline[String(body.state.headline)] ?? 0.9) : text === 'forex signals' ? 0.01 : 0.9 };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls: () => calls };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'od-gate-service-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function service(opts: { lanes: Record<string, ReturnType<typeof lane> | undefined>; gate?: ReturnType<typeof jev> | 'none'; defaultLane?: LinkPageModelLaneChoice }) {
  const asked: Array<LinkPageModelLaneChoice | undefined> = [];
  const svc = createLinkPageService({
    store: createLinkPageStore(dir),
    fetch: fakeFetch,
    resolveLlm: (l) => { asked.push(l); return opts.lanes[l ?? 'auto']; },
    ...(opts.gate === 'none' ? {} : { gate: createJevGate({ resolveKey: async () => 'jev-fake', fetchImpl: (opts.gate ?? jev({})).fetchImpl }) }),
    ...(opts.defaultLane ? { defaultLane: () => opts.defaultLane! } : {}),
  });
  return { svc, asked };
}

describe('the gate in a build', () => {
  it('drops low-probability items from the saved page and reports them in gate', async () => {
    const { svc } = service({ lanes: { auto: lane('openrouter', 'Potter making stoneware') } });
    const res = await svc.build(BUILD);
    expect(res.spec.profile.themes).toEqual(['ceramics']);
    expect(res.gate).toEqual({ ran: true, sufficiency: 0.9, dropped: [{ kind: 'theme', text: 'forex signals', probability: 0.01 }] });
    expect((await svc.get('studio')).spec.profile.themes).toEqual(['ceramics']);
  });

  it('adds no gate section when the daemon runs no gate', async () => {
    const { svc } = service({ lanes: { auto: lane('openrouter', 'Potter') }, gate: 'none' });
    const res = await svc.build(BUILD);
    expect(res.gate).toBeUndefined();
    expect(res.spec.profile.themes).toEqual(['ceramics', 'forex signals']);
  });

  it('fails open: a gate that cannot run leaves the page whole and the build succeeds', async () => {
    const svc = createLinkPageService({
      store: createLinkPageStore(dir), fetch: fakeFetch, resolveLlm: () => lane('openrouter', 'Potter'),
      gate: createJevGate({ resolveKey: async () => { throw new Error('no key'); } }),
    });
    const res = await svc.build(BUILD);
    expect(res.gate).toEqual({ ran: false, skipped: 'no-key', dropped: [] });
    expect(res.spec.profile.themes).toEqual(['ceramics', 'forex signals']);
    expect(res.saved).toBe(true);
  });

  it('a creator-typed headline and bio are not judged', async () => {
    const j = jev({});
    const { svc } = service({ lanes: { auto: lane('openrouter', 'ignored') }, gate: j });
    const res = await svc.build({ ...BUILD, options: { headline: 'My own line', bio: 'My own bio' } });
    expect(res.gate?.sufficiency).toBeUndefined();
    expect(res.spec.profile.headline).toBe('My own line');
  });
});

describe('insufficient and the auto retry', () => {
  it('on auto, retries once on the next lane and keeps the better read', async () => {
    const { svc, asked } = service({
      lanes: { auto: lane('openrouter', 'Thin line'), 'claude-cli': lane('claude-cli', 'Potter making stoneware') },
      gate: jev({ 'Thin line': 0.3, 'Potter making stoneware': 0.8 }),
    });
    const res = await svc.build(BUILD);
    expect(asked).toEqual([undefined, 'claude-cli']);
    expect(res.spec.profile.headline).toBe('Potter making stoneware');
    expect(res.model.lane).toBe('claude-cli');
    expect(res.gate?.insufficient).toBeUndefined();
    expect(res.gate?.retried).toEqual({ lane: 'claude-cli', kept: 'retry' });
  });

  it('keeps the first read when the retry is no better, and still reports insufficient with the reason', async () => {
    const { svc, asked } = service({
      lanes: { auto: lane('openrouter', 'Thin line'), 'claude-cli': lane('claude-cli', 'Thinner') },
      gate: jev({ 'Thin line': 0.3, Thinner: 0.1 }),
    });
    const res = await svc.build(BUILD);
    expect(asked).toEqual([undefined, 'claude-cli']);
    expect(res.spec.profile.headline).toBe('Thin line');
    expect(res.model.lane).toBe('openrouter');
    expect(res.gate?.insufficient?.probability).toBe(0.3);
    expect(res.gate?.insufficient?.reason).toMatch(/0\.3 for being sufficient and specific/);
    expect(res.gate?.retried).toEqual({ lane: 'claude-cli', kept: 'first' });
    expect(res.saved).toBe(true);
  });

  it('retries only once', async () => {
    const j = jev({ 'Thin line': 0.1, Thinner: 0.1 });
    const { svc, asked } = service({ lanes: { auto: lane('openrouter', 'Thin line'), 'claude-cli': lane('claude-cli', 'Thinner') }, gate: j });
    await svc.build(BUILD);
    expect(asked).toHaveLength(2);
    expect(j.calls()).toBe(2);
  });

  it.each([
    ['a forced lane', 'openrouter' as const, undefined],
    ['the daemon default set to a forced lane', undefined, 'deepseek' as const],
  ])('does not retry on %s', async (_name, requested, defaultLane) => {
    const { svc, asked } = service({ lanes: { openrouter: lane('openrouter', 'Thin line'), auto: lane('openrouter', 'Thin line') }, gate: jev({ 'Thin line': 0.1 }), ...(defaultLane ? { defaultLane } : {}) });
    const res = await svc.build({ ...BUILD, ...(requested ? { options: { modelLane: requested } } : {}) });
    expect(asked).toHaveLength(1);
    expect(res.gate?.insufficient).toBeDefined();
    expect(res.gate?.retried).toBeUndefined();
  });

  it('does not retry when the first read already came from the Claude CLI or no model answered', async () => {
    for (const first of [lane('claude-cli', 'Thin line'), undefined]) {
      const { svc, asked } = service({ lanes: { auto: first }, gate: jev({ 'Thin line': 0.1 }) });
      const res = await svc.build(BUILD);
      expect(asked).toHaveLength(1);
      expect(res.gate?.retried).toBeUndefined();
    }
  });

  it('does not retry when the gate could not run', async () => {
    const { svc, asked } = service({ lanes: { auto: lane('openrouter', 'Thin line') } });
    const svc2 = createLinkPageService({
      store: createLinkPageStore(dir), fetch: fakeFetch, resolveLlm: (l) => { asked.push(l); return lane('openrouter', 'Thin line'); },
      gate: createJevGate({ resolveKey: async () => 'k', fetchImpl: (async () => new Response('x', { status: 500 })) as typeof fetch }),
    });
    void svc;
    const res = await svc2.build(BUILD);
    expect(asked).toHaveLength(1);
    expect(res.gate?.skipped).toBe('unavailable');
  });
});
