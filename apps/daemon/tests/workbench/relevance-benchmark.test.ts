import { expect, it } from 'vitest';
import type { ResourceCandidate } from '@open-design/contracts';
import type { SectionCatalogSectionKind, SectionCatalogSpineCode } from '@open-design/contracts/api/section-catalog';
import {
  rankContextualResources, selectLexicalResources, summarizeTopFiveAcceptability,
  dedupeVariantGroups, isContinuousMotionDecoration, type RelevanceBenchmarkLabel,
} from '../../src/workbench/context-ranking.js';
import { candidate, savedContext } from './context-ranking-fixture.js';
import itemsFixture from '../fixtures/workbench/relevance/items.json' with { type: 'json' };
import queriesFixture from '../fixtures/workbench/relevance/queries.json' with { type: 'json' };
import labelsFixture from '../fixtures/workbench/relevance/labels.json' with { type: 'json' };

// AC-R05.3 harness (U3 scope). The full acceptance gate — a frozen ten-query/five-spine
// pool, independently labeled by two human raters, then checked for >=8/10 queries with
// 4+ acceptable results in the top five and contextual beating global on >=6/10 queries —
// stays open: it needs human labeling this unit cannot produce. What ships here is the
// reusable counting/grouping math (summarizeTopFiveAcceptability/dedupeVariantGroups) plus
// a fixture pool covering the AC-R05 preamble's required retro query and application-flow
// query, exercised against labels.json's explicitly-marked NOT-human-rated placeholder.

interface RelevanceItemFixture {
  id: string; title: string; category: ResourceCandidate['category'];
  sectionKind?: SectionCatalogSectionKind; spineAffinities?: ResourceCandidate['spineAffinities'];
  styleTags?: string[]; styleClass?: string; implementationOrigin?: string; variantGroup?: string;
}
interface RelevanceQueryFixture {
  id: string; type: 'application-flow' | 'retro' | 'standard'; query: string;
  context: { spineCode?: SectionCatalogSpineCode; styleDirection?: string; conversions: Array<{ id: string; kind: string; role: 'primary' | 'secondary'; label: string }> };
}
const items = itemsFixture.items as RelevanceItemFixture[];
const queries = queriesFixture.queries as RelevanceQueryFixture[];
const labels = labelsFixture.labels as Record<string, RelevanceBenchmarkLabel>;

function buildCandidates(): ResourceCandidate[] {
  return items.map(raw => candidate(raw.id, {
    title: raw.title, category: raw.category, sectionKind: raw.sectionKind, spineAffinities: raw.spineAffinities,
    styleTags: raw.styleTags, styleClass: raw.styleClass, implementationOrigin: raw.implementationOrigin, variantGroup: raw.variantGroup,
  }));
}
function queryById(id: string): RelevanceQueryFixture {
  const found = queries.find(query => query.id === id);
  if (!found) throw new Error(`Missing relevance fixture query: ${id}`);
  return found;
}
function buildContext(query: RelevanceQueryFixture) {
  return savedContext({
    spineCode: query.context.spineCode,
    styleDirection: query.context.styleDirection,
    conversions: query.context.conversions as never,
  });
}

it('ranks the required application-flow query (dentistry booking), grouping variants and excluding continuous-GPU/retro candidates by default', () => {
  const candidates = buildCandidates();
  const query = queryById('dentistry-booking');
  const context = buildContext(query);
  const contextual = rankContextualResources(candidates, query.query, context);
  expect(contextual).toMatchObject({ rankable: true, timedOut: false });
  expect(contextual.items.map(item => item.ref.itemId)).toEqual(['calendar-widget', 'booking-cta-band', 'hero-variant-b', 'hero-variant-a', 'intake-form', 'class-booking-calendar']);
  expect(contextual.items.every(item => item.fitReasons.length > 0)).toBe(true); // every result explains its own eligibility
  const summary = summarizeTopFiveAcceptability(query.id, 'contextual', contextual.items, labels[query.id]);
  expect(summary.topFive).toEqual(['calendar-widget', 'booking-cta-band', 'hero-variant-b', 'intake-form', 'class-booking-calendar']);
  expect(summary.acceptableInTopFive).toBe(5);
  // Two distinct owned-origin candidates that merely share implementationOrigin (no
  // variantGroup) are never collapsed: variant grouping keys strictly on variantGroup.
  expect(contextual.items.filter(item => item.implementationOrigin === 'owned-original').map(item => item.ref.itemId).sort()).toEqual(['booking-cta-band', 'calendar-widget', 'class-booking-calendar', 'intake-form']);
  const global = selectLexicalResources(candidates, query.query);
  expect(global.items).toEqual([]);
  const globalSummary = summarizeTopFiveAcceptability(query.id, 'global', global.items, labels[query.id]);
  expect(globalSummary.acceptableInTopFive).toBe(0);
  expect(summary.acceptableInTopFive).toBeGreaterThan(globalSummary.acceptableInTopFive);
});
it('ranks the required explicit retro query, surfacing retro-styleClass and continuous-GPU decoration candidates once intent is explicit', () => {
  const candidates = buildCandidates();
  const query = queryById('retro-arcade');
  const context = buildContext(query);
  const contextual = rankContextualResources(candidates, query.query, context);
  expect(contextual).toMatchObject({ rankable: true, timedOut: false });
  expect(contextual.items.map(item => item.ref.itemId)).toEqual(['particle-starfield-hero', 'react95-window-chrome', 'retro-arcade-marquee', 'windows95-form-kit']);
  expect(contextual.items.every(item => isContinuousMotionDecoration(item) || item.styleClass === 'retro')).toBe(true);
  const summary = summarizeTopFiveAcceptability(query.id, 'contextual', contextual.items, labels[query.id]);
  expect(summary.acceptableInTopFive).toBe(4);
  expect(selectLexicalResources(candidates, query.query).items).toEqual([]);
});
it('suppresses continuous-GPU decoration and retro-styleClass candidates by default across every non-retro query, in both modes', () => {
  const candidates = buildCandidates();
  for (const query of queries) {
    if (query.type === 'retro') continue;
    const context = buildContext(query);
    const contextual = dedupeVariantGroups(rankContextualResources(candidates, query.query, context).items).slice(0, 5);
    const global = dedupeVariantGroups(selectLexicalResources(candidates, query.query).items).slice(0, 5);
    for (const topFive of [contextual, global]) {
      const leaked = topFive.filter(item => isContinuousMotionDecoration(item) || item.styleClass === 'retro');
      expect(leaked).toEqual([]);
    }
  }
});
it('computes top-5 acceptable counts per query/mode from the labels file and flags it as NOT human-rated', () => {
  expect(labelsFixture.notHumanRated).toBe(true);
  const candidates = buildCandidates();
  const summaries = queries.map(query => {
    const context = buildContext(query);
    const contextual = rankContextualResources(candidates, query.query, context);
    const global = selectLexicalResources(candidates, query.query);
    const label = labels[query.id];
    return {
      queryId: query.id,
      contextual: summarizeTopFiveAcceptability(query.id, 'contextual', contextual.items, label),
      global: summarizeTopFiveAcceptability(query.id, 'global', global.items, label),
    };
  });
  for (const { contextual, global } of summaries) {
    for (const entry of [contextual, global]) {
      expect(entry.topFive.length).toBeLessThanOrEqual(5);
      expect(entry.acceptableInTopFive).toBeGreaterThanOrEqual(0);
      expect(entry.acceptableInTopFive).toBeLessThanOrEqual(entry.topFive.length);
    }
  }
  // AC-R05.3's formal gate ("contextual beats global on at least six of ten queries") needs
  // the frozen human-rated pool; this only checks the harness's comparison math on the two
  // hand-verified fixtures above, which are known wins for contextual mode.
  const contextualWins = summaries.filter(({ contextual, global }) => contextual.acceptableInTopFive > global.acceptableInTopFive).length;
  expect(contextualWins).toBeGreaterThanOrEqual(2);
});
