import { consoleRecord } from '../../src/workbench/review/page-text.js';
import { ev } from '../../src/workbench/review/evidence.js';
import { describe, expect, it } from 'vitest';
import { parseProjectRubric, parseVerificationBundle, WORKBENCH_MANDATORY_CRITERION_IDS, type ProjectRubric } from '@mish/contracts';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import type { ReviewBrowserPort, ViewportCapture } from '../../src/workbench/review/types.js';
import { knownGoodCapture, page, portFrom, resourceType, text, unavailablePort, url } from './review-capture-fixture.js';

const base = { projectId: 'p', entry: 'index.html', context: null, clock: () => new Date('2026-10-07T08:00:00.000Z'), newId: () => 'rv_test' } as const;
const byCriterion = (bundle: Awaited<ReturnType<typeof runMechanicalReview>>, id: string) => bundle.results.find(result => result.criterionId === id)!;

async function review(port: ReviewBrowserPort, rubric: ProjectRubric | null = null) {
  const bundle = await runMechanicalReview({ ...base, rubric, port });
  // Every bundle the runner produces is a valid contract record.
  return parseVerificationBundle(bundle);
}

describe('runMechanicalReview (AC-R06.2, AC-R06.4 runtime half)', () => {
  it('returns inconclusive with setup recovery, never a pass, when no capable browser worker exists', async () => {
    const bundle = await review(unavailablePort());
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.environment.worker).toBe('unavailable');
    expect(bundle.results.map(result => result.criterionId).sort()).toEqual([...WORKBENCH_MANDATORY_CRITERION_IDS].sort());
    for (const result of bundle.results) {
      expect(result.outcome).toBe('inconclusive');
      expect(text(result.recovery)).toMatch(/Chrome|Edge|Chromium/);
    }
  });

  it('passes a known-good page only when every mandatory check has evidence at all four core widths', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width)));
    expect(bundle.results.map(result => [result.criterionId, result.outcome])).toEqual(WORKBENCH_MANDATORY_CRITERION_IDS.map(id => [id, 'pass']));
    expect(bundle.viewports).toEqual([320, 375, 768, 1440]);
    expect(bundle.outcome).toBe('passed');
    expect(bundle.environment.worker).toBe('cdp-chromium');
  });

  it('fails a broken declared CTA', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.actions[0]!.destination = { kind: 'same-origin', status: 404 };
    })));
    expect(byCriterion(bundle, 'core.declared-actions').outcome).toBe('fail');
    expect(text(byCriterion(bundle, 'core.declared-actions').reason)).toMatch(/404/);
    expect(bundle.outcome).toBe('failed');
  });

  it('fails a page without a responsive viewport, which lays out wider than the device width', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => { if (width < 768) capture.document.layoutWidth = 980; })));
    expect(byCriterion(bundle, 'core.responsive-overflow').outcome).toBe('fail');
    expect(text(byCriterion(bundle, 'core.responsive-overflow').reason)).toMatch(/980/);
  });

  it('keeps a form that posts to an external destination inconclusive instead of passing it', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.actions[1]!.clickEffect = { target: 'same', domMutations: 0, navigated: true, submissionCaptured: false, externalBlocked: true, error: null };
    })));
    expect(byCriterion(bundle, 'core.declared-actions').outcome).toBe('inconclusive');
  });

  it('locates a declared conversion CTA, and fails when the declared target is absent', async () => {
    const rubric = parseProjectRubric({
      schema: 'workbench-rubric/1', projectId: 'p', revision: 2, updatedAt: '2026-10-07T07:00:00.000Z', contextRevision: 1,
      checks: [{ checkId: 'book-cta', kind: 'mechanical', required: true, severity: 'high', requiredBasis: { type: 'mandatory', criterionId: 'core.declared-actions' }, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' }, parameters: { type: 'cta', actionType: 'conversion', targets: [{ type: 'conversion', id: 'book' }], viewports: [320, 375, 768, 1440] }, evidenceTypes: ['probe'], sourceCriteria: [] }],
    });
    const context = { schema: 'workbench-context/1', projectId: 'p', revision: 1, updatedAt: '2026-10-07T07:00:00.000Z', purpose: null, audience: [], brandDirection: null, constraints: [], assumptions: [], factSources: [], conversions: [{ id: 'book', kind: 'booking', role: 'primary', label: 'Book now', target: 'book.html' }] } as never;
    let requested: unknown;
    const found = await runMechanicalReview({ ...base, rubric, context, port: portFrom((width, request) => { requested = request.targets; return knownGoodCapture(width, capture => { capture.actions[0]!.targetKeys = ['conversion:book']; }); }) });
    expect(requested).toEqual([{ key: 'conversion:book', label: 'Book now', href: 'book.html' }]);
    expect(found.results.find(result => result.checkId === 'book-cta')).toMatchObject({ outcome: 'pass', synthesized: false });
    expect(found.contextRevision).toBe(1);
    const missing = await runMechanicalReview({ ...base, rubric, context, port: portFrom(width => knownGoodCapture(width)) });
    expect(missing.results.find(result => result.checkId === 'book-cta')?.outcome).toBe('fail');
    expect(missing.outcome).toBe('failed');
    const undeclared = await runMechanicalReview({ ...base, rubric, context: null, port: portFrom(width => knownGoodCapture(width)) });
    expect(undeclared.results.find(result => result.checkId === 'book-cta')?.outcome).toBe('inconclusive');
  });

  it('fails a dead button whose click has no observable effect', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.actions.push({ ...capture.actions[0]!, selector: page('body > main > button'), kind: 'button', href: null, destination: null, inline: false, clickEffect: { target: 'same', domMutations: 0, navigated: false, submissionCaptured: false, externalBlocked: false, error: null } });
    })));
    expect(byCriterion(bundle, 'core.declared-actions').outcome).toBe('fail');
  });

  it('never verifies an activation the probe could not pin to the captured element (Sol round 9 BLOCK)', async () => {
    for (const target of ['relocated', 'ambiguous', 'missing'] as const) {
      const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
        // A working click on some other element must not count for this one.
        capture.actions.push({ ...capture.actions[0]!, selector: page('body > main > button'), kind: 'button', href: null, destination: null, inline: false, clickEffect: { target, domMutations: 3, navigated: false, submissionCaptured: false, externalBlocked: false, error: null } });
      })));
      expect(byCriterion(bundle, 'core.declared-actions').outcome, target).toBe('inconclusive');
      expect(text(byCriterion(bundle, 'core.declared-actions').reason), target).toMatch(/activation is unverified/u);
    }
  });

  it('61 distinct console errors fail the console check with evidence, not a parse error (Sol round 9 BLOCK)', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      for (let index = 0; index < 61; index++) capture.console.push(consoleRecord({ kind: 'console', text: page(`error ${index}`), source: null }));
    })));
    const check = byCriterion(bundle, 'core.console-resources');
    expect(check.outcome).toBe('fail');
    expect(bundle.console!.entries).toHaveLength(61);
    expect(text(check.reason)).toMatch(/320px: 61 console errors \(hashes /u);
    const listed = (bundle.evidence.find(item => item.id === `${check.checkId}@320`)!.observations[0] as { params: { kind: string; items?: unknown[] }[] }).params[1]!;
    expect(listed.items).toHaveLength(60);
  });

  it('fails overflow at 320 and records which width produced the evidence', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      if (width === 320) capture.document.scrollWidth = 412;
    })));
    const result = byCriterion(bundle, 'core.responsive-overflow');
    expect(result.outcome).toBe('fail');
    const evidence = bundle.evidence.filter(item => result.evidenceIds.includes(item.id) && item.viewport === 320);
    expect(evidence.length).toBeGreaterThan(0);
    expect(bundle.outcome).toBe('failed');
  });

  it('fails clipped content hidden inside a viewport-wide container even without document scrolling', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      if (width === 375) capture.clipped.push({ selector: page('div.cards'), scrollWidth: 520, clientWidth: 375, axis: 'x', targetKeys: [] });
    })));
    expect(byCriterion(bundle, 'core.responsive-overflow').outcome).toBe('fail');
  });

  it('fails low-contrast normal text at 4.5:1 while allowing 3:1 for large text', async () => {
    const low = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.texts.push({ selector: page('p.muted'), text: page('Muted copy'), color: [153, 153, 153, 1], background: [255, 255, 255, 1], fontSizePx: 16, fontWeight: 400, targetKeys: [] });
    })));
    expect(byCriterion(low, 'core.text-contrast').outcome).toBe('fail');
    const large = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.texts.push({ selector: page('h2.big'), text: page('Large heading'), color: [130, 130, 130, 1], background: [255, 255, 255, 1], fontSizePx: 32, fontWeight: 700, targetKeys: [] });
    })));
    expect(byCriterion(large, 'core.text-contrast').outcome).toBe('pass');
  });

  it('treats text over an undeterminable background as inconclusive, not a pass', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.texts.push({ selector: page('h1.hero'), text: page('Over a photo'), color: [255, 255, 255, 1], background: null, fontSizePx: 40, fontWeight: 700, targetKeys: [] });
    })));
    expect(byCriterion(bundle, 'core.text-contrast').outcome).toBe('inconclusive');
    expect(bundle.outcome).toBe('inconclusive');
  });

  it('keeps contrast inconclusive when the text probe stopped before measuring every text node', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => { capture.textsTruncated = true; })));
    const result = byCriterion(bundle, 'core.text-contrast');
    expect(result.outcome).toBe('inconclusive');
    expect(text(result.reason)).toMatch(/sample limit/i);
    expect(bundle.outcome).toBe('inconclusive');
  });

  it('marks every check inconclusive when a served file changes between viewport captures', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      if (width >= 768) capture.served = [{ path: 'index.html', sha256: 'b'.repeat(64) }];
    })));
    expect(bundle.outcome).toBe('inconclusive');
    for (const result of bundle.results) {
      expect(result.outcome).toBe('inconclusive');
      expect(text(result.reason)).toMatch(/source changed during capture/i);
      expect(text(result.recovery)).toBeTruthy();
    }
    expect(bundle.evidence.find(item => item.id === 'source-integrity')?.observations.map(text).join(' ')).toMatch(/index\.html/);
  });

  it('marks every check inconclusive with recovery when the review serving budget runs out', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      if (width === 1440) capture.servingLimit = ev('serve.requestLimit', 2000);
    })));
    expect(bundle.outcome).toBe('inconclusive');
    for (const result of bundle.results) {
      expect(result.outcome).toBe('inconclusive');
      expect(text(result.reason)).toMatch(/limit of 2000 requests served/);
      expect(text(result.recovery)).toMatch(/run the review again/i);
    }
  });

  it('fails a missing font as a broken resource', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.resources.push({ url: url('http://project.od-review.localhost/fonts/brand.woff2'), resourceType: resourceType('Font'), outcome: 'missing', status: 404 });
      capture.fonts.push({ family: page('Brand Sans'), status: 'error' });
    })));
    const result = byCriterion(bundle, 'core.console-resources');
    expect(result.outcome).toBe('fail');
    expect(text(result.reason)).toMatch(/font|fonts\/brand\.woff2/i);
  });

  it('fails console errors and keyboard traps, and missing visible focus', async () => {
    const consoleBundle = await review(portFrom(width => knownGoodCapture(width, capture => { capture.console.push(consoleRecord({ kind: 'console', text: page('TypeError: x is undefined'), source: null })); })));
    expect(byCriterion(consoleBundle, 'core.console-resources').outcome).toBe('fail');
    const trap = await review(portFrom(width => knownGoodCapture(width, capture => {
      capture.keyboard.steps = [{ selector: page('a#cta'), focusVisible: true }, { selector: page('input#email'), focusVisible: true }, { selector: page('input#email'), focusVisible: true }, { selector: page('input#email'), focusVisible: true }];
    })));
    expect(byCriterion(trap, 'core.keyboard-focus').outcome).toBe('fail');
    const invisible = await review(portFrom(width => knownGoodCapture(width, capture => { capture.keyboard.steps[0]!.focusVisible = false; })));
    expect(byCriterion(invisible, 'core.keyboard-focus').outcome).toBe('fail');
  });

  it('fails unnamed controls and skipped heading levels', async () => {
    const unnamed = await review(portFrom(width => knownGoodCapture(width, capture => { capture.controls.push({ selector: page('button.icon'), role: page('button'), name: page('') }); })));
    expect(byCriterion(unnamed, 'core.document-semantics').outcome).toBe('fail');
    const skipped = await review(portFrom(width => knownGoodCapture(width, capture => { capture.headings.push({ level: 4, text: page('Deep') }); })));
    expect(byCriterion(skipped, 'core.document-semantics').outcome).toBe('fail');
  });

  it('is inconclusive when the worker cannot capture one required width', async () => {
    const bundle = await review(portFrom(width => { if (width === 768) throw new Error('renderer crashed'); return knownGoodCapture(width); }));
    expect(bundle.outcome).toBe('inconclusive');
    for (const result of bundle.results) expect(result.outcome).toBe('inconclusive');
  });

  it('still runs a mandatory check the project rubric omits and cannot pass while required manual checks are open', async () => {
    const rubric = parseProjectRubric({
      schema: 'workbench-rubric/1', projectId: 'p', revision: 3, updatedAt: '2026-10-07T07:00:00.000Z', contextRevision: 1,
      checks: [
        { checkId: 'device', kind: 'manual', required: true, severity: 'high', requiredBasis: { type: 'project-acceptance', requirementId: 'device-check', rationale: 'Owner needs a phone pass' }, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' }, parameters: { type: 'manual-procedure', procedure: 'Open on an iPhone', environment: 'iOS Safari' }, evidenceTypes: ['manual-observation'], sourceCriteria: [] },
      ],
    });
    const bundle = await review(portFrom(width => knownGoodCapture(width)), rubric);
    expect(bundle.rubricRevision).toBe(3);
    expect(bundle.results.map(result => result.criterionId).sort()).toEqual([...WORKBENCH_MANDATORY_CRITERION_IDS].sort());
    expect(bundle.unresolvedRequiredChecks).toEqual(['device']);
    expect(bundle.outcome).toBe('inconclusive');
  });

  it('keeps an optional failing check visible without failing the page', async () => {
    const rubric = parseProjectRubric({
      schema: 'workbench-rubric/1', projectId: 'p', revision: 1, updatedAt: '2026-10-07T07:00:00.000Z', contextRevision: 1,
      checks: [{ checkId: 'hero-overflow', kind: 'mechanical', required: false, severity: 'low', requiredBasis: null, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' }, parameters: { type: 'overflow', targets: [{ type: 'selector', selector: '.hero' }], viewports: [320, 375, 768, 1440, 1920] }, evidenceTypes: ['probe'], sourceCriteria: [] }],
    });
    const bundle = await review(portFrom(width => knownGoodCapture(width, capture => {
      if (width === 1920) capture.clipped.push({ selector: page('.hero p'), scrollWidth: 2100, clientWidth: 1920, axis: 'x', targetKeys: ['selector:.hero'] });
    })), rubric);
    expect(bundle.viewports).toEqual([320, 375, 768, 1440, 1920]);
    expect(bundle.results.find(result => result.checkId === 'hero-overflow')?.outcome).toBe('fail');
    expect(bundle.outcome).toBe('passed');
  });

  it('records the served source hashes and the evidence origin', async () => {
    const bundle = await review(portFrom(width => knownGoodCapture(width)));
    expect(bundle.sourceHashes).toEqual([{ path: 'book.html', sha256: 'b'.repeat(64) }, { path: 'index.html', sha256: 'a'.repeat(64) }]);
    expect(bundle.previewOrigin).toBe('http://project.od-review.localhost');
  });
});

describe('port contract', () => {
  it('fake captures satisfy the capture type', () => {
    const capture: ViewportCapture = knownGoodCapture(320);
    expect(capture.width).toBe(320);
  });
});
