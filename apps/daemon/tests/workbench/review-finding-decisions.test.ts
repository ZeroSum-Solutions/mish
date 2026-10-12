import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReviewRunView } from '@mish/contracts';
import { bootReviewRuns, fakeReviewer } from './review-run-fixture.js';
import { knownGoodCapture, page, unavailablePort } from './review-capture-fixture.js';
import { consoleRecord } from '../../src/workbench/review/page-text.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function boot(options: Parameters<typeof bootReviewRuns>[0] = {}) {
  const daemon = await bootReviewRuns({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') }, ...options });
  cleanups.push(async () => { await daemon.runs.idle(); await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); });
  return daemon;
}
const plan = { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] };
const memberDirectory = async () => ({ ok: true, items: [{
  workspaceId: 'w', workspaceName: 'Workspace', workspaceType: 'team' as const, workspaceMemberId: 'member',
  role: 'member' as const, memberStatus: 'active' as const, lifecycleState: 'active' as const,
}] });
async function finished(daemon: Awaited<ReturnType<typeof boot>>, scope?: string[]) {
  const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: plan, ...(scope ? { scope: { kind: 'checks', checkIds: scope } } : {}) })).json());
  await daemon.runs.idle();
  return parseReviewRunView(await daemon.show(started.run.id));
}
function decide(daemon: Awaited<ReturnType<typeof boot>>, runId: string, findingId: string, action: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, projectId = 'p') {
  return fetch(`${daemon.url}/api/workbench/reviews/${runId}/findings/${findingId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': projectId, ...headers }, body: JSON.stringify({ action, ...extra }) });
}

describe('D7 advisory finding decisions (AC-R03.3, AC-R06.4)', () => {
  it.each([
    ['w', 'another-member'], ['another-workspace', 'member'], ['forged-workspace', 'forged-member'],
  ])('refuses a forged identity pair %s/%s without persisting an audit event', async (workspaceId, workspaceMemberId) => {
    const fetchWorkspaceDirectory = vi.fn(memberDirectory);
    const daemon = await boot({ fetchWorkspaceDirectory });
    const view = await finished(daemon, ['win95-style']);
    const response = await decide(daemon, view.run.id, view.run.findings[0]!.id, 'accept', {}, {
      'x-od-workspace-id': workspaceId, 'x-od-workspace-member-id': workspaceMemberId,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    expect(fetchWorkspaceDirectory).toHaveBeenCalledOnce();
    expect((await daemon.show(view.run.id)).run.findings).toEqual(view.run.findings);
  });

  it.each([
    ['unauthorized', 401, 'AMR_AUTH_REQUIRED'], ['network', 503, 'WORKSPACE_AUTHORITY_UNAVAILABLE'],
  ] as const)('refuses workspace attribution when the directory is %s', async (reason, status, code) => {
    const fetchWorkspaceDirectory = vi.fn(async () => ({ ok: false, items: [], reason }));
    const daemon = await boot({ fetchWorkspaceDirectory });
    const view = await finished(daemon, ['win95-style']);
    const response = await decide(daemon, view.run.id, view.run.findings[0]!.id, 'dismiss', {}, {
      'x-od-workspace-id': 'w', 'x-od-workspace-member-id': 'member',
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(fetchWorkspaceDirectory).toHaveBeenCalledOnce();
    expect((await daemon.show(view.run.id)).run.findings).toEqual(view.run.findings);
  });

  it('explicitly records headerless local-owner decisions without consulting the membership directory', async () => {
    const fetchWorkspaceDirectory = vi.fn(async () => ({ ok: false, items: [] }));
    const daemon = await boot({ fetchWorkspaceDirectory });
    const view = await finished(daemon, ['win95-style']);
    const response = await decide(daemon, view.run.id, view.run.findings[0]!.id, 'dismiss');
    expect(response.status).toBe(200);
    expect(parseReviewRunView(await response.json()).run.findings[0]!.decisions).toEqual([
      { action: 'dismiss', actor: { kind: 'local-user' }, at: expect.any(String) },
    ]);
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('documents the same review commands and identity policy under both CLI prefixes', async () => {
    const daemon = await boot();
    expect(await daemon.cli(['--help'])).toBe(0);
    const aliasHelp = daemon.output.pop() as { usage: string };
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['review', '--help'], { write: value => output.push(value) })).toBe(0);
    expect(output).toEqual([aliasHelp]);
    expect(aliasHelp.usage).toContain('od workbench review accept|dismiss <finding>');
    expect(aliasHelp.usage).toContain('od review is an alias for od workbench review');
    expect(aliasHelp.usage).toContain('local-user');
    expect(aliasHelp.usage).toContain('membership directory');
    // U2-1: the acceptance flow exists, so help must not deny it.
    expect(aliasHelp.usage).not.toContain('no acceptance flow yet');
    expect(aliasHelp.usage).toMatch(/required (check|judgment)[^\n]*409/i);
  });
  it('requires explicit acceptance, records who/when, keeps evidence and outcome, and persists after restart', async () => {
    const fetchWorkspaceDirectory = vi.fn(memberDirectory);
    const daemon = await boot({ fetchWorkspaceDirectory });
    const before = await readFile(path.join(daemon.root, 'index.html'));
    const view = await finished(daemon, ['win95-style']);
    const finding = view.run.findings[0]!;
    expect((finding as { decisions?: unknown[] }).decisions ?? []).toEqual([]);
    const response = await decide(daemon, view.run.id, finding.id, 'accept', {}, { 'x-od-workspace-id': 'w', 'x-od-workspace-member-id': 'member' });
    expect(response.status).toBe(200);
    expect(fetchWorkspaceDirectory).toHaveBeenCalledOnce();
    const accepted = parseReviewRunView(await response.json());
    expect(accepted.run.findings[0]).toMatchObject({ ...finding, decisions: [{ action: 'accept', actor: { kind: 'workspace-member', workspaceId: 'w', workspaceMemberId: 'member' }, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) }] });
    expect(accepted.run.outcome).toBe(view.run.outcome);
    expect(accepted.run.checkVerdicts).toEqual(view.run.checkVerdicts);
    expect(accepted.run.frozen).toEqual(view.run.frozen);
    expect(await readFile(path.join(daemon.root, 'index.html'))).toEqual(before);
    const restarted = await bootReviewRuns({ dataDir: daemon.data });
    try { expect((await restarted.show(view.run.id)).run.findings).toEqual(accepted.run.findings); } finally { await restarted.close(); }
  });

  it('CLI accept/dismiss uses the same boundary and retains both decisions', async () => {
    const daemon = await boot();
    const view = await finished(daemon, ['win95-style']);
    const finding = view.run.findings[0]!;
    for (const action of ['accept', 'dismiss']) {
      expect(await daemon.cli([action, finding.id, '--project', 'p', '--run', view.run.id, '--json'])).toBe(0);
      expect(daemon.output.pop()).toMatchObject({ run: { outcome: view.run.outcome, findings: [expect.objectContaining({ id: finding.id, decisions: expect.arrayContaining([{ action, actor: { kind: 'local-user' }, at: expect.any(String) }]) }), expect.anything()] } });
    }
  });

  it.each(['failed', 'inconclusive'] as const)('dismissal cannot clear %s mandatory evidence', async outcome => {
    const daemon = await boot(outcome === 'failed' ? { capture: width => knownGoodCapture(width, capture => { capture.console.push(consoleRecord({ kind: 'console', text: page('boom'), source: null })); }) } : { port: () => unavailablePort() });
    const view = await finished(daemon);
    expect(view.run.outcome).toBe(outcome);
    const mandatory = view.run.findings.find(finding => finding.checkId.startsWith('core.'))!;
    expect((await decide(daemon, view.run.id, mandatory.id, 'dismiss')).status).toBe(409);
    const optional = view.run.findings.find(finding => finding.checkId === 'win95-style')!;
    const response = await decide(daemon, view.run.id, optional.id, 'dismiss');
    expect(response.status).toBe(200);
    const after = parseReviewRunView(await daemon.show(view.run.id));
    const decisions = after.run.findings.find(finding => finding.id === optional.id)!.decisions ?? [];
    expect(decisions).toEqual([{ action: 'dismiss', actor: { kind: 'local-user' }, at: expect.any(String) }]);
    expect(after.run.outcome).toBe(outcome);
    expect(after.run.reasons).toEqual(view.run.reasons);
    expect(after.run.checkVerdicts).toEqual(view.run.checkVerdicts);
  });

  it('refuses required judgments, unknown/foreign findings, forged audit fields, and incomplete identity', async () => {
    const daemon = await boot();
    daemon.state.rubric!.checks[0]!.required = true;
    daemon.state.rubric!.checks[0]!.requiredBasis = { type: 'project-acceptance', requirementId: 'style', rationale: 'Owner requires it' };
    const view = await finished(daemon, ['win95-style']);
    const finding = view.run.findings[0]!;
    expect(view.run.outcome).toBe('inconclusive');
    expect((await decide(daemon, view.run.id, finding.id, 'dismiss')).status).toBe(409);
    expect((await decide(daemon, view.run.id, 'unknown', 'accept')).status).toBe(404);
    expect((await decide(daemon, view.run.id, finding.id, 'accept', {}, {}, 'foreign')).status).toBe(403);
    expect((await decide(daemon, view.run.id, finding.id, 'accept', {}, {}, 'other')).status).toBe(404);
    expect((await decide(daemon, view.run.id, finding.id, 'accept', { actor: 'owner', at: 'yesterday' })).status).toBe(422);
    expect((await decide(daemon, view.run.id, finding.id, 'accept', {}, { 'x-od-workspace-id': 'w' })).status).toBe(400);
  });

  it('serializes simultaneous decisions without losing audit events', async () => {
    const daemon = await boot();
    const view = await finished(daemon, ['win95-style']);
    const ids = view.run.findings.map(finding => finding.id);
    const responses = await Promise.all(ids.map(id => decide(daemon, view.run.id, id, 'accept')));
    expect(responses.map(response => response.status)).toEqual(ids.map(() => 200));
    const after = await daemon.show(view.run.id);
    expect(after.run.findings.every(finding => (finding as { decisions?: unknown[] }).decisions?.length === 1)).toBe(true);
  });
  it('acceptance cannot close a missing required reviewer', async () => {
    const daemon = await boot();
    const started = parseReviewRunView(await (await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] }, reviewerPlan: { reviewers: [...plan.reviewers, { role: 'claude-visual', required: true }] } })).json());
    await daemon.runs.idle();
    const before = parseReviewRunView(await daemon.show(started.run.id));
    expect(before.run.outcome).toBe('inconclusive');
    const response = await decide(daemon, before.run.id, before.run.findings[0]!.id, 'accept');
    expect(response.status).toBe(200);
    const after = parseReviewRunView(await response.json());
    expect(after.run.outcome).toBe('inconclusive');
    expect(after.run.incompleteCheckIds).toEqual(before.run.incompleteCheckIds);
    expect(after.run.reasons).toEqual(before.run.reasons);
  });

});
