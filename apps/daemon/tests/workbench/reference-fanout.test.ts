import { describe, expect, it, vi } from 'vitest';
import { type ReferenceFanoutRequest } from '@open-design/contracts';
import { ConnectorError } from '../../src/workbench/connectors/connector-proxy.js';
import { createReferenceFanout } from '../../src/workbench/references/fanout.js';

import { resource, searchResult } from './reference-fanout-fixtures.js';
import { referenceProviderFixture } from './reference-provider-fixtures.js';
const sections = [{ id: 'hero', name: 'Hero', purpose: 'Earn trust' }, { id: 'services', name: 'Services', purpose: 'Explain treatments' }];
const request: ReferenceFanoutRequest = { brief: 'dentistry website', sections, limit: 10 };
const judge = vi.fn(async (input: { candidates: { id: string }[] }) => input.candidates.map(item => ({ id: item.id, relevance: 0.9, sectionFit: 0.8, evidence: 0.7 })));

describe('V04 brief → section references', () => {
  it('reports ok sources for real Refero records and Mobbin section shapes through the proxy', async () => {
    const fixture = await referenceProviderFixture();
    try {
      const result = await createReferenceFanout({ search: (source, request, options) => fixture.proxy.search(source, request, options) }).fanout({
        brief: 'A note-taking app for students', sections: [sections[0]!], limit: 5,
      });
      expect(result.sources).toHaveLength(2);
      for (const source of ['refero', 'mobbin']) {
        expect(result.sources.find(item => item.source === source)).toMatchObject({ status: 'ok', count: 1 });
      }
      expect(result.references).toHaveLength(2);
      expect(result.references.map(item => item.resource.title)).toEqual(expect.arrayContaining(['Notion', 'Linear']));
    } finally { await fixture.dispose(); }
  });
  it('kept optional sections augment the page spine instead of replacing it', async () => {
    const search = async (source: 'refero' | 'mobbin') => searchResult(source, []);
    const result = await createReferenceFanout({ search }).fanout({ brief: 'dentistry website', sectionAdditions: [{ id: 'patient-stories', name: 'Testimonials', purpose: 'reviews' }], limit: 10 });
    expect(result.sections.map(section => section.name)).toEqual(expect.arrayContaining(['Hero', 'services', 'Testimonials', 'Footer']));
    expect(result.sections.some(section => section.name.includes('Book'))).toBe(true);
    expect(result.sections.find(section => section.name === 'Testimonials')?.id).toBe('patient-stories');
  });
  it('does not reintroduce dropped roles into automatically suggested sections', async () => {
    const search = async (source: 'refero' | 'mobbin') => searchResult(source, []);
    const result = await createReferenceFanout({ search }).fanout({ brief: 'dentistry website', excludedSections: ['Hero', 'services', 'reviews'], limit: 10 });
    expect(result.sections.some(section => /hero|services|reviews/iu.test(section.name))).toBe(false);
  });
  it('derives dentistry sections, fans out per section, favors Refero, dedupes and records reasons/rights', async () => {
    const search = vi.fn(async (source: 'refero' | 'mobbin', input: { query: string }) => searchResult(source, [resource(source, input.query.includes('Hero') ? 'hero' : 'body')]));
    const result = await createReferenceFanout({ search, judge }).fanout({ brief: 'dentistry website', limit: 10 });
    expect(result.spineCode).toBe('TL');
    expect(result.sectionBasis).toBe('suggested');
    expect(search).toHaveBeenCalledTimes(result.sections.length * 2);
    expect(result.sections.every(item => item.query.includes('dentistry') && item.query.includes(item.name))).toBe(true);
    expect(result.references.length).toBe(4);
    expect(new Set(result.references.map(item => item.resource.canonicalUrl)).size).toBe(4);
    expect(result.references[0]?.resource.connectorId).toBe('refero');
    expect(result.references[0]?.reasons.join(' ')).toContain('Jev');
    expect(result.references.every(item => item.rightsLabel === item.resource.rights.status)).toBe(true);
    expect(judge).toHaveBeenCalled();
  });
  it('uses provided sections exactly and weights Mobbin higher for SaaS/mobile/commerce', async () => {
    const search = async (source: 'refero' | 'mobbin') => searchResult(source, [resource(source, 'one')]);
    const service = createReferenceFanout({ search, judge });
    const dental = await service.fanout(request);
    const saas = await service.fanout({ ...request, brief: 'SaaS software signup' });
    expect(saas.sectionBasis).toBe('provided');
    expect(saas.sections.map(({ query: _, ...section }) => section)).toEqual(sections);
    expect(saas.references.find(item => item.resource.connectorId === 'mobbin')!.sourceWeight).toBeGreaterThan(dental.references.find(item => item.resource.connectorId === 'mobbin')!.sourceWeight);
  });
  it('reports a lost source without hiding successes or echoing provider/credential errors', async () => {
    const search = async (source: 'refero' | 'mobbin') => { if (source === 'mobbin') throw new ConnectorError(409, 'connector-binding-missing', 'SECRET provider error'); return searchResult(source, [resource(source, 'one')]); };
    const result = await createReferenceFanout({ search, judge }).fanout(request);
    expect(result.degraded).toBe(true);
    expect(result.sources.filter(item => item.status === 'unavailable')).toHaveLength(2);
    expect(result.sources.find(item => item.source === 'mobbin')?.code).toBe('connector-binding-missing');
    expect(result.references).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('reports missing/bad Jev with unscored deterministic references, never invented scores', async () => {
    const search = async (source: 'refero' | 'mobbin') => searchResult(source, [resource(source, 'one')]);
    for (const judge of [undefined, async () => [{ id: 'invented', relevance: 7, sectionFit: 1, evidence: 1 }]]) {
      const result = await createReferenceFanout({ search, ...(judge ? { judge } : {}) }).fanout(request);
      expect(result.ranking.status).toBe('unavailable');
      expect(result.degraded).toBe(true);
      expect(result.references.every(item => item.score === null)).toBe(true);
    }
  });
  it('keeps coverage before filling the default ten slots, preserves provider notices, caps concurrency', async () => {
    let active = 0, peak = 0;
    const search = async (source: 'refero' | 'mobbin', input: { query: string }) => {
      active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 1)); active--;
      return { ...searchResult(source, Array.from({ length: 5 }, (_, i) => resource(source, `${input.query.includes('Hero') ? 'hero' : 'services'}-${i}`))), providerNotice: 'Keep this notice\nverbatim.' };
    };
    const result = await createReferenceFanout({ search, judge }).fanout(request);
    expect(result.references).toHaveLength(10);
    expect(sections.every(section => result.references.some(item => item.sectionIds.includes(section.id)))).toBe(true);
    expect(result.sources[0]?.providerNotice).toBe('Keep this notice\nverbatim.');
    expect(peak).toBeLessThanOrEqual(4);
  });
  it('canonicalizes fragment/tracking variants and unions section provenance before ranking', async () => {
    const search = async (source: 'refero' | 'mobbin', input: { query: string }) => searchResult(source, [resource(source, 'one', `https://refero.design/screens/one?utm_source=${input.query.includes('Hero') ? 'a' : 'b'}`)]);
    const result = await createReferenceFanout({ search, judge }).fanout(request);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.sectionIds).toEqual(['hero', 'services']);
    expect(result.references[0]?.resource.connectorId).toBe('refero');
  });
});


describe('V04 lead decisions', () => {
  it('refuses owner-seat searches for non-owner principals without hiding Refero', async () => {
    const search = vi.fn(async (source: 'refero' | 'mobbin') => searchResult(source, [resource(source, 'one')]));
    for (const principalId of ['workspace:team:member', 'tool-agent']) {
      search.mockClear();
      const result = await createReferenceFanout({ search }).fanout(request, { principalId });
      expect(search.mock.calls.map(([source]) => source)).toEqual(['refero', 'refero']);
      expect(result.sources.filter(item => item.source === 'mobbin').every(item => item.code === 'connector-principal-forbidden')).toBe(true);
      expect(result.references.every(item => item.resource.connectorId === 'refero')).toBe(true);
    }
  });
  it('never passes rights-blocked items to Jev and records deterministic ordering', async () => {
    const search = async (source: 'refero' | 'mobbin') => {
      const item = resource(source, 'one');
      item.rights.operations = item.rights.operations.map(right => ({ ...right, decision: source === 'refero' ? 'blocked' as const : 'allowed' as const }));
      return searchResult(source, [item]);
    };
    const judge = vi.fn(async (input: { candidates: { id: string }[] }) => input.candidates.map(item => ({ id: item.id, relevance: 0.9, sectionFit: 0.8, evidence: 0.7 })));
    const result = await createReferenceFanout({ search, judge }).fanout(request);
    expect(judge.mock.calls[0]![0].candidates).toHaveLength(1);
    expect(judge.mock.calls[0]![0].candidates[0]).toMatchObject({ source: 'Mobbin' });
    const blocked = result.references.find(item => item.resource.connectorId === 'refero')!;
    expect(blocked.score).toBeNull();
    expect(blocked.reasons.join(' ')).toMatch(/rights.*deterministic/i);
    expect(result.ranking.code).toBe('jev-rights-excluded');
  });
  it('uses one 45-second default deadline, stops scheduling searches, and returns captured partial results', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const search = vi.fn(async (source: 'refero' | 'mobbin', _request: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        if (source === 'refero') return searchResult(source, [resource(source, 'one')]);
        return new Promise<never>(() => undefined);
      });
      const pending = createReferenceFanout({ search }).fanout({ ...request, sections: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Section ${i}`, purpose: null })) });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.partial).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.references).toHaveLength(1);
      expect(result.sources.some(item => item.code === 'connector-timeout')).toBe(true);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(search.mock.calls.length).toBeLessThan(16);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('the configurable overall deadline includes Jev and preserves completed judgments', async () => {
    vi.useFakeTimers();
    try {
      let rankingSignal: AbortSignal | undefined;
      const search = async (source: 'refero' | 'mobbin') => {
        await new Promise(done => setTimeout(done, 20));
        return searchResult(source, [resource(source, 'one')]);
      };
      const judge = async (input: { candidates: { id: string }[] }, options: { signal: AbortSignal; onBatch?: (items: { id: string; relevance: number; sectionFit: number; evidence: number }[]) => void }) => {
        rankingSignal = options.signal;
        options.onBatch?.([{ id: input.candidates[0]!.id, relevance: 0.8, sectionFit: 0.8, evidence: 0.8 }]);
        return new Promise<never>(() => undefined);
      };
      const pending = createReferenceFanout({ search, judge, deadlineMs: 50 }).fanout(request);
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(rankingSignal?.aborted).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.ranking.status).toBe('partial');
      expect(result.references.some(item => item.score !== null)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
