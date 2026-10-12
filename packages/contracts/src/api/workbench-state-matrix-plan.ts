/**
 * AC-R13 state-matrix plan: turns the frozen component ledger into one browser batch per
 * dependency family (technical-spec: one cold/warm run per family, per-ID results kept).
 * Each planned ID gets one probe per expected interaction state and viewport, plus a reduced
 * motion probe and a no-WebGL probe where its state set requires them. Quarantined and
 * reference-only rows are listed as skipped with their reason, never planned or counted as
 * repaired. Pure planning only: `e2e/scripts/r13-state-matrix.ts` runs it against a supplied
 * loopback runtime, and the plan alone proves nothing about any component.
 */
import type { ComponentLedger, ComponentLedgerRow, ComponentState } from './workbench-component-ledger.js';

export interface StateMatrixProbe { state: ComponentState; viewport: number; reducedMotion: boolean; webgl: boolean }
export interface StateMatrixItem {
  id: string;
  title: string;
  sourceDigest: string | null;
  primaryAction: string;
  /** Same-origin daemon route serving the item's real preview, when one exists. */
  previewPath: string | null;
  /** A missing preview is itself an AC-R13.3 repair finding, not a skipped item. */
  previewGap: 'preview-adapter-missing' | null;
  probes: StateMatrixProbe[];
}
export interface StateMatrixBatch { family: string; nativeFormat: ComponentLedgerRow['nativeFormat']; items: StateMatrixItem[] }
export interface StateMatrixPlan {
  batches: StateMatrixBatch[];
  skipped: Array<{ id: string; disposition: ComponentLedgerRow['disposition']; reason: string }>;
  summary: { planned: number; skipped: number; repaired: number; previewGaps: number };
}

/** States that change how a probe runs rather than what it interacts with. */
const MODE_STATES: ReadonlySet<ComponentState> = new Set(['reduced-motion', 'no-webgl-fallback']);

function previewPath(row: ComponentLedgerRow): string | null {
  if (row.sourceId === 'genui' && row.family !== 'genui-unported') return `/api/genui/catalog/${encodeURIComponent(row.itemId)}/preview`;
  if (row.sourceId === '21st-dev' && row.family === '21st-owned-html') return `/api/21st/${encodeURIComponent(row.itemId)}/preview`;
  return null;
}

function probes(row: ComponentLedgerRow): StateMatrixProbe[] {
  const states = row.expectedStates.states;
  const result: StateMatrixProbe[] = [];
  for (const viewport of row.expectedStates.viewports) {
    for (const state of states) if (!MODE_STATES.has(state)) result.push({ state, viewport, reducedMotion: false, webgl: true });
    if (row.expectedStates.reducedMotion === 'required' || states.includes('reduced-motion')) result.push({ state: 'default', viewport, reducedMotion: true, webgl: true });
    if (states.includes('no-webgl-fallback')) result.push({ state: 'default', viewport, reducedMotion: false, webgl: false });
  }
  return result;
}

export function planStateMatrix(ledger: ComponentLedger, options: { families?: readonly string[] } = {}): StateMatrixPlan {
  const families = options.families ? new Set(options.families) : null;
  const batches = new Map<string, StateMatrixBatch>();
  const skipped: StateMatrixPlan['skipped'] = [];
  for (const row of ledger.rows) {
    if (families && !families.has(row.family)) continue;
    if (row.disposition === 'quarantined' || row.disposition === 'reference-only') {
      skipped.push({ id: row.id, disposition: row.disposition, reason: row.dispositionReason ?? row.disposition });
      continue;
    }
    const batch = batches.get(row.family) ?? { family: row.family, nativeFormat: row.nativeFormat, items: [] };
    batches.set(row.family, batch);
    const path = previewPath(row);
    batch.items.push({
      id: row.id, title: row.title, sourceDigest: row.sourceVersion.digest, primaryAction: row.expectedStates.primaryAction,
      previewPath: path, previewGap: path ? null : 'preview-adapter-missing', probes: probes(row),
    });
  }
  const ordered = [...batches.values()].sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  const items = ordered.flatMap(batch => batch.items);
  return {
    batches: ordered,
    skipped,
    summary: {
      planned: items.length, skipped: skipped.length,
      repaired: ledger.rows.filter(row => row.disposition === 'repaired' && (!families || families.has(row.family))).length,
      previewGaps: items.filter(item => item.previewGap).length,
    },
  };
}
