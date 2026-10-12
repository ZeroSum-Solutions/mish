// `buildReportBody` (the fast-lane CLI's --report file) names Cult blocks by public id, like the
// published page and the daemon's snapshot.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReportBody } from '../src/cli-report.ts';
import type { RunReport } from '../src/run.ts';

test('buildReportBody: a composition names Cult blocks by public id and keeps other ids', () => {
  const report = {
    html: '<html></html>', recipe: {}, manifest: {}, approvedAssets: [],
    composition: { requested: 'blocks', used: 'blocks', blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-vite'], budgetDropped: ['cult:marketing-faq-vite'] },
  } as unknown as RunReport;
  const body = buildReportBody(report, 'strict', undefined) as { composition: { blocks: string[]; budgetDropped: string[] }; html?: string };
  assert.deepEqual(body.composition.blocks, ['hyperui:marketing/sections/1', 'cult:bento-series-vt']);
  assert.deepEqual(body.composition.budgetDropped, ['cult:faq-series-vt']);
  assert.equal(body.html, undefined);
});
