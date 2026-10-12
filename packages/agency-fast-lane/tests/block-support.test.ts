import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBlockPlan, createJevBlockPlanner, type BlockCatalog } from '../src/block-plan.ts';
import { briefNeedsFaq } from '../src/block-support.ts';

const kinds = ['hero', 'features', 'team', 'pricing', 'faq', 'cta-band', 'footer'];
const catalog: BlockCatalog = { blocks: kinds.map((kind) => ({ id: kind, title: `Catalog ${kind}`, sectionKind: kind, spineAffinities: 'any', useCases: [], tags: [] })) };
const directions = [{ id: 'calm', label: 'Calm', mood: 'Calm' }];
function stub(scores: Record<string, unknown> | Error = { team: 0.95, pricing: 0.8 }) {
  const requests: Array<{ state: { brief: string }; questions: Record<string, { type: string; criteria: Record<string, string> }> }> = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (requests.length === 2 && scores instanceof Error) throw scores;
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
      const question = q as { type: string; criteria: Record<string, string> };
      if (question.type === 'noul') return [key, { type: 'noul', noul: (scores as Record<string, unknown>)[key.replace('support_', '')] ?? 0 }];
      const choice = ['block_team', 'block_pricing', 'block_faq'].includes(key) ? 'none' : Object.keys(question.criteria)[0];
      const block = Object.keys(question.criteria).find((id) => id !== 'none')!;
      return [key, { type: 'choice', choice, confidence: 0.99, probabilities: { [choice]: 0.99, ...(choice === 'none' ? { [block]: 0.01 } : {}) } }];
    }));
    return new Response(JSON.stringify({ answers }));
  }) as typeof fetch;
  return { requests, fetchImpl };
}

test('post-picker gate recovers supported missing types at inclusive default 0.8, before closing blocks', async () => {
  const { fetchImpl, requests } = stub();
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl }).plan({ brief: 'Partners: Ada and Bo. A consultation costs 150 pounds.', catalog, spine: 'TL' });
  assert.ok('plan' in judged);
  assert.deepEqual(judged.plan.blocks, ['hero', 'features', 'team', 'pricing', 'cta-band', 'footer']);
  assert.equal(judged.calls, 2);
  assert.deepEqual(Object.keys(requests[1].questions), ['support_team', 'support_pricing']);
  assert.ok(!JSON.stringify(requests[1].questions).includes('Catalog'));
  assert.deepEqual(judged.supportGate?.added.map((row) => row.kind), ['team', 'pricing']);
});

test('support threshold is separate from picker threshold and configurable', async () => {
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, ...stub({ team: 0.79, pricing: 0.8 }), supportThreshold: 0.9 }).plan({ brief: 'A team and prices.', catalog, spine: 'TL' });
  assert.ok('plan' in judged);
  assert.deepEqual(judged.plan.blocks, ['hero', 'features', 'cta-band', 'footer']);
});

test('FAQ is deterministic, never a Jev support question', async () => {
  for (const brief of ['Questions: Can I book? Yes. Can I cancel? Yes.', 'FAQ about access', 'Cancellation policies: 24 hours notice.', 'We accept insurance.']) {
    const { fetchImpl, requests } = stub({});
    const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl }).plan({ brief, catalog, spine: 'TL' });
    assert.ok('plan' in judged && judged.plan.blocks.includes('faq'), brief);
    assert.ok(!requests.some((request) => request.questions.support_faq));
    assert.equal(judged.supportGate?.added.find((row) => row.kind === 'faq')?.reason, 'faq-brief-signal');
  }
});

test('gate failure preserves the picker plan and records a sanitized reason', async () => {
  for (const scores of [new Error('private brief or provider text'), { team: 'invalid', pricing: 1 }]) {
    const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, ...stub(scores) }).plan({ brief: 'FAQ and named partners.', catalog, spine: 'TL' });
    assert.ok('plan' in judged);
    assert.deepEqual(judged.plan.blocks, ['hero', 'features', 'cta-band', 'footer']);
    assert.ok(judged.supportGate?.skipped);
    assert.ok(!JSON.stringify(judged).includes('private'));
  }
});

test('support threshold rejects invalid configuration before provider work', () => {
  for (const supportThreshold of [-1, 1.1, NaN, Infinity]) assert.throws(() => createJevBlockPlanner({ apiKey: 'stub', supportThreshold }), /supportThreshold/);
});

test('FAQ rule rejects negated requests and substring decoys', () => {
  for (const brief of ['No FAQ or questions section.', 'Do not include FAQ or policies.', 'Do not include an FAQ.', 'No insurance content.', 'A policyholder portrait.', 'A frequently updated blog.']) assert.equal(briefNeedsFaq(brief), false, brief);
});

test('unrelated negation and negative insurance facts still support FAQ content', () => {
  for (const brief of ['FAQ with no animations.', 'Insurance policy: no copay.', "Do not include the competitor's prices; include an FAQ.", 'We do not accept insurance.']) assert.equal(briefNeedsFaq(brief), true, brief);
});

test('gate never replaces selected types or exceeds the seven-block cap', async () => {
  const crowded: BlockCatalog = { blocks: [...catalog.blocks, ...['logo-wall', 'timeline-roadmap', 'blog-articles'].map((kind) => ({ id: kind, title: kind, sectionKind: kind, spineAffinities: 'any' as const, useCases: [], tags: [] }))] };
  const { fetchImpl, requests } = stub({ team: 1, pricing: 1 });
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl }).plan({ brief: 'FAQ. Named team and prices.', catalog: crowded, spine: 'TL' });
  assert.ok('plan' in judged);
  assert.equal(judged.plan.blocks.length, 7);
  assert.equal(checkBlockPlan(judged.plan, crowded, ['calm']), undefined);
  assert.ok(judged.supportGate?.decisions.some((row) => row.reason === 'capacity'));
  assert.deepEqual(Object.keys(requests[1].questions), ['support_team', 'support_pricing']);
});

test('picker-chosen FAQ survives a deterministic regex miss', async () => {
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, value]) => {
      const q = value as { criteria: Record<string, string> };
      const choice = Object.keys(q.criteria)[0];
      return [key, { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } }];
    })) }));
  }) as typeof fetch;
  const planner = createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl });
  const absent = await planner.plan({ brief: 'Contact the studio.', catalog, spine: 'TL' });
  assert.ok('plan' in absent && absent.plan.blocks.includes('faq'));
  assert.deepEqual(absent.supportGate?.removed, []);
  const present = await planner.plan({ brief: 'FAQ about access.', catalog, spine: 'TL' });
  assert.ok('plan' in present && present.plan.blocks.includes('faq'));
  assert.equal(present.calls, 1);
});

test('gate cancellation propagates instead of being reported as a skip', async () => {
  const controller = new AbortController();
  const base = stub();
  let calls = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    if (++calls === 2) { controller.abort(); throw new DOMException('cancelled', 'AbortError'); }
    return base.fetchImpl(...args);
  }) as typeof fetch;
  await assert.rejects(createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl, signal: controller.signal }).plan({ brief: 'Named team.', catalog, spine: 'TL' }), { name: 'AbortError' });
});

test('picker FAQ remains the body even without an additive FAQ signal', async () => {
  const base = stub({});
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.questions.block_hero) {
      const response = await base.fetchImpl(_url, init);
      const json = await response.json();
      json.answers.block_features = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
      json.answers.block_faq = { type: 'choice', choice: 'faq', confidence: 1, probabilities: { faq: 1 } };
      return new Response(JSON.stringify(json));
    }
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0 }])) }));
  }) as typeof fetch;
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl }).plan({ brief: 'Contact the studio.', catalog, spine: 'TL' });
  assert.ok('plan' in judged);
  assert.deepEqual(judged.plan.blocks, ['hero', 'faq', 'cta-band', 'footer']);
  assert.equal(judged.supportGate?.skipped, undefined);
});

test('an abort that races with a fulfilled support response still cancels the plan', async () => {
  const controller = new AbortController();
  const base = stub();
  let calls = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    const response = await base.fetchImpl(...args);
    if (++calls === 2) controller.abort();
    return response;
  }) as typeof fetch;
  await assert.rejects(createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl, signal: controller.signal }).plan({ brief: 'Named team.', catalog, spine: 'TL' }), { name: 'AbortError' });
});


test('FAQ recovery requires clear question or policy intent, not keywords', () => {
  for (const brief of ['insurance', 'An insurance agency.', 'privacy policy', 'Footer links: privacy policy, terms.', 'Questions?', 'Any questions?', 'Contact us with questions.', 'Why us? Questions?', 'No FAQ or common questions section.', 'No what to expect section.']) {
    assert.equal(briefNeedsFaq(brief), false, brief);
  }
  for (const brief of ['Explicit FAQ', 'Common questions about booking', 'What to expect at your first visit', 'Insurance we accept: Aetna', 'We accept insurance.', 'Cancellation policy: give 24 hours notice.', 'Can I cancel? Yes. How do I book? Online.']) {
    assert.equal(briefNeedsFaq(brief), true, brief);
  }
});

test('picker and support share one deadline; timeout keeps picker and counts both attempts', async () => {
  const base = stub();
  let calls = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    if (++calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return base.fetchImpl(...args);
    }
    const signal = args[1]!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const started = performance.now();
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl, timeoutMs: 1000 }).plan({ brief: 'FAQ and named team.', catalog, spine: 'TL' });
  assert.ok('plan' in judged);
  assert.deepEqual(judged.plan.blocks, ['hero', 'features', 'cta-band', 'footer']);
  assert.equal(judged.supportGate?.skipped, 'jev-timeout');
  assert.equal(judged.calls, 2);
  assert.ok(performance.now() - started < 1450, 'support must use the remaining budget');
});

test('a timed-out picker attempt is counted', async () => {
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 2000);
  const judged = await createJevBlockPlanner({ apiKey: 'stub', directions, fetchImpl, timeoutMs: 20 }).plan({ brief: 'Contact the studio.', catalog, spine: 'TL' }).finally(() => clearTimeout(keepAlive));
  assert.ok('fallback' in judged);
  assert.equal(judged.fallback, 'jev-timeout');
  assert.equal(judged.calls, 1);
});

test('FAQ recovery respects refusals and excludes footer links and rhetorical copy', () => {
  for (const brief of ['Skip the FAQ section.', 'Leave out the FAQ.', 'FAQ not needed.', 'No need for an FAQ.', 'We do not want any FAQs.', 'Frequently asked questions page not wanted', 'No FAQ. What to expect on arrival is covered in the hero.', 'Privacy policy: required link in footer', 'Cancellation policy: see footer link', 'Include our privacy policy link.', 'Who are we? We are a family bakery.', 'What makes us different? Nothing but flour and love.', 'Can your brand grow? You can.']) {
    assert.equal(briefNeedsFaq(brief), false, brief);
  }
  for (const brief of ['Do you offer refunds? Contact us.', 'Do you take insurance? We do.', 'Can I book online?', 'How much does delivery cost?', 'Explain our privacy policy.']) {
    assert.equal(briefNeedsFaq(brief), true, brief);
  }
});

test('visitor-question recovery excludes marketing openers', () => {
  for (const brief of ['Do you love coffee? So do we.', 'Is it worth it? Yes.', 'How do we help? No gimmicks, just results.', 'How long will you wait? Not long.', 'Is there a better way? Yes, ours.', 'What is the best bakery? Ours.', 'Do you ever wonder why? We do.', 'Do you have what it takes?', 'Can I dream bigger? Yes.']) {
    assert.equal(briefNeedsFaq(brief), false, brief);
  }
});
