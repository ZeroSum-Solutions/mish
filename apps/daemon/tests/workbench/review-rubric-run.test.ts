import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReviewRunView, type ProjectDesignContext, type ProjectRubric, type ReviewRunView } from '@mish/contracts';
import { checklistRubricCheck } from '../../src/workbench/review/checklist-criteria.js';
import { PageText } from '../../src/workbench/review/evidence.js';
import { knownGoodCapture } from './review-capture-fixture.js';
import { ReviewerCallError } from '../../src/workbench/review/reviewers/types.js';
import { bootReviewRuns, fakeReviewer, PNG_BASE64 } from './review-run-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function boot(options: Parameters<typeof bootReviewRuns>[0] = {}) {
  const daemon = await bootReviewRuns(options);
  cleanups.push(async () => { await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); });
  return daemon;
}
const allThree = () => ({ 'jev-text': fakeReviewer('jev-text', { probability: 0.9 }), 'claude-visual': fakeReviewer('claude-visual', { refs: 'screenshots' }), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') });
const at = '2026-10-08T09:00:00.000Z';
const STYLE = 'Windows 95 desktop: bevelled grey chrome and pixel fonts';
function context(): ProjectDesignContext {
  return {
    schema: 'workbench-context/1', projectId: 'p', revision: 1, updatedAt: at, purpose: null, audience: [], conversions: [], brandDirection: null, styleDirection: STYLE,
    constraints: [], factSources: [{ fieldPath: '/styleDirection', value: STYLE, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Owner asked' }], assumptions: ['Purpose unknown'],
  };
}
type RubricCheck = ProjectRubric['checks'][number];
function rubricWith(checks: RubricCheck[]): ProjectRubric { return { schema: 'workbench-rubric/1', projectId: 'p', revision: 4, updatedAt: at, contextRevision: 1, checks }; }

async function finished(daemon: Awaited<ReturnType<typeof boot>>, body: Record<string, unknown> = {}) {
  const response = await daemon.start(body);
  if (response.status !== 202) throw new Error(`start answered ${response.status}: ${await response.text()}`);
  const started = parseReviewRunView(await response.json());
  await daemon.runs.idle();
  return daemon.show(started.run.id);
}
async function cliShow(daemon: Awaited<ReturnType<typeof boot>>, runId: string): Promise<{ code: number; view: ReviewRunView }> {
  daemon.output.length = 0;
  const code = await daemon.cli(['show', '--project', 'p', '--run', runId, '--json']);
  return { code, view: parseReviewRunView(daemon.output[0]) };
}

describe('AC-R06.3 seeded judgment criteria through the R03 reviewer lanes', () => {
  it('AC-R06.3: the seven seeded judgments and the style-direction check reach every reviewer lane with their evidence contract; verdicts match over HTTP and od', async () => {
    const reviewers = allThree();
    const daemon = await boot({ reviewers });
    daemon.state.context = context();
    daemon.state.rubric = rubricWith([]);
    const { run } = await finished(daemon);

    expect(run.frozen.plan.judgmentCheckIds).toEqual(expect.arrayContaining(['judgment.hierarchy', 'judgment.specificity', 'judgment.repetition', 'judgment.typography', 'judgment.layout', 'judgment.motion', 'judgment.goal-fit', 'judgment.style-direction']));
    expect(run.frozen.rubricContent).toEqual({ judgmentSeeds: 'judgment-seeds/1', checklistCriteria: 'checklist-criteria/1', checklistSource: { sourceId: 'design-system-checklist', revisionOrDigest: '28f06a284d010ddb4dc1f68e7c92720ce734310a' } });

    for (const lane of Object.values(reviewers)) {
      const hierarchy = lane.calls[0]!.checks.find(check => check.checkId === 'judgment.hierarchy')!;
      expect(hierarchy.kind).toBe('judgment');
      expect(hierarchy.criterion).toContain(STYLE);
      expect(hierarchy.contract?.lookFor.length).toBeGreaterThan(0);
      // Behavior the evidence could not observe is not judged as if it were there.
      expect(lane.calls[0]!.checks.some(check => check.checkId === 'judgment.motion')).toBe(false);
    }

    const verdicts = new Map(run.checkVerdicts!.map(verdict => [verdict.checkId, verdict]));
    expect(verdicts.get('judgment.hierarchy')).toMatchObject({ status: 'judged', origin: 'judgment-seed', required: false, reviewerAnswers: { supports: 3, disputes: 0, uncertain: 0 } });
    expect(verdicts.get('judgment.motion')).toMatchObject({ status: 'inconclusive', applicability: { status: 'undetermined', basis: 'unknown' } });
    expect(verdicts.get('core.text-contrast')).toMatchObject({ status: 'pass', origin: 'mandatory-default' });
    expect(run.outcome).toBe('passed');

    const cli = await cliShow(daemon, run.id);
    expect(cli.code).toBe(0);
    expect(cli.view.run.checkVerdicts).toEqual(run.checkVerdicts);
    expect(cli.view.run.frozen.rubricContent).toEqual(run.frozen.rubricContent);
  });
});

describe('AC-R06.4 runtime verdicts at the run level', () => {
  it('AC-R06.4: an open required manual check blocks passed, and every surface says why', async () => {
    const daemon = await boot({ reviewers: allThree() });
    daemon.state.rubric = rubricWith([{
      checkId: 'device-pass', kind: 'manual', required: true, severity: 'high', requiredBasis: { type: 'project-acceptance', requirementId: 'device', rationale: 'Owner requires a phone pass' },
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked' }, evidenceTypes: ['manual-observation'], sourceCriteria: [],
      parameters: { type: 'manual-procedure', procedure: 'Book on an iPhone SE with VoiceOver', environment: 'iOS Safari' },
    }]);
    const { run } = await finished(daemon);
    expect(run.outcome).toBe('inconclusive');
    expect(run.frozen.plan.manualCheckIds).toContain('device-pass');
    expect(run.checkVerdicts!.find(verdict => verdict.checkId === 'device-pass')).toMatchObject({ status: 'awaiting-manual', required: true });
    expect(run.reasons.map(reason => reason.code)).toContain('required-checks-unresolved');
    const cli = await cliShow(daemon, run.id);
    expect(cli.view.run.checkVerdicts).toEqual(run.checkVerdicts);
    // Captain decision 3: od says plainly why the run cannot pass, in the run and in its help.
    expect(cli.view.run.reasons.find(reason => reason.code === 'required-checks-unresolved')?.message).toMatch(/cannot pass until a person accepts.*no acceptance flow yet/isu);
    daemon.output.length = 0;
    await daemon.cli(['--help']);
    // U2-1: the help now describes the advisory accept/dismiss flow; it still says why such a run cannot pass.
    expect(JSON.stringify(daemon.output[0])).toMatch(/open required judgment or manual check stays inconclusive/iu);
  });

  it('AC-R06.4: a required mechanical check the browser could not evidence keeps the run from passing even when every reviewer supports it', async () => {
    const daemon = await boot({ reviewers: allThree(), capture: width => knownGoodCapture(width, item => { item.served = [{ path: 'index.html', sha256: 'pending' }]; item.screenshotPng = PNG_BASE64; item.textsTruncated = true; }) });
    const { run } = await finished(daemon);
    expect(run.checkVerdicts!.find(verdict => verdict.checkId === 'core.text-contrast')).toMatchObject({ status: 'inconclusive', reviewerAnswers: { supports: 3 } });
    expect(run.outcome).toBe('inconclusive');
  });
});

describe('AC-R06.5 checklist criteria applied to the frozen evidence', () => {
  it('AC-R06.5: an observed dialog makes the modal checks applicable; a declared not-applicable dialog fails the required check', async () => {
    const daemon = await boot({
      reviewers: allThree(),
      capture: width => knownGoodCapture(width, item => {
        item.served = [{ path: 'index.html', sha256: 'pending' }]; item.screenshotPng = PNG_BASE64;
        item.behaviors = { dialog: { count: 1, samples: [PageText.of('body > dialog')] }, tabs: { count: 0, samples: [] }, image: { count: 0, samples: [] }, animation: { count: 0, samples: [] } };
      }),
    });
    const adopted = checklistRubricCheck('dsc.modal-keyboard');
    daemon.state.rubric = rubricWith([{
      ...adopted, required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'booking-dialog', rationale: 'Booking opens a dialog' },
      provenance: { origin: 'user-confirmed', derivation: 'source-criterion', source: null, rationale: 'Adopted from the checklist' },
      applicability: { status: 'not-applicable', targetScope: 'index.html', rationale: 'We think there is no dialog', evaluator: 'owner' },
    } as RubricCheck]);
    const { run } = await finished(daemon);

    const bundle = await (await fetch(`${daemon.url}/api/workbench/projects/p/review/bundles/${run.bundleId}`, { headers: { 'x-od-project-id': 'p' } })).json() as { observedBehaviors: { behavior: string; state: string }[] };
    expect(bundle.observedBehaviors.find(item => item.behavior === 'dialog')).toMatchObject({ state: 'observed' });
    expect(bundle.observedBehaviors.find(item => item.behavior === 'tabs')).toMatchObject({ state: 'not-observed' });

    const verdicts = new Map(run.checkVerdicts!.map(verdict => [verdict.checkId, verdict]));
    expect(verdicts.get('dsc.modal-keyboard')).toMatchObject({ status: 'fail', required: true, applicability: { basis: 'mismatch', behaviors: ['dialog'] } });
    expect(verdicts.get('dsc.overlay-order')).toMatchObject({ applicability: { status: 'applicable', basis: 'observed' } });
    // Captain decision 1: criteria apply only where behavior was observed or the rubric adopted them.
    expect(verdicts.has('dsc.tabs-keyboard')).toBe(false);
    expect(verdicts.has('dsc.color-contrast')).toBe(false);
    expect(verdicts.get('dsc.button-role-focus')).toMatchObject({ status: 'pass', mechanicalCheckId: 'core.keyboard-focus', applicability: { basis: 'observed' }, sourceCriteria: [expect.objectContaining({ criterionId: 'c-button-a11y-role', revisionOrDigest: '28f06a284d010ddb4dc1f68e7c92720ce734310a' }), expect.objectContaining({ criterionId: 'c-button-a11y-focus' })] });
    expect(run.outcome).toBe('failed');
    expect(run.reasons.find(reason => reason.code === 'mandatory-check-failed')?.message).toContain('dsc.modal-keyboard');
  });

  it('AC-R06.5: a newer criteria version marks an earlier run outdated instead of silently re-reading it; the stored rubric is untouched', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const rubric = rubricWith([checklistRubricCheck('dsc.field-errors') as RubricCheck]);
    daemon.state.rubric = rubric;
    const before = structuredClone(rubric);
    const { run } = await finished(daemon);
    expect(daemon.state.rubric).toEqual(before);
    expect((await daemon.show(run.id)).freshness.state).toBe('current');

    // Simulate a run recorded under an earlier criteria version.
    const runs = path.join(daemon.data, 'workbench-review', 'runs');
    const file = path.join(runs, (await readdir(runs, { recursive: true })).map(String).find(name => name.endsWith(`${run.id}.json`))!);
    const stored = JSON.parse(await readFile(file, 'utf8')) as typeof run;
    stored.frozen.rubricContent = { ...stored.frozen.rubricContent!, checklistCriteria: 'checklist-criteria/0' };
    await writeFile(file, JSON.stringify(stored));
    const view = await daemon.show(run.id);
    expect(view.freshness.state).toBe('outdated');
    expect(view.freshness.reasons.join(' ')).toMatch(/checklist criteria are now checklist-criteria\/1 \(reviewed checklist-criteria\/0\)/u);
    expect(view.run.checkVerdicts).toEqual(run.checkVerdicts);
  });
});

describe('AC-R03.2 per-run reviewer choice and the two-reviewer rule', () => {
  it('AC-R03.2: one chosen reviewer cannot close the scope; HTTP and od show the count, the reason and the open judgments', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const { run } = await finished(daemon, { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }] } });
    expect(run.frozen.plan.reviewers).toEqual([{ role: 'jev-text', required: true }]);
    expect(run.completedIndependentReviewers).toBe(1);
    expect(run.outcome).toBe('inconclusive');
    expect(run.reasons.map(reason => reason.code)).toContain('fewer-than-two-independent-reviewers');
    // Captain decision 2: the optional judgment is unreviewed; the run is inconclusive only through the run-level rule.
    expect(run.checkVerdicts!.find(verdict => verdict.checkId === 'judgment.hierarchy')).toMatchObject({ status: 'unreviewed', reviewerAnswers: { supports: 1 } });
    expect(run.incompleteCheckIds).not.toContain('judgment.hierarchy');

    daemon.output.length = 0;
    const input = JSON.stringify({ snapshot: { entry: 'index.html' }, rubricRevision: daemon.state.rubric!.revision, reviewerPlan: { reviewers: [{ role: 'deepseek-adversarial', required: true }] } });
    const code = await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--wait', '--json'], input);
    expect(code).toBe(5);
    const view = parseReviewRunView(daemon.output.at(-1));
    expect(view.run.reasons.map(reason => reason.code)).toContain('fewer-than-two-independent-reviewers');
  });

  it('captain decision 1: 30 applicable checks are chunked so no Jev call exceeds its 24-item limit, and every check is answered', async () => {
    const jev = { ...fakeReviewer('jev-text'), maxChecks: 24 };
    const sizes: number[] = [];
    const review = jev.review.bind(jev);
    jev.review = async (input, signal) => { sizes.push(input.checks.length); return review(input, signal); };
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    // 6 mandatory mechanical + 6 applicable seeds (motion is unknown here) + 2 checklist judgments (button, text input observed) + 16 rubric judgments = 30.
    daemon.state.rubric = rubricWith(Array.from({ length: 16 }, (_, index) => ({
      checkId: `owner-judgment-${index}`, kind: 'judgment', required: false, severity: 'low', requiredBasis: null,
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked' }, evidenceTypes: ['judgment-rationale'], sourceCriteria: [],
      parameters: { type: 'criterion', criterion: `Owner criterion ${index}` },
    }) as RubricCheck));
    const { run } = await finished(daemon, { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } });
    const record = run.reviewers.find(reviewer => reviewer.role === 'jev-text')!;
    expect(record.assignedCheckIds).toHaveLength(30);
    expect(sizes).toEqual([24, 6]);
    expect(sizes.every(size => size <= 24)).toBe(true);
    expect(record).toMatchObject({ status: 'completed', unansweredCheckIds: [] });
    expect(run.findings.filter(finding => finding.reviewerRole === 'jev-text')).toHaveLength(30);
    expect(run.outcome).toBe('passed');
  });

  it('AC-R03.2: two completed reviewers close the scope', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const { run } = await finished(daemon, { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } });
    expect(run.completedIndependentReviewers).toBe(2);
    expect(run.outcome).toBe('passed');
    expect(run.checkVerdicts!.find(verdict => verdict.checkId === 'judgment.hierarchy')).toMatchObject({ status: 'judged', reviewerAnswers: { supports: 2 } });
  });

  it('AC-R03.2: od refuses every implementation-only lane by name before any run starts', async () => {
    const daemon = await boot({ reviewers: allThree() });
    for (const role of ['grok', 'grok-architecture']) {
      daemon.output.length = 0;
      const code = await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--json'], JSON.stringify({ snapshot: { entry: 'index.html' }, rubricRevision: 2, reviewerPlan: { reviewers: [{ role, required: true }] } }));
      expect(code).toBe(2);
      expect(JSON.stringify(daemon.output[0])).toMatch(/implementation review only/u);
    }
    expect(await daemon.runs.list('p')).toEqual([]);
  });
});

const ownerJudgments = (count: number): RubricCheck[] => Array.from({ length: count }, (_, index) => ({
  checkId: `owner-judgment-${index}`, kind: 'judgment', required: false, severity: 'low', requiredBasis: null,
  provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked' }, evidenceTypes: ['judgment-rationale'], sourceCriteria: [],
  parameters: { type: 'criterion', criterion: `Owner criterion ${index}` },
}) as RubricCheck);
async function storedRunFile(daemon: Awaited<ReturnType<typeof boot>>, runId: string): Promise<string> {
  const runs = path.join(daemon.data, 'workbench-review', 'runs');
  return path.join(runs, (await readdir(runs, { recursive: true })).map(String).find(name => name.endsWith(`${runId}.json`))!);
}

describe('B5-1 lens findings', () => {
  it('W1: a probe sample that is empty (a root-level animation) never fails the run', async () => {
    const daemon = await boot({
      reviewers: allThree(),
      capture: width => knownGoodCapture(width, item => {
        item.served = [{ path: 'index.html', sha256: 'pending' }]; item.screenshotPng = PNG_BASE64;
        item.behaviors = { animation: { count: 1, samples: [PageText.of('')] }, dialog: { count: -1, samples: [PageText.of('')] } };
      }),
    });
    const { run } = await finished(daemon);
    expect(run.operation.status).toBe('done');
    expect(run.bundleId).toMatch(/^rv_/u);
  });

  it('W3: a rubric at its 100-check cap of judgments still starts and finishes', async () => {
    const daemon = await boot({ reviewers: allThree() });
    daemon.state.rubric = rubricWith(ownerJudgments(100));
    const { run } = await finished(daemon);
    expect(run.operation.status).toBe('done');
    expect(run.frozen.plan.judgmentCheckIds.length).toBeGreaterThan(100);
    expect(run.outcome).toBe('passed');
  });

  it('W3: a plan larger than the run record can hold is refused up front with a field error, never a 500', async () => {
    const daemon = await boot({ reviewers: allThree() });
    // Bypasses the rubric contract on purpose: the daemon must still answer with a field error.
    daemon.state.rubric = rubricWith(ownerJudgments(130));
    const response = await daemon.start({});
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { message: string; details?: { reason?: string; fields?: { path: string; message: string }[] } } };
    expect(body.error.details?.reason).toBe('plan-too-large');
    expect(body.error.details?.fields?.[0]?.path).toBe('rubricRevision');
    expect(body.error.details?.fields?.[0]?.message).toMatch(/at most \d+ checks/u);
    expect(await daemon.runs.list('p')).toEqual([]);
  });

  it('W5: a reviewer with no applicable checks is skipped without a call or a billed call', async () => {
    const reviewers = allThree();
    const daemon = await boot({ reviewers, limits: { dailyBilledCalls: 1 } });
    // Motion is unknown in this evidence, so the scope leaves nothing to review.
    const { run } = await finished(daemon, { scope: { kind: 'checks', checkIds: ['judgment.motion'] } });
    for (const lane of Object.values(reviewers)) expect(lane.calls).toHaveLength(0);
    for (const record of run.reviewers.filter(item => item.role !== 'gemini-second-family')) expect(record).toMatchObject({ status: 'skipped', assignedCheckIds: [], reason: expect.stringMatching(/no applicable checks/iu) });
    // The one billed call of the day is still available.
    const next = await finished(daemon, { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }] } });
    expect(next.run.reviewers[0]!.status).toBe('completed');
  });

  it('W6: with a daily limit of 1, a 30-check Jev review that needs 2 calls is skipped up front with no call, and the reason gives both numbers', async () => {
    const jev = { ...fakeReviewer('jev-text'), maxChecks: 24 };
    const claude = fakeReviewer('claude-visual', { refs: 'screenshots' });
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'claude-visual': claude }, limits: { dailyBilledCalls: 1 } });
    daemon.state.rubric = rubricWith(ownerJudgments(16));
    const { run } = await finished(daemon, { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] } });
    const record = run.reviewers.find(reviewer => reviewer.role === 'jev-text')!;
    expect(jev.calls).toHaveLength(0);
    expect(record.status).toBe('skipped');
    expect(record.assignedCheckIds).toHaveLength(30);
    expect(record.reason).toMatch(/needs 2 billed calls; 1 remain/u);
    expect(claude.calls).toHaveLength(1);
  });

  it('NIT: a failed first call does not consume the billed calls of the chunks it never made', async () => {
    const failing = { ...fakeReviewer('jev-text', { error: new ReviewerCallError('Jev answered HTTP 500', 'Run the review again later.') }), maxChecks: 24 };
    const daemon = await boot({ reviewers: { 'jev-text': failing, 'claude-visual': fakeReviewer('claude-visual', { refs: 'screenshots' }) }, limits: { dailyBilledCalls: 3 } });
    daemon.state.rubric = rubricWith(ownerJudgments(16));
    const plan = { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] } };
    const first = await finished(daemon, plan);
    expect(first.run.reviewers.find(reviewer => reviewer.role === 'jev-text')!.status).toBe('failed');
    expect(failing.calls).toHaveLength(1);
    // One billed call was made, so two remain: enough for the next 2-call review, which then fails again on its first call.
    const second = await finished(daemon, plan);
    expect(second.run.reviewers.find(reviewer => reviewer.role === 'jev-text')!.status).toBe('failed');
    const third = await finished(daemon, plan);
    expect(third.run.reviewers.find(reviewer => reviewer.role === 'jev-text')!.reason).toMatch(/needs 2 billed calls; 1 remain/u);
  });

  it('billing: after a restart, today\'s billed-call count includes every call of a split reviewer', async () => {
    const plan = { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] } };
    const jev = { ...fakeReviewer('jev-text'), maxChecks: 24 };
    const before = await boot({ reviewers: { 'jev-text': jev, 'claude-visual': fakeReviewer('claude-visual', { refs: 'screenshots' }) }, limits: { dailyBilledCalls: 3 } });
    before.state.rubric = rubricWith(ownerJudgments(16));
    const first = await finished(before, plan);
    expect(jev.calls).toHaveLength(2);
    expect(first.run.reviewers.find(reviewer => reviewer.role === 'jev-text')).toMatchObject({ status: 'completed', providerCalls: 2 });
    await before.close();

    // Restart: a new service over the same data root rebuilds today's count from the stored records.
    const restartedJev = { ...fakeReviewer('jev-text'), maxChecks: 24 };
    const after = await boot({ dataDir: before.data, reviewers: { 'jev-text': restartedJev, 'claude-visual': fakeReviewer('claude-visual', { refs: 'screenshots' }) }, limits: { dailyBilledCalls: 3 } });
    after.state.rubric = rubricWith(ownerJudgments(16));
    const second = await finished(after, plan);
    expect(restartedJev.calls).toHaveLength(0);
    expect(second.run.reviewers.find(reviewer => reviewer.role === 'jev-text')!.reason).toMatch(/needs 2 billed calls; 1 remain/u);
  });

  it('NIT: a run frozen before rubric-content versions existed reads outdated', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const { run } = await finished(daemon);
    const file = await storedRunFile(daemon, run.id);
    const stored = JSON.parse(await readFile(file, 'utf8')) as typeof run;
    delete stored.frozen.rubricContent;
    await writeFile(file, JSON.stringify(stored));
    const view = await daemon.show(run.id);
    expect(view.freshness.state).toBe('outdated');
    expect(view.freshness.reasons.join(' ')).toMatch(/predates the judgment seeds and checklist criteria/u);
  });
});
