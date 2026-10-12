import { WORKBENCH_OBSERVED_BEHAVIORS, type ObservedBehavior, type ObservedBehaviorRecord, type VerificationEvidence } from '@open-design/contracts';
import type { CaptureAtWidth } from './evaluate.js';
import { ev, evidenceKey, evidenceSelector, list, PageText, readPageText, vocab, type EvidenceParam } from './evidence.js';
import type { ViewportCapture } from './types.js';

export const OBSERVED_BEHAVIORS_EVIDENCE_ID = 'observed-behaviors';
const MAX_SAMPLES = 10;
const TEXT_INPUT_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'searchbox']);

/**
 * What one capture says about a behavior: a count with samples, or null when
 * it cannot tell. The page probe reports every behavior; older or fake ports
 * without it fall back to the controls and actions they already captured, and
 * report dialogs, images and animation as unknown.
 */
function fromCapture(capture: ViewportCapture, behavior: ObservedBehavior): { count: number; samples: PageText[] } | null {
  const reported = capture.behaviors?.[behavior];
  if (reported !== undefined) return sanitized(behavior, reported);
  const controls = (match: (role: string) => boolean) => capture.controls.filter(control => match(readPageText(control.role))).map(control => control.selector);
  switch (behavior) {
    case 'tabs': { const found = controls(role => role === 'tab'); return { count: found.length, samples: found }; }
    case 'text-input': { const found = controls(role => TEXT_INPUT_ROLES.has(role)); return { count: found.length, samples: found }; }
    case 'button': { const found = controls(role => role === 'button'); return { count: found.length, samples: found }; }
    case 'form': { const found = capture.actions.filter(action => action.kind === 'form').map(action => action.selector); return { count: found.length, samples: found }; }
    default: return null;
  }
}

/**
 * The page can tamper with what the probe returns, so a report is data to
 * check: the count becomes a non-negative integer (anything else is unknown)
 * and only non-blank samples survive. W4: zero animations is unknown, never
 * absent, because getAnimations() cannot see GSAP or script-driven motion.
 */
function sanitized(behavior: ObservedBehavior, reported: { count: number; samples: PageText[] } | null): { count: number; samples: PageText[] } | null {
  if (!reported || typeof reported !== 'object') return null;
  const raw = reported.count as unknown;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const count = Math.max(0, Math.floor(raw));
  if (behavior === 'animation' && count === 0) return null;
  const samples = Array.isArray(reported.samples) ? reported.samples.filter(sample => sample instanceof PageText && !sample.isBlank()) : [];
  return { count, samples };
}

/**
 * AC-R06.5: behavior the frozen evidence observed, across every captured
 * width. Observed at any width wins; not-observed needs every width to have
 * been captured and to report zero; anything else is unknown. Evidence v2:
 * a sample is a structural selector, or the page-text token for anything
 * else (an id, a class, an animation name); page text is never stored.
 */
export function summarizeObservedBehaviors(captures: ReadonlyMap<number, CaptureAtWidth> | null): ObservedBehaviorRecord[] {
  return WORKBENCH_OBSERVED_BEHAVIORS.map(behavior => {
    const widths = captures ? [...captures] : [];
    let count = 0; let known = widths.length > 0; const viewports: number[] = []; const samples = new Map<string, EvidenceParam>();
    for (const [width, item] of widths) {
      if (!('capture' in item)) { known = false; continue; }
      const seen = fromCapture(item.capture, behavior);
      if (!seen) { known = false; continue; }
      if (seen.count > 0) {
        viewports.push(width); count = Math.max(count, seen.count);
        for (const sample of seen.samples) {
          if (samples.size >= MAX_SAMPLES) break;
          const param = evidenceSelector(sample);
          samples.set(evidenceKey(param), param);
        }
      }
    }
    if (count > 0) return { behavior, state: 'observed', count, viewports: viewports.sort((a, b) => a - b), samples: [...samples.values()] };
    return { behavior, state: known ? 'not-observed' : 'unknown', count: 0, viewports: [], samples: [] };
  });
}

/** The same summary as bundle evidence reviewers can cite (structured messages, evidence v2). */
export function observedBehaviorsEvidence(records: readonly ObservedBehaviorRecord[]): VerificationEvidence {
  const named = (state: ObservedBehaviorRecord['state']) => {
    const behaviors = records.filter(record => record.state === state).map(record => vocab('behavior', record.behavior));
    return behaviors.length ? list(behaviors) : ev('common.none');
  };
  return {
    id: OBSERVED_BEHAVIORS_EVIDENCE_ID, viewport: null, type: 'accessibility-tree',
    summary: ev('behavior.summary', named('observed'), named('unknown')),
    observations: records.map(record => record.count
      ? ev('behavior.recordSeen', vocab('behavior', record.behavior), vocab('behaviorState', record.state), record.count, list(record.viewports), list(record.samples.slice(0, 3)))
      : ev('behavior.record', vocab('behavior', record.behavior), vocab('behaviorState', record.state))),
  };
}
