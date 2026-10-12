import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';
import {
  parseProjectDesignContextDraft, parseProjectDesignContextSnapshot,
  parseProjectRubricSnapshot, parseResourceSearchResponse, parseWorkbenchPreferencesSnapshot,
  type ProjectDesignContextDraft, type ProjectDesignContextSnapshot, type ResourceSearchResponse,
} from '@open-design/contracts';
import { test, expect } from '@/playwright/suite';
import { e2eWorkspaceRoot } from '@/tools-dev/runtime';
import type { ToolsDevSuite } from '@/tools-dev/types';
import { T } from '@/timeouts';

const execFileAsync = promisify(execFile);
const QUERY = 'Build a calm premium dentistry page where new patients book their first appointment';
const STORAGE_KEY = 'open-design:config';
const headers = (projectId: string) => ({ 'x-od-project-id': projectId });
const recordPath = (id: string, family: string) => `/api/workbench/projects/${encodeURIComponent(id)}/${family}`;

// The suite owns real daemon/web/data isolation. Held workbench responses come
// unchanged from the real daemon; no fabricated search or authority payloads.
// This is preparation only until root runs it against rebuilt integrated inputs.
test('[P1] saves project goals and rubric through UI, shares od revisions, and persists the adjacent choice across restart', async ({ page, toolsDev }, info) => {
  test.setTimeout(T.xlong * 3); // Includes an actual tools-dev stop/start, not a reload substitute.
  const provider = await providerTripwire();
  const requests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && ['/api/runs', '/api/chat'].includes(new URL(request.url()).pathname)) requests.push(request.url());
  });
  try {
    await seedConfig(page, toolsDev, provider.url);
    const project = await createProject(page.request, toolsDev);
    await openResources(page, toolsDev, project);
    const panel = page.getByTestId('workbench-resource-search');
    const query = panel.getByRole('textbox', { name: 'Search resources', exact: true });
    const toggle = panel.getByRole('checkbox', { name: 'Use project context', exact: true });
    await expect(toggle).toBeChecked();
    await query.focus(); await page.keyboard.press('Tab'); await expect(toggle).toBeFocused();
    const editor = await openGoals(panel);
    const goals = await saveGoals(page, editor, project.id);
    expect(goals.revision).toBe(1);
    expect(goals.context).toMatchObject({ styleDirection: 'windows95', spineCode: 'SM', constraints: [{ kind: 'motion', value: 'none' }] });
    expect(goals.context!.factSources.every(fact => fact.origin === 'user-confirmed')).toBe(true);
    await expect(editor).toContainText('These are declared requirements. No check has run.');
    // Mechanical and manual requirements are declarations, never fabricated outcomes.
    await editor.getByRole('combobox', { name: 'New check type', exact: true }).selectOption('contrast');
    await editor.getByRole('button', { name: 'Add check', exact: true }).click();
    await editor.getByRole('combobox', { name: 'New check type', exact: true }).selectOption('manual');
    await editor.getByRole('button', { name: 'Add check', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Manual procedure', exact: true }).fill('Use Tab to reach the primary appointment action.');
    await editor.getByRole('textbox', { name: 'Test environment', exact: true }).fill('Desktop Chrome with keyboard only');
    const rubricResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === recordPath(project.id, 'rubric'));
    await editor.getByRole('button', { name: 'Save rubric', exact: true }).click();
    const rubricAck = await rubricResponse; expect(rubricAck.status()).toBe(200);
    const rubric = parseProjectRubricSnapshot(await rubricAck.json());
    expect(rubric).toMatchObject({ revision: 1, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } });
    expect(rubric.rubric!.checks.map(check => check.kind)).toEqual(['mechanical', 'manual']);
    await expect(editor.getByText(/verification pending/)).toHaveCount(8);
    await editor.getByRole('button', { name: 'Close details', exact: true }).click();
    const readGoals = await getContext(page.request, toolsDev, project.id);
    expect(readGoals).toEqual(goals);
    expect(parseProjectDesignContextSnapshot((await od(toolsDev, ['context', 'get', '--project', project.id])).body)).toEqual(goals);
    expect(parseProjectRubricSnapshot((await od(toolsDev, ['rubric', 'get', '--project', project.id])).body)).toEqual(rubric);
    const preferences = parseWorkbenchPreferencesSnapshot((await od(toolsDev, ['preferences', 'get', '--project', project.id])).body);
    expect(preferences).toMatchObject({ revision: 0, effective: { useProjectContext: true } });

    // Current same-project asset association comes through public file/library APIs.
    const foreign = await createProject(page.request, toolsDev);
    const ownAsset = await projectAsset(page.request, toolsDev, project.id);
    const foreignAsset = await projectAsset(page.request, toolsDev, foreign.id);
    const referencedDraft = editableGoals(goals);
    referencedDraft.factSources = referencedDraft.factSources.map(fact => fact.fieldPath === '/brandDirection'
      ? { ...fact, origin: 'imported', source: { assetId: ownAsset }, rationale: 'Explicit same-project reference' } : fact);
    const input = info.outputPath('context-reference.json'); await writeFile(input, JSON.stringify(referencedDraft));
    const referenceSave = parseProjectDesignContextSnapshot((await od(toolsDev, ['context', 'set', '--project', project.id, '--expected-revision', '1', '--input-file', input])).body);
    expect(referenceSave.revision).toBe(2);
    expect(referenceSave.context!.factSources.find(fact => fact.fieldPath === '/brandDirection')?.source).toEqual({ assetId: ownAsset });
    const forbidden = structuredClone(referencedDraft);
    forbidden.factSources = forbidden.factSources.map(fact => fact.fieldPath === '/brandDirection' ? { ...fact, source: { assetId: foreignAsset } } : fact);
    const refusal = await page.request.put(toolsDev.url.daemon(recordPath(project.id, 'context')), { headers: headers(project.id), data: { expectedRevision: 2, draft: forbidden } });
    expect(refusal.status()).toBe(422); expect(await refusal.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await refusal.text()).not.toContain(foreignAsset);
    expect(await getContext(page.request, toolsDev, project.id)).toEqual(referenceSave);
    const staleRubric = parseProjectRubricSnapshot((await od(toolsDev, ['rubric', 'get', '--project', project.id])).body);
    expect(staleRubric).toMatchObject({ revision: 1, rubric: rubric.rubric, linkage: { state: 'stale', currentContextRevision: 2 } });
    await page.reload(); await openResourceMenu(page);
    const reopenedEditor = await openGoals(panel);
    await expect(reopenedEditor.getByRole('status')).toContainText('Rubric still refers to earlier goals:');
    await expect(reopenedEditor.getByText(/verification pending/)).toHaveCount(8);
    await reopenedEditor.getByRole('button', { name: 'Close details', exact: true }).click();

    const appliedResponse = searchResponse(page, project.id, QUERY);
    await query.fill(QUERY);
    const applied = parseResourceSearchResponse(await (await appliedResponse).json());
    expect(applied.context).toMatchObject({ applied: true, observedContextRevision: 2, preferenceRevision: 0, selection: 'saved', resultMode: 'ranked' });
    expect(applied.results.length).toBeGreaterThan(0);
    expect(applied.results.some(item => item.fitReasons.some(reason => /spineAffinities|sectionKind/.test(reason)))).toBe(true);
    expect(applied.results.every(item => !item.adoptionCapability.available)).toBe(true);
    const source = applied.results[0]!;
    const staleSource = structuredClone(referencedDraft);
    staleSource.factSources = staleSource.factSources.map(fact => fact.fieldPath === '/brandDirection' ? { ...fact, source: { resourceRef: { ...source.ref, revisionOrDigest: 'stale-context-fixture' } } } : fact);
    const staleRefusal = await page.request.put(toolsDev.url.daemon(recordPath(project.id, 'context')), { headers: headers(project.id), data: { expectedRevision: 2, draft: staleSource } });
    expect(staleRefusal.status()).toBe(422); expect(await staleRefusal.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await getContext(page.request, toolsDev, project.id)).toEqual(referenceSave);
    const offResponse = searchResponse(page, project.id, QUERY);
    const offSave = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === recordPath(project.id, 'preferences'));
    await toggle.focus(); await page.keyboard.press('Space');
    expect(parseWorkbenchPreferencesSnapshot(await (await offSave).json())).toMatchObject({ revision: 1, effective: { useProjectContext: false } });
    const off = parseResourceSearchResponse(await (await offResponse).json());
    expect(off.context).toMatchObject({ applied: false, reason: 'context-disabled', observedContextRevision: 2, preferenceRevision: 1, selection: 'saved', resultMode: 'lexical' });
    await expect(query).toHaveValue(QUERY);
    const prompt = info.outputPath('search.txt'); await writeFile(prompt, QUERY);
    const cliOff = parseResourceSearchResponse((await od(toolsDev, ['search', '--project', project.id, '--prompt-file', prompt])).body);
    expect(cliOff.context).toEqual(off.context);
    const override = parseResourceSearchResponse((await od(toolsDev, ['search', '--project', project.id, '--prompt-file', prompt, '--context', 'on'])).body);
    expect(override.context).toMatchObject({ applied: true, selection: 'request-override', preferenceRevision: 1 });
    expect(parseWorkbenchPreferencesSnapshot((await od(toolsDev, ['preferences', 'get', '--project', project.id])).body).revision).toBe(1);

    const restrictedResponse = searchResponse(page, project.id, 'Scroll Morph Hero'); await query.fill('Scroll Morph Hero');
    const restrictedMatches = parseResourceSearchResponse(await (await restrictedResponse).json()).results.filter(item => item.ref.itemId === 'scroll-morph-hero');
    expect(restrictedMatches, 'The restricted resource identity must resolve exactly once').toHaveLength(1);
    const restricted = restrictedMatches[0]!;
    expect(restricted).toMatchObject({ readiness: 'unavailable', availabilityReason: 'rights-blocked', adoptionCapability: { available: false } });
    expect(restricted.componentFit).toMatchObject({ status: 'unknown', acceptance: 'pending', apply: { allowed: false } });
    const restrictedButton = panel.getByRole('button', { name: resourceAccessibleLabel(restricted), exact: true });
    await expect(restrictedButton).toHaveCount(1);
    await expect(restrictedButton.getByTestId('component-fit')).toHaveAttribute('data-fit', 'unknown');
    await expect(restrictedButton.getByTestId('component-acceptance')).toHaveText('· Acceptance pending');
    await restrictedButton.click();
    const detail = page.getByTestId('workbench-resource-detail'); await expect(detail).toContainText('rights-blocked');
    await expect(detail.locator('iframe')).toHaveCount(0);
    await expect(detail.getByRole('button', { name: /Use plugin/ })).toHaveCount(0);
    await page.reload(); await openResourceMenu(page); await expect(toggle).not.toBeChecked();

    const beforeRestart = await toolsDev.status(); const originalPid = beforeRestart.apps?.daemon?.pid;
    expect(originalPid).toBeGreaterThan(0);
    for (const status of ['queued', 'running']) {
      const response = await page.request.get(`${toolsDev.url.daemon('/api/runs')}?status=${status}`);
      expect(response.status(), `Global ${status} inventory must succeed before isolated restart`).toBe(200);
      expect((await response.json()).runs).toEqual([]);
    }
    const dataRoot = toolsDev.dataDir;
    await toolsDev.stopWeb();
    await toolsDev.startWeb({ AMR_HOME: join(toolsDev.root, 'scratch', 'amr-home'), OD_CODEX_TRANSPORT: 'exec-json' });
    expect(toolsDev.dataDir).toBe(dataRoot); expect((await toolsDev.status()).apps?.daemon?.pid).not.toBe(originalPid);
    await expect.poll(async () => (await page.request.get(toolsDev.url.daemon('/api/health'))).status(), { timeout: T.long }).toBe(200);
    expect(await getContext(page.request, toolsDev, project.id)).toEqual(referenceSave);
    expect(parseProjectRubricSnapshot((await od(toolsDev, ['rubric', 'get', '--project', project.id])).body)).toEqual(staleRubric);
    expect(parseWorkbenchPreferencesSnapshot((await od(toolsDev, ['preferences', 'get', '--project', project.id])).body)).toMatchObject({ revision: 1, effective: { useProjectContext: false } });
    await openResources(page, toolsDev, project); await expect(toggle).not.toBeChecked();
    expect(requests).toEqual([]); expect(provider.calls).toEqual([]);
    await info.attach('context-parity', { body: JSON.stringify({ projectId: project.id, contextRevision: 2, rubricRevision: 1, preferenceRevision: 1, originalPid, restartedPid: (await toolsDev.status()).apps?.daemon?.pid, sameDataRoot: true, providerCalls: provider.calls, runAdmissions: requests }), contentType: 'application/json' });
  } finally { await provider.close(); }
});

test('[P1] a losing goals draft retains its text and retries against the authorized current revision', async ({ page, toolsDev }, info) => {
  const provider = await providerTripwire();
  try {
    await seedConfig(page, toolsDev, provider.url); const project = await createProject(page.request, toolsDev);
    await openResources(page, toolsDev, project); const panel = page.getByTestId('workbench-resource-search');
    const editor = await openGoals(panel); const initial = await saveGoals(page, editor, project.id);
    await editor.getByRole('textbox', { name: 'Project purpose', exact: true }).fill('Losing draft stays local until explicit retry.');
    const winner = editableGoals(initial); winner.purpose = 'Authorized winning purpose';
    winner.factSources = winner.factSources.map(fact => fact.fieldPath === '/purpose' ? { ...fact, value: winner.purpose!, source: null, origin: 'user-confirmed' } : fact);
    const input = info.outputPath('winning-context.json'); await writeFile(input, JSON.stringify(winner));
    const winningSave = parseProjectDesignContextSnapshot((await od(toolsDev, ['context', 'set', '--project', project.id, '--expected-revision', '1', '--input-file', input])).body);
    const conflictResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === recordPath(project.id, 'context'));
    await editor.getByRole('button', { name: 'Save project goals', exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(editor.getByRole('alert')).toContainText('Unsaved goals. Your draft is kept.');
    await expect(editor.getByRole('textbox', { name: 'Project purpose', exact: true })).toHaveValue('Losing draft stays local until explicit retry.');
    expect(await getContext(page.request, toolsDev, project.id)).toEqual(winningSave);
    const retryResponse = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === recordPath(project.id, 'context'));
    await editor.getByRole('button', { name: 'Retry goals', exact: true }).click();
    expect(parseProjectDesignContextSnapshot(await (await retryResponse).json())).toMatchObject({ revision: 3, context: { purpose: 'Losing draft stays local until explicit retry.' } });
    expect(parseWorkbenchPreferencesSnapshot((await od(toolsDev, ['preferences', 'get', '--project', project.id])).body).revision).toBe(0);
    expect(parseProjectRubricSnapshot((await od(toolsDev, ['rubric', 'get', '--project', project.id])).body).revision).toBe(0);
    expect(provider.calls).toEqual([]);
  } finally { await provider.close(); }
});

test('[P1] switching context off rejects a held real discovery response and keeps the prompt', async ({ page, toolsDev }, info) => {
  const provider = await providerTripwire();
  let held: Awaited<ReturnType<typeof holdRealSearch>> | undefined;
  try {
    await seedConfig(page, toolsDev, provider.url); const project = await createProject(page.request, toolsDev);
    await openResources(page, toolsDev, project);
    const panel = page.getByTestId('workbench-resource-search');
    const query = panel.getByRole('textbox', { name: 'Search resources', exact: true });
    const toggle = panel.getByRole('checkbox', { name: 'Use project context', exact: true });
    const editor = await openGoals(panel); await saveGoals(page, editor, project.id);
    await editor.getByRole('button', { name: 'Close details', exact: true }).click();
    held = await holdRealSearch(page, project.id, QUERY);
    await query.fill(QUERY);
    const old = await held.ready;
    expect(old.context).toMatchObject({ applied: true, projectId: project.id, observedContextRevision: 1, preferenceRevision: 0, selection: 'saved' });
    expect(old.results.length, 'The held response must contain actual contextual suggestions').toBeGreaterThan(0);
    const savedOff = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === recordPath(project.id, 'preferences'));
    const freshOff = searchResponse(page, project.id, QUERY);
    await toggle.focus(); await page.keyboard.press('Space');
    expect(parseWorkbenchPreferencesSnapshot(await (await savedOff).json())).toMatchObject({ revision: 1, effective: { useProjectContext: false } });
    const fresh = parseResourceSearchResponse(await (await freshOff).json());
    expect(fresh.context).toMatchObject({ applied: false, projectId: project.id, reason: 'context-disabled', preferenceRevision: 1, observedContextRevision: 1 });
    expect(fresh.results).toEqual([]); // No literal match for this long prompt.
    await expectSearchRendered(panel, fresh);
    await observeSearch(page);
    await held.release(); await settleDeliveredSearch(page);
    await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
    await expect(query).toHaveValue(QUERY); await expectSearchRendered(panel, fresh);
    const observed = await observedSearch(page);
    expect(observed.every(state => state.applied === 'false' && state.reason === 'context-disabled' && state.labels.length === 0 && state.query === QUERY)).toBe(true);
    expect(provider.calls).toEqual([]);
    await info.attach('held-discovery-toggle-off', { body: JSON.stringify({ projectId: project.id, held: old, current: fresh, observed, providerCalls: provider.calls }), contentType: 'application/json' });
  } finally { try { await held?.close(); } finally { await provider.close(); } }
});

test('[P1] project A–B–A navigation discards both held real searches after the return to A', async ({ page, toolsDev }, info) => {
  const provider = await providerTripwire();
  const held: Awaited<ReturnType<typeof holdRealSearch>>[] = [];
  try {
    await seedConfig(page, toolsDev, provider.url);
    const a = await createProject(page.request, toolsDev), b = await createProject(page.request, toolsDev);
    await openResources(page, toolsDev, a);
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    const panel = page.getByTestId('workbench-resource-search');
    const query = panel.getByRole('textbox', { name: 'Search resources', exact: true });
    // Neither project has saved goals. Keep A's revisions identical across the
    // boundary so rejecting A-old cannot depend on a changed record revision.
    const oldQuery = 'Scroll Morph Hero';
    const first = await holdRealSearch(page, a.id, oldQuery); held.push(first);
    await query.fill(oldQuery); const oldA = await first.ready;
    expect(oldA.context).toMatchObject({ projectId: a.id, preferenceRevision: 0, observedContextRevision: 0, reason: 'context-absent' });
    expect(oldA.results.some(item => item.ref.itemId === 'scroll-morph-hero')).toBe(true);
    await navigateResourcesInApp(page, b);
    const second = await holdRealSearch(page, b.id, oldQuery); held.push(second);
    await query.fill(oldQuery); const oldB = await second.ready;
    expect(oldB.context).toMatchObject({ projectId: b.id, preferenceRevision: 0, observedContextRevision: 0, reason: 'context-absent' });
    expect(oldB.results.some(item => item.ref.itemId === 'scroll-morph-hero')).toBe(true);
    await navigateResourcesInApp(page, a);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin);
    const currentQuery = `no-literal-resource-${randomUUID()}`;
    const currentSearch = searchResponse(page, a.id, currentQuery); await query.fill(currentQuery);
    const fresh = parseResourceSearchResponse(await (await currentSearch).json());
    expect(fresh.context).toMatchObject({ projectId: a.id, preferenceRevision: 0, observedContextRevision: 0, reason: 'context-absent' });
    expect(fresh.results).toEqual([]); await expectSearchRendered(panel, fresh);
    await observeSearch(page);
    // Resolve B while A is active, then resolve A-old after A-new has rendered.
    // This uses same-document routing, not a reload that cancels old requests.
    await second.release(); await settleDeliveredSearch(page); await expectSearchRendered(panel, fresh);
    await first.release(); await settleDeliveredSearch(page); await expectSearchRendered(panel, fresh);
    await expect(query).toHaveValue(currentQuery);
    await expect(panel.getByRole('checkbox', { name: 'Use project context', exact: true })).toBeChecked();
    const observed = await observedSearch(page);
    expect(observed.every(state => state.labels.length === 0 && state.reason === 'context-absent' && state.query === currentQuery)).toBe(true);
    expect(provider.calls).toEqual([]);
    await info.attach('held-discovery-project-aba', { body: JSON.stringify({ projects: [a.id, b.id, a.id], oldA, oldB, current: fresh, observed, sameDocument: true, accountProof: false, providerCalls: provider.calls }), contentType: 'application/json' });
  } finally {
    try {
      const cleanup = await Promise.allSettled(held.map(search => search.close()));
      const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Held search cleanup failed');
    } finally { await provider.close(); }
  }
});

async function seedConfig(page: Page, runtime: ToolsDevSuite, baseUrl: string) {
  const config = { mode: 'api', apiProtocol: 'openai', apiKey: 'fixture-only', baseUrl, model: 'fixture-local', agentId: null, agentModels: {}, agentCliEnv: {}, onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } };
  const response = await page.request.put(runtime.url.daemon('/api/app-config'), { data: config }); expect(response.ok()).toBeTruthy();
  await page.addInitScript(({ key, config }) => { if (window === window.top) localStorage.setItem(key, JSON.stringify(config)); }, { key: STORAGE_KEY, config });
}
async function createProject(request: APIRequestContext, runtime: ToolsDevSuite) {
  const response = await request.post(runtime.url.daemon('/api/projects'), { data: { id: randomUUID(), name: `P2 context ${randomUUID()}`, skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(response.ok()).toBeTruthy(); const body = await response.json(); expect(typeof body.project.id).toBe('string'); expect(typeof body.conversationId).toBe('string');
  return { id: body.project.id as string, conversationId: body.conversationId as string };
}
async function openResources(page: Page, runtime: ToolsDevSuite, project: { id: string; conversationId: string }) {
  await page.goto(runtime.url.web(`/projects/${project.id}/conversations/${project.conversationId}`));
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long }); await openResourceMenu(page);
}
async function openResourceMenu(page: Page) {
  await page.getByTestId('chat-plus-trigger').click(); await page.getByTestId('composer-plus-resources').click();
  await expect(page.getByTestId('workbench-resource-search').getByRole('checkbox', { name: 'Use project context', exact: true })).toBeEnabled();
}
async function openGoals(panel: Locator) {
  await panel.getByRole('button', { name: 'Edit project goals and rubric', exact: true }).click();
  const editor = panel.getByRole('region', { name: 'Project goals', exact: true });
  await expect(editor.getByRole('textbox', { name: 'Project purpose', exact: true })).toBeVisible(); return editor;
}
async function saveGoals(page: Page, editor: Locator, id: string) {
  await editor.getByRole('textbox', { name: 'Project purpose', exact: true }).fill('Help new dental patients book an appointment.');
  await editor.getByRole('textbox', { name: 'Audience (one per line)', exact: true }).fill('New dental patients');
  await editor.getByRole('textbox', { name: 'Brand direction', exact: true }).fill('Calm and clear');
  await editor.getByRole('textbox', { name: 'Style direction', exact: true }).fill('windows95');
  await editor.getByRole('combobox', { name: 'Design spine', exact: true }).selectOption('SM');
  await editor.getByRole('button', { name: 'Add conversion', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Conversion label', exact: true }).fill('Book an appointment');
  await editor.getByRole('combobox', { name: 'Expected action', exact: true }).selectOption('booking');
  await editor.getByRole('button', { name: 'Add no-motion constraint', exact: true }).click();
  const response = page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === recordPath(id, 'context'));
  await editor.getByRole('button', { name: 'Save project goals', exact: true }).click(); const ack = await response; expect(ack.status()).toBe(200);
  return parseProjectDesignContextSnapshot(await ack.json());
}
async function getContext(request: APIRequestContext, runtime: ToolsDevSuite, id: string) {
  const response = await request.get(runtime.url.daemon(recordPath(id, 'context')), { headers: headers(id) }); expect(response.status()).toBe(200);
  return parseProjectDesignContextSnapshot(await response.json());
}
function editableGoals(snapshot: ProjectDesignContextSnapshot): ProjectDesignContextDraft {
  expect(snapshot.context).not.toBeNull(); const { schema: _schema, projectId: _id, revision: _revision, updatedAt: _time, ...draft } = snapshot.context!;
  return parseProjectDesignContextDraft(draft);
}
function searchResponse(page: Page, projectId: string, query: string) {
  return page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/workbench/resources/search' && response.request().postDataJSON().projectId === projectId && response.request().postDataJSON().query === query);
}
async function holdRealSearch(page: Page, projectId: string, query: string) {
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  let ready!: (response: ResourceSearchResponse) => void, rejectReady!: (error: unknown) => void;
  const captured = new Promise<ResourceSearchResponse>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  let finish!: () => void, rejectFinish!: (error: unknown) => void;
  const delivered = new Promise<void>((resolve, reject) => { finish = resolve; rejectFinish = reject; });
  // A setup failure can precede the first await of these signals; preserve the
  // rejection for that await without an unrelated unhandled-promise failure.
  void captured.catch(() => {}); void delivered.catch(() => {});
  let claimed = false;
  const pattern = '**/api/workbench/resources/search';
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST' || claimed || request.postDataJSON().projectId !== projectId || request.postDataJSON().query !== query) { await route.fallback(); return; }
    claimed = true;
    try {
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      ready(parseResourceSearchResponse(await actual.json()));
      await gate;
      const finished = page.waitForEvent('requestfinished', { predicate: candidate => candidate === request, timeout: T.long });
      await route.fulfill({ response: actual }); await finished; finish();
    } catch (error) { rejectReady(error); rejectFinish(error); }
  };
  await page.route(pattern, handler);
  return { ready: captured, release: async () => { resume(); await delivered; }, close: async () => { resume(); await page.unroute(pattern, handler); if (claimed) await delivered; } };
}
async function navigateResourcesInApp(page: Page, project: { id: string; conversationId: string }) {
  const path = `/projects/${project.id}/conversations/${project.conversationId}`;
  await page.evaluate(target => { window.history.pushState(null, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long }); await openResourceMenu(page);
}
type SearchResource = ResourceSearchResponse['results'][number];
function resourceAccessibleLabel(resource: SearchResource): string {
  const fitLabels = { fits: 'Fits active kit', mismatch: 'Does not fit', unknown: 'Fit unknown' };
  const acceptanceLabels = { passed: 'Acceptance passed', failed: 'Acceptance failed', pending: 'Acceptance pending', stale: 'Acceptance evidence outdated' };
  const fit = resource.componentFit;
  return `${resource.title} · ${resource.readiness}${fit ? ` · ${fitLabels[fit.status]} · ${acceptanceLabels[fit.acceptance]}` : ''}`;
}
async function expectSearchRendered(panel: Locator, response: ResourceSearchResponse) {
  const notice = panel.locator('[data-context-reason]');
  // Applied responses have no fallback reason. The UI gives the attribute a
  // non-null default, while the visible text still identifies the applied path.
  await expect(notice).toHaveAttribute('data-context-reason', response.context.reason ?? 'context-not-implemented');
  await expect(notice).toHaveAttribute('data-context-requested', String(response.context.requested));
  await expect(notice).toHaveAttribute('data-context-applied', String(response.context.applied));
  const expectedNotice = response.context.applied ? 'Using saved project goals to rank local resources.'
    : response.context.reason === 'context-disabled' ? 'Project context is off. Showing literal matches.'
    : response.context.reason === 'context-absent' ? 'No saved project goals yet. Showing literal matches.'
    : response.context.reason === 'context-not-rankable' ? 'Saved goals have no supported ranking features. Showing literal matches.'
    : response.context.reason === 'ranking-timeout' ? 'Context ranking timed out. Showing literal matches.'
    : response.context.reason === 'no-project' ? 'Choose a project to save goals and a context preference.'
    : 'Project context requested; not yet available.';
  await expect(notice).toHaveText(expectedNotice);
  const buttons = panel.locator('section button[aria-pressed]');
  await expect(buttons).toHaveCount(response.results.length);
  expect((await buttons.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).sort()).toEqual(response.results.map(resourceAccessibleLabel).sort());
  if (!response.results.length) await expect(panel.getByText('No matching local resources.', { exact: true })).toBeVisible();
}
type SearchObservation = { applied: string | null; reason: string | null; query: string; labels: (string | null)[] };
async function observeSearch(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="workbench-resource-search"]'); if (!panel) throw new Error('Resource panel missing');
    const states: SearchObservation[] = [];
    const read = () => {
      const notice = panel.querySelector('[data-context-reason]');
      states.push({ applied: notice?.getAttribute('data-context-applied') ?? null, reason: notice?.getAttribute('data-context-reason') ?? null, query: (panel.querySelector('input[aria-label="Search resources"]') as HTMLInputElement).value, labels: Array.from(panel.querySelectorAll('section button[aria-pressed]'), node => node.getAttribute('aria-label')) });
    };
    const observer = new MutationObserver(read); observer.observe(panel, { subtree: true, childList: true, attributes: true }); read();
    (window as unknown as { p2SearchWitness: { states: SearchObservation[]; stop: () => void } }).p2SearchWitness = { states, stop: () => observer.disconnect() };
  });
}
async function settleDeliveredSearch(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function observedSearch(page: Page) {
  return page.evaluate(() => {
    const witness = (window as unknown as { p2SearchWitness: { states: SearchObservation[]; stop: () => void } }).p2SearchWitness;
    witness.stop(); return witness.states;
  });
}
async function projectAsset(request: APIRequestContext, runtime: ToolsDevSuite, id: string) {
  const name = `reference-${randomUUID()}.html`;
  expect((await request.post(runtime.url.daemon(`/api/projects/${id}/upload`), { multipart: { files: { name, mimeType: 'text/html', buffer: Buffer.from(`<!doctype html><p>${name}</p>`) } } })).ok()).toBeTruthy();
  expect((await request.post(runtime.url.daemon('/api/library/sync'))).ok()).toBeTruthy();
  const response = await request.get(`${runtime.url.daemon('/api/library/assets')}?projectId=${encodeURIComponent(id)}`); expect(response.ok()).toBeTruthy();
  const asset = (await response.json()).assets.find((item: { id: string; originProjectId?: string; relPath?: string }) => item.originProjectId === id && item.relPath === name);
  expect(asset).toBeTruthy(); expect(typeof asset.id).toBe('string'); return asset.id as string;
}
async function od(runtime: ToolsDevSuite, args: string[]) {
  await mkdir(join(runtime.root, 'fixtures'), { recursive: true });
  const { stdout } = await execFileAsync(process.execPath, [join(e2eWorkspaceRoot(), 'apps/daemon/bin/od.mjs'), 'workbench', ...args, '--daemon-url', runtime.url.daemon('/'), '--json'], {
    cwd: e2eWorkspaceRoot(), env: { ...process.env, OD_TOOL_TOKEN: '', OD_DATA_DIR: runtime.dataDir, CODEX_HOME: runtime.codexHomeDir }, timeout: T.long, maxBuffer: 4 * 1024 * 1024,
  });
  return { body: JSON.parse(stdout) as unknown };
}
async function providerTripwire() {
  const calls: string[] = []; const server = createServer((request, response) => { calls.push(`${request.method} ${request.url}`); response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"provider forbidden in local discovery"}'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Provider tripwire has no loopback port');
  return { calls, url: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
