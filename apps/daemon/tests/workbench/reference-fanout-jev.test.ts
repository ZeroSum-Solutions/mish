import { describe, expect, it } from 'vitest';
import { createReferenceJudge } from '../../src/workbench/references/jev.js';
import { resource } from './reference-fanout-fixtures.js';

const candidate = (id: string) => ({ id, title: `Public dental ${id}`, source: 'Refero', sections: ['Hero'] });
describe('V04 real Jev adapter with deterministic transport', () => {
  it('batches at 24 noul questions, passes actual metadata as data and generates no text', async () => {
    const calls: Record<string, any>[] = [];
    const judge = createReferenceJudge({ key: async () => 'fixture-token', fetchImpl: async (_url, init) => {
      const body = JSON.parse(init!.body as string); calls.push(body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.8 }])) }), { status: 200 });
    } });
    const result = await judge({ brief: 'dentistry website', candidates: Array.from({ length: 9 }, (_, i) => candidate(`${i}`)) }, { signal: new AbortController().signal });
    expect(result).toHaveLength(9); expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]!.questions)).toHaveLength(24);
    expect(Object.values(calls[0]!.questions).every((value: any) => value.type === 'noul')).toBe(true);
    expect(calls[0]!.state.candidates).not.toContain('refero.design');
    expect(calls[0]!.state.candidates).not.toContain('description');
    expect(JSON.stringify(calls)).not.toContain('fixture-token');
    expect(result[0]).toEqual({ id: '0', relevance: 0.8, sectionFit: 0.8, evidence: 0.8 });
  });
  it('rejects missing, partial, out of range and non-finite answers or failed transport', async () => {
    for (const response of [ { answers: {} }, { answers: { c0_relevance: { type: 'choice', noul: 0.8 }, c0_sectionFit: { type: 'noul', noul: 0.8 }, c0_evidence: { type: 'noul', noul: 0.8 } } }, { answers: { c0_relevance: { noul: 0.8 }, c0_sectionFit: { noul: 0.8 }, c0_evidence: { noul: 0.8 } } }, { answers: { c0_relevance: { noul: 2 } } }, { answers: { c0_relevance: { noul: '0.9' } } } ]) {
      const judge = createReferenceJudge({ key: async () => 'fixture-token', fetchImpl: async () => new Response(JSON.stringify(response)) });
      await expect(judge({ brief: 'x', candidates: [candidate('one')] }, { signal: new AbortController().signal })).rejects.toThrow();
    }
    const judge = createReferenceJudge({ key: async () => { throw new Error('missing'); } });
    await expect(judge({ brief: 'x', candidates: [candidate('one')] }, { signal: new AbortController().signal })).rejects.toThrow('missing');
  });
});

it('minimizes Jev egress to the brief and public title, source and section; aborts all batches', async () => {
  const calls: Record<string, any>[] = [];
  const controller = new AbortController();
  const judge = createReferenceJudge({ key: async () => 'fixture-token', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init!.body as string); calls.push(body);
    controller.abort();
    expect(init!.signal!.aborted).toBe(true);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.8 }])) }));
  } });
  await expect(judge({ brief: 'Dental brief', candidates: Array.from({ length: 9 }, (_, i) => ({ id: `private-${i}`, title: 'Public dental title', source: 'Mobbin', sections: ['Hero'],
    resource: { ...resource('mobbin', `${i}`, 'https://mobbin.com/screens/private?signed=secret'), category: 'secret-category', imageBytes: 'private image' },
  })) } as any, { signal: controller.signal })).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]!.state).sort()).toEqual(['brief', 'candidates']);
  expect(JSON.parse(calls[0]!.state.candidates)[0]).toEqual({ title: 'Public dental title', source: 'Mobbin', sections: ['Hero'] });
  expect(JSON.stringify(calls)).not.toMatch(/private|signed|image|secret-category/);
});

it('keeps completed Jev batches and sends no later batch after an overall abort', async () => {
  const controller = new AbortController();
  const batches: unknown[] = [];
  let count = 0;
  const judge = createReferenceJudge({ key: async () => 'fixture-token', fetchImpl: async (_url, init) => {
    count++;
    if (count === 2) {
      controller.abort(new DOMException('Deadline', 'TimeoutError'));
      return new Promise<never>(() => undefined);
    }
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.8 }])) }));
  } });
  await expect(judge({ brief: 'Dental brief', candidates: Array.from({ length: 17 }, (_, i) => candidate(`${i}`)) }, { signal: controller.signal, onBatch: batch => batches.push(batch) })).rejects.toThrow('Deadline');
  expect(count).toBe(2);
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(8);
});
