import { describe, expect, it } from 'vitest';

import type { LinkPageSpec } from '@mish/contracts';
import type { CreatorFacts } from '@mish/linkpage';
import { GATE_ITEM_THRESHOLD, GATE_SUFFICIENCY_THRESHOLD, createJevGate } from '../src/linkpage/gate.js';

const FACTS: CreatorFacts = {
  name: 'Sam Potter', bios: ['Hand-thrown stoneware from a small studio.'], siteTitle: 'Sam Potter Ceramics', siteUrl: 'https://sam.example.com/',
  platforms: ['website', 'instagram'], stats: ['12k followers'], pages: ['Sam makes mugs and bowls.'],
};

const SPEC = {
  version: 1, slug: 'sam',
  profile: { name: 'Sam Potter', headline: 'Potter making stoneware', bio: 'Hand-thrown stoneware.', about: 'About Sam.', themes: ['ceramics', 'crypto trading', 'glazes'], avatar_url: '', site_url: 'https://sam.example.com/' },
  theme: { mood: 'warm', radius: 'md', background: 'plain', palette: { bg: '#fff', text: '#000', accent: '#c00' }, fonts: { heading: {}, body: {} } },
  blocks: [
    { id: 'link-1', type: 'link', label: 'Shop', url: 'https://sam.example.com/shop', description: '', image_url: '', featured: false },
    { id: 'posts-1', type: 'posts', heading: 'From the journal', items: [
      { title: 'Firing the new kiln', url: 'https://sam.example.com/a', image_url: '' },
      { title: 'Ten tips to win at online poker', url: 'https://sam.example.com/b', image_url: '' },
    ] },
  ],
} as unknown as LinkPageSpec;

const KEY = 'jev-fake-key-never-logged';
type Req = { url: string; auth: string; body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string }> } };

/** A fake Jev that answers each question by the text it is about. */
function jev(score: (id: string, text: string) => number | undefined, status = 200) {
  const requests: Req[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization), body });
    if (status !== 200) return new Response('upstream secret body', { status });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const text = id === 'sufficient' ? '' : String((body.state[id] as { text: string }).text);
      const p = score(id, text);
      if (p !== undefined) answers[id] = { type: 'noul', noul: p };
    }
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { requests, fetchImpl };
}

const review = (fetchImpl: typeof globalThis.fetch, extra: { resolveKey?: () => Promise<string>; fromOptions?: { headline?: boolean; bio?: boolean } } = {}) =>
  createJevGate({ resolveKey: extra.resolveKey ?? (async () => KEY), fetchImpl }).review({ spec: SPEC, facts: FACTS, fromOptions: extra.fromOptions ?? {} });

describe('the thresholds', () => {
  it('are named constants', () => {
    expect(GATE_ITEM_THRESHOLD).toBe(0.2);
    expect(GATE_SUFFICIENCY_THRESHOLD).toBe(0.4);
  });
});

describe('the Jev gate', () => {
  it('asks typed noul questions on jev-latest with the creator facts as state', async () => {
    const { requests, fetchImpl } = jev(() => 0.9);
    const result = await review(fetchImpl);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(req.auth).toBe(`Bearer ${KEY}`);
    expect(req.body.model).toBe('jev-latest');
    expect(req.body.state.creator).toEqual(FACTS);
    expect(req.body.state.bio).toBe('Hand-thrown stoneware.');
    expect(req.body.state.headline).toBe('Potter making stoneware');
    const ids = Object.keys(req.body.questions);
    // sufficiency + headline + 3 themes + 2 post titles
    expect(ids).toEqual(['sufficient', 'item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5']);
    for (const q of Object.values(req.body.questions)) expect(q.type).toBe('noul');
    expect(req.body.state.item_0).toEqual({ kind: 'headline', text: 'Potter making stoneware' });
    expect(req.body.state.item_2).toEqual({ kind: 'theme', text: 'crypto trading' });
    expect(req.body.state.item_5).toEqual({ kind: 'post', text: 'Ten tips to win at online poker' });
    expect(result.gate).toEqual({ ran: true, sufficiency: 0.9, dropped: [] });
    expect(result.spec).toEqual(SPEC);
  });

  it('drops items under the threshold, keeps the one at it, and lists them with the probability', async () => {
    const { fetchImpl } = jev((id, text) => (id === 'sufficient' ? 0.8 : text === 'crypto trading' ? 0.05 : text.startsWith('Ten tips') ? 0.19 : text === 'glazes' ? 0.2 : 0.9));
    const { spec, gate } = await review(fetchImpl);
    expect(gate.dropped).toEqual([
      { kind: 'theme', text: 'crypto trading', probability: 0.05 },
      { kind: 'post', text: 'Ten tips to win at online poker', probability: 0.19 },
    ]);
    expect(spec.profile.themes).toEqual(['ceramics', 'glazes']);
    const posts = spec.blocks.find((b) => b.type === 'posts') as { items: Array<{ title: string }> };
    expect(posts.items.map((i) => i.title)).toEqual(['Firing the new kiln']);
    expect(spec.profile.headline).toBe('Potter making stoneware');
  });

  it('drops a low headline to nothing and removes a posts block that ends up empty, never adding text', async () => {
    const { fetchImpl } = jev((id, text) => (id === 'sufficient' ? 0.8 : text === 'Potter making stoneware' || text.includes('kiln') || text.includes('poker') ? 0.1 : 0.9));
    const { spec, gate } = await review(fetchImpl);
    expect(spec.profile.headline).toBe('');
    expect(spec.blocks.map((b) => b.id)).toEqual(['link-1']);
    expect(gate.dropped.map((d) => d.kind)).toEqual(['headline', 'post', 'post']);
    // The gate only removes: every remaining string was already in the page.
    const before = JSON.stringify(SPEC);
    for (const s of JSON.stringify(spec).match(/"[^"]+"/g) ?? []) expect(before).toContain(s);
  });

  it('does not judge a headline or bio the creator typed themselves', async () => {
    const { requests, fetchImpl } = jev(() => 0.01);
    const { spec, gate } = await review(fetchImpl, { fromOptions: { headline: true, bio: true } });
    expect(Object.keys(requests[0]!.body.questions)).not.toContain('sufficient');
    expect(requests[0]!.body.state.item_0).toEqual({ kind: 'theme', text: 'ceramics' });
    expect(spec.profile.headline).toBe('Potter making stoneware');
    expect(gate.dropped.some((d) => d.kind === 'headline')).toBe(false);
  });

  it('reports insufficient with the reason when the bio and headline score under 0.4, and still removes nothing else', async () => {
    const { fetchImpl } = jev((id) => (id === 'sufficient' ? 0.39 : 0.9));
    const { gate, spec } = await review(fetchImpl);
    expect(gate.sufficiency).toBe(0.39);
    expect(gate.insufficient).toEqual({
      probability: 0.39,
      reason: 'Jev rates the bio and headline 0.39 for being sufficient and specific to this person, under the 0.4 needed',
    });
    expect(spec).toEqual(SPEC);
    const ok = await review(jev((id) => (id === 'sufficient' ? 0.4 : 0.9)).fetchImpl);
    expect(ok.gate.insufficient).toBeUndefined();
  });

  it('reports insufficient without asking when there is no bio and no headline', async () => {
    const empty = { ...SPEC, profile: { ...SPEC.profile, headline: '', bio: '', themes: ['ceramics'] } } as LinkPageSpec;
    const { requests, fetchImpl } = jev(() => 0.9);
    const out = await createJevGate({ resolveKey: async () => KEY, fetchImpl }).review({ spec: empty, facts: FACTS, fromOptions: {} });
    expect(out.gate.insufficient?.reason).toBe('the page has no bio and no headline');
    expect(out.gate.insufficient?.probability).toBe(0);
    expect(Object.keys(requests[0]!.body.questions)).not.toContain('sufficient');
  });

  describe('fails open', () => {
    it('with no key, makes no request', async () => {
      const { requests, fetchImpl } = jev(() => 0);
      const out = await review(fetchImpl, { resolveKey: async () => { throw new Error('no key'); } });
      expect(out).toEqual({ spec: SPEC, gate: { ran: false, skipped: 'no-key', dropped: [] } });
      expect(requests).toHaveLength(0);
    });

    it('with a key lookup that stalls', async () => {
      const out = await createJevGate({ resolveKey: () => new Promise<string>(() => {}), keyTimeoutMs: 20, fetchImpl: jev(() => 0).fetchImpl }).review({ spec: SPEC, facts: FACTS, fromOptions: {} });
      expect(out.gate).toEqual({ ran: false, skipped: 'no-key', dropped: [] });
    });

    it.each([
      ['a network error', (async () => { throw new Error('offline'); }) as typeof globalThis.fetch],
      ['an HTTP error', jev(() => 0, 500).fetchImpl],
      ['a rate limit', jev(() => 0, 429).fetchImpl],
      ['a body that is not JSON', (async () => new Response('<html>', { status: 200 })) as typeof globalThis.fetch],
      ['a body with no answers', (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch],
    ])('on %s the page is untouched and the gate says it was unavailable', async (_name, fetchImpl) => {
      const out = await review(fetchImpl);
      expect(out).toEqual({ spec: SPEC, gate: { ran: false, skipped: 'unavailable', dropped: [] } });
    });

    it('on a stalled request', async () => {
      const stalled = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
      const out = await createJevGate({ resolveKey: async () => KEY, fetchImpl: stalled, timeoutMs: 20 }).review({ spec: SPEC, facts: FACTS, fromOptions: {} });
      expect(out.gate).toEqual({ ran: false, skipped: 'unavailable', dropped: [] });
    });

    it('keeps an item whose answer is missing or out of range', async () => {
      const { fetchImpl } = jev((id) => (id === 'sufficient' ? 0.9 : id === 'item_2' ? undefined : id === 'item_3' ? 7 : 0.9));
      const out = await review(fetchImpl);
      expect(out.spec).toEqual(SPEC);
      expect(out.gate.dropped).toEqual([]);
    });

    it('never puts the key or an upstream body in the result', async () => {
      const out = await review(jev(() => 0, 500).fetchImpl);
      expect(JSON.stringify(out)).not.toContain(KEY);
      expect(JSON.stringify(out)).not.toContain('upstream secret body');
    });
  });
});
