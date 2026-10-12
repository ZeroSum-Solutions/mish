// AC-R13.1 harness for AC-R13.2/R13.3: the frozen ledger plans one state-matrix batch per
// dependency family (one cold/warm browser run each), with per-ID probes for every expected
// state, viewport, reduced motion and WebGL fallback. Quarantined and reference-only rows stay
// visible as skipped with their reason; they are never planned as repairable or counted repaired.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseComponentLedger, planStateMatrix } from '@mish/contracts';

const ledger = parseComponentLedger(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../src/workbench/component-ledger.json'), 'utf8')));

describe('AC-R13 state-matrix plan', () => {
  it('plans every repair-pending or repaired (re-verified) row exactly once, batched by dependency family', () => {
    const plan = planStateMatrix(ledger);
    const planned = plan.batches.flatMap(batch => batch.items.map(item => item.id));
    const pending = ledger.rows.filter(row => row.disposition === 'repair-pending' || row.disposition === 'repaired').map(row => row.id);
    expect([...planned].sort()).toEqual([...pending].sort());
    for (const batch of plan.batches) {
      for (const item of batch.items) expect(ledger.rows.find(row => row.id === item.id)!.family).toBe(batch.family);
    }
    expect(new Set(plan.batches.map(batch => batch.family)).size).toBe(plan.batches.length);
  });

  it('keeps quarantined and reference-only rows visible as skipped, with their reasons', () => {
    const plan = planStateMatrix(ledger);
    const excluded = ledger.rows.filter(row => row.disposition === 'quarantined' || row.disposition === 'reference-only');
    expect(plan.skipped.map(item => item.id).sort()).toEqual(excluded.map(row => row.id).sort());
    for (const item of plan.skipped) expect(item.reason).toBeTruthy();
    expect(plan.summary).toMatchObject({ planned: ledger.rows.filter(row => row.disposition === 'repair-pending' || row.disposition === 'repaired').length, skipped: excluded.length, repaired: 0 });
  });

  it('probes every expected interaction state at every viewport, plus reduced motion and the WebGL fallback', () => {
    const plan = planStateMatrix(ledger);
    const shader = plan.batches.find(batch => batch.family === 'genui-webgl')!.items.find(item => item.id === 'genui:atc-shader')!;
    const row = ledger.rows.find(candidate => candidate.id === 'genui:atc-shader')!;
    for (const viewport of row.expectedStates.viewports) {
      expect(shader.probes).toContainEqual({ state: 'default', viewport, reducedMotion: false, webgl: true });
      expect(shader.probes).toContainEqual({ state: 'default', viewport, reducedMotion: true, webgl: true });
      expect(shader.probes).toContainEqual({ state: 'default', viewport, reducedMotion: false, webgl: false });
    }
    const hover = plan.batches.flatMap(batch => batch.items).find(item => item.id === 'genui:glare-hover')!;
    expect(hover.probes).toContainEqual({ state: 'hover', viewport: 390, reducedMotion: false, webgl: true });
    expect(hover.probes).toContainEqual({ state: 'focus-visible', viewport: 1280, reducedMotion: false, webgl: true });
    expect(hover.probes.some(probe => probe.state === 'reduced-motion' || probe.state === 'no-webgl-fallback')).toBe(false);
  });

  it('names the real preview route, or a preview gap that is itself a repair finding', () => {
    const items = planStateMatrix(ledger).batches.flatMap(batch => batch.items);
    expect(items.find(item => item.id === 'genui:glare-hover')).toMatchObject({ previewPath: '/api/genui/catalog/glare-hover/preview', previewGap: null });
    expect(items.find(item => item.id === '21st-dev:21st:efferd-dialog')).toMatchObject({ previewPath: '/api/21st/21st%3Aefferd-dialog/preview', previewGap: null });
    const hyperui = items.find(item => item.id === 'sections:hyperui:marketing/ctas/1')!;
    expect(hyperui).toMatchObject({ previewPath: null, previewGap: 'preview-adapter-missing' });
    expect(items.find(item => item.id === 'shadcn:button')).toMatchObject({ previewPath: null, previewGap: 'preview-adapter-missing' });
  });

  it('narrows to selected families without changing per-ID probes', () => {
    const all = planStateMatrix(ledger);
    const css = planStateMatrix(ledger, { families: ['genui-css'] });
    expect(css.batches.map(batch => batch.family)).toEqual(['genui-css']);
    expect(css.batches[0]).toEqual(all.batches.find(batch => batch.family === 'genui-css'));
  });
});
