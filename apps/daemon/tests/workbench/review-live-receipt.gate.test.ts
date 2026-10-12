// AC-R03.4 "a live review receipt proves each enabled provider route".
//
// GATE ONLY — never routine CI. Skipped unless OD_REVIEW_LIVE_RECEIPTS names the
// roles to prove (comma list of jev-text, claude-visual, deepseek-adversarial).
// One review run, one call per named provider route, never a loop: Jev billing
// is still unmeasured and DeepSeek is metered. Uses the production composition
// (createProductionReviewRuns) with the daemon's own key store and vault path.
// The browser is the real CDP worker when OD_REVIEW_LIVE_BROWSER=1 (gate box);
// otherwise a fixture capture with a real PNG (OD_REVIEW_LIVE_PNG) stands in.
// OD_REVIEW_LIVE_RECEIPT_FILE, when set, receives the receipt JSON (no secrets).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, vaultSecret } from '@mish/agency-fast-lane/deepseek';
import { WORKBENCH_REVIEWER_ROLES, type ProjectRubric, type ReviewerRole } from '@mish/contracts';
import { jevKeyResolver } from '../../src/routes/design-index.js';
import { createAgencyJevKeyStore } from '../../src/storage/agency-config.js';
import { createProductionReviewRuns } from '../../src/workbench/review/production.js';
import { createWorkbenchReviewService } from '../../src/workbench/review/service.js';
import { knownGoodCapture, portFrom } from './review-capture-fixture.js';
import { PNG_BASE64, rubric, sha256 } from './review-run-fixture.js';

const roles = (process.env.OD_REVIEW_LIVE_RECEIPTS ?? '').split(',').map(role => role.trim()).filter(Boolean) as ReviewerRole[];

describe.skipIf(roles.length === 0)('AC-R03.4 live review receipts (gate only)', () => {
  it('one review run makes one real call per named provider route and records a non-fabricated reviewer record', async () => {
    expect(roles.every(role => (WORKBENCH_REVIEWER_ROLES as readonly string[]).includes(role))).toBe(true);
    const data = await mkdtemp(path.join(tmpdir(), 'od-review-live-'));
    try {
      const root = path.join(data, 'project');
      const html = '<!doctype html><html lang="en"><title>Win95</title><body style="background:#008080"><main style="background:#c0c0c0;border:2px outset #fff"><h1>Book a visit</h1><a id="cta" href="#book">Book now</a></main></body></html>';
      await (await import('node:fs/promises')).mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'index.html'), html);
      const png = process.env.OD_REVIEW_LIVE_PNG ? (await readFile(process.env.OD_REVIEW_LIVE_PNG)).toString('base64') : PNG_BASE64;
      const projectRubric: ProjectRubric = rubric(1);
      const projectInputs = () => ({ root, context: null, rubric: projectRubric });
      const mechanical = createWorkbenchReviewService({
        dataDir: data, projectInputs,
        ...(process.env.OD_REVIEW_LIVE_BROWSER === '1' ? {} : { createPort: () => portFrom(width => knownGoodCapture(width, item => { item.served = [{ path: 'index.html', sha256: sha256(html) }]; item.screenshotPng = png; })) }),
      });
      const keys = createAgencyJevKeyStore({ dataDir: data, readVaultSecret: () => vaultSecret('typesafe_api_key'), readModelVaultSecret: provider => vaultSecret(provider === 'openrouter' ? 'openrouter_api_key' : PROVIDERS[provider].vaultKeyId) });
      const runs = createProductionReviewRuns({
        dataDir: data, projectsRoot: data, mechanical, projectInputs,
        project: () => ({ root, metadata: {} }),
        jevApiKey: jevKeyResolver(() => keys.resolveKey()), keys,
      });
      const started = await runs.start({ projectId: 'receipt', snapshot: { entry: 'index.html', versionId: null }, scope: { kind: 'checks', checkIds: ['win95-style'] }, rubricRevision: 1, reviewerPlan: { reviewers: roles.map(role => ({ role, required: true })) } }, `live-${Date.now()}`);
      await runs.idle();
      const { run } = await runs.read('receipt', started.id);
      const receipt = {
        at: new Date().toISOString(), runId: run.id, outcome: run.outcome, reasons: run.reasons,
        reviewers: run.reviewers.map(reviewer => ({ role: reviewer.role, provider: reviewer.provider, modelId: reviewer.modelId, adapterVersion: reviewer.adapterVersion, billingLane: reviewer.billingLane, status: reviewer.status, inputMode: reviewer.inputMode, reason: reviewer.reason, ms: reviewer.startedAt && reviewer.endedAt ? Date.parse(reviewer.endedAt) - Date.parse(reviewer.startedAt) : null, rawOutput: reviewer.rawOutput })),
        findings: run.findings,
      };
      if (process.env.OD_REVIEW_LIVE_RECEIPT_FILE) await writeFile(process.env.OD_REVIEW_LIVE_RECEIPT_FILE, `${JSON.stringify(receipt, null, 2)}\n`);
      for (const role of roles) {
        const record = run.reviewers.find(reviewer => reviewer.role === role)!;
        expect(record, `${role}: ${record?.reason ?? ''}`).toMatchObject({ status: 'completed' });
        expect(record.rawOutput?.length).toBeGreaterThan(0);
        expect(run.findings.some(finding => finding.reviewerRole === role)).toBe(true);
        if (role === 'claude-visual') expect(record.inputMode).toBe('vision');
      }
    } finally { await rm(data, { recursive: true, force: true }); }
  }, 600_000);
});
