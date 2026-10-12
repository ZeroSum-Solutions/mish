import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '@/playwright/suite';
import { routeMockAgents, routeAppConfig, STORAGE_KEY } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

/**
 * AC-R04.3 / AC-R04.4 browser witness (U6): inspect → enlarge → apply → save
 * readback → second-project reuse → undo for the one selected shadcn item,
 * with the enlarge step asserting the preview-unavailable state (the R04.4
 * isolated-preview clause is an open gate, not covered here),
 * through the real web app and the real daemon. No workbench or adoption
 * route mock: every project byte is seeded and read back through production
 * project-file HTTP APIs. Lower layers own the gate matrix (rights, notices,
 * dependency report, stale diff): apps/daemon/tests/workbench/catalogue-adoption*.test.ts
 * and apps/web/tests/components/workbench/workbench-apply-action.test.tsx.
 *
 * The live registry item changes upstream, so nothing about it is hardcoded:
 * the projects start with an empty manifest, Apply shows the daemon's
 * dependency refusal listing every declared package (W1), the manifest is
 * then seeded from that same report, and the written files are read back from
 * the daemon's own prepared plan (W2).
 *
 * Needs registry egress to ui.shadcn.com and a provisioned executor, which in
 * phase A means darwin-arm64 with the run-level opt-in (B4-1, ADOPTION.md
 * "Provisioning"): OD_E2E_PLACEMENT_OWNER_* plus
 * OD_E2E_PLACEMENT_ADOPTION_EXECUTOR=1 (tools-dev creates and records a fresh
 * data root). The process opt-in opens the executor; the Settings → Labs switch
 * can only close it, so the spec's write of `true` is accepted and changes
 * nothing. It skips only while the run has no process opt-in
 * (`adoption-opt-in-env-off`) or the host is outside phase A
 * (`adoption-host-unsupported:*`); every other closed gate fails.
 */
const ENTRY = 'export default function App() { return <main>original</main>; }\n';
type DependencyReport = { missing: Array<{ name: string; range: string }>; incompatible: Array<{ name: string; required: string; installed: string }> };

async function writeFile(request: APIRequestContext, projectId: string, name: string, content: string) {
  const write = await request.post(`/api/projects/${projectId}/files`, { data: { name, content } });
  expect(write.ok(), `${name}: ${await write.text()}`).toBeTruthy();
}
async function seedProject(request: APIRequestContext, name: string) {
  const created = await request.post('/api/projects', { data: { id: randomUUID(), name, skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = await created.json() as { project: { id: string }; conversationId: string };
  // An empty manifest: the declared dependencies come from the daemon's report, not from this spec.
  // Directories exist before apply: the executor never creates undeclared parents.
  for (const [file, content] of [['package.json', JSON.stringify({ dependencies: {} })], ['src/App.tsx', ENTRY], ['src/components/ui/.keep', ''], ['src/lib/.keep', '']] as const) {
    await writeFile(request, body.project.id, file, content);
  }
  return { id: body.project.id, conversationId: body.conversationId };
}
const raw = (request: APIRequestContext, projectId: string, file: string) => request.get(`/api/projects/${projectId}/raw/${file}`);
const cataloguePrepare = (request: APIRequestContext, projectId: string, refKey: string) =>
  request.post('/api/workbench/adoption/catalogue/prepare', { data: { projectId, refKey, entryPath: 'src/App.tsx' } });

async function openShadcnButton(page: Page, project: { id: string; conversationId: string }) {
  await page.goto(`/projects/${project.id}/conversations/${project.conversationId}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
  await page.getByTestId('chat-plus-trigger').click();
  await page.getByTestId('composer-plus-resources').click();
  await page.getByRole('textbox', { name: 'Search resources' }).fill('Button');
  const result = page.getByRole('button', { name: 'Button · unverified', exact: true });
  await expect(result).toBeVisible({ timeout: T.long });
  await result.click();
  const detail = page.getByTestId('workbench-resource-detail');
  await expect(detail).toBeVisible();
  return detail;
}

test('[P1] Resources apply the selected shadcn item, reuse it in a second project and undo', async ({ page }, testInfo) => {
  test.setTimeout(T.xlong);
  await routeMockAgents(page);
  await routeAppConfig(page);
  await page.addInitScript(({ key }) => {
    if (window !== window.top) return;
    localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } }));
  }, { key: STORAGE_KEY });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const first = await seedProject(page.request, 'U6 catalogue apply A');
  const second = await seedProject(page.request, 'U6 catalogue apply B');

  // Provisioning: the run's process opt-in opens the executor; writing the Labs switch on cannot open or close it here.
  const labs = await page.request.put('/api/app-config', { data: { placementAdoptionExecutor: true } });
  expect(labs.ok(), await labs.text()).toBeTruthy();
  const statusResponse = await page.request.get('/api/workbench/adoption/status');
  expect(statusResponse.ok(), await statusResponse.text()).toBeTruthy();
  const { status } = await statusResponse.json() as { status: { executor: string; gates: string[] } };
  const unopted = status.gates.find(gate => gate === 'adoption-opt-in-env-off' || gate.startsWith('adoption-host-unsupported:'));
  test.skip(status.executor === 'closed' && unopted !== undefined, `Open gate ${unopted}: run without the adoption executor opt-in or outside phase A hosts`);
  expect(status, 'the adoption executor must be provisioned once the run opts in').toMatchObject({ executor: 'provisioned' });

  // A malformed reference reaches the catalogue manager (404) only when the executor is wired.
  const probe = await cataloguePrepare(page.request, first.id, 'abc');
  const probeBody = await probe.json() as { error?: { details?: { reason?: string } } };
  expect(probeBody.error?.details?.reason, 'catalogue apply must be provisioned with the executor').toBe('resource-ref-unknown');

  // Inspect: the selected item is listed with permitted rights and an incorporation grant.
  const search = await page.request.post('/api/workbench/resources/search', { data: { query: 'Button', useProjectContext: false, facets: {}, limit: 50 } });
  expect(search.ok()).toBeTruthy();
  const listed = ((await search.json()) as { results: Array<{ title: string; refKey: string; rightsStatus: string; sourceAttribution: { title: string } }> }).results
    .find(item => item.title === 'Button' && item.sourceAttribution.title.startsWith('shadcn/ui'));
  expect(listed, 'the selected shadcn source must be part of the daemon resource sources').toBeTruthy();
  expect(listed!.rightsStatus).toBe('permitted');

  // The daemon's own dependency report for what it will materialize from the live item.
  const unsatisfied = await cataloguePrepare(page.request, first.id, listed!.refKey);
  const unsatisfiedBody = await unsatisfied.json() as { error?: { details?: { reason?: string } & Partial<DependencyReport> } };
  expect(unsatisfied.status(), JSON.stringify(unsatisfiedBody)).toBe(422);
  expect(unsatisfiedBody.error?.details?.reason).toBe('dependencies-unsatisfied');
  const report: DependencyReport = { missing: unsatisfiedBody.error?.details?.missing ?? [], incompatible: unsatisfiedBody.error?.details?.incompatible ?? [] };
  const declared = [...report.missing.map(d => d.name), ...report.incompatible.map(d => d.name)];
  expect(declared.length, 'an empty manifest leaves every declared dependency unsatisfied').toBeGreaterThan(0);

  // First project: inspect → enlarge → restore → apply (refused: the report) → seed → retry → confirm → save readback.
  let detail = await openShadcnButton(page, first);
  await detail.getByRole('button', { name: 'Enlarge preview' }).click();
  const dialog = page.getByRole('dialog', { name: 'Button', exact: true });
  await expect(dialog).toBeVisible();
  // Open gate (AC-R04.4 isolated preview): shadcn items publish previewCapability `none`, so the
  // enlarged view is the truthful-unavailable panel. This step is NOT preview coverage.
  await expect(dialog.getByTestId('workbench-preview-unavailable')).toBeVisible();
  await expect(dialog.getByTestId('workbench-preview-unavailable')).toHaveAttribute('data-preview-state', 'unavailable');
  await expect(dialog.getByText(/Preview unavailable\..* · adapter-missing/u)).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to preview' }).click();
  await expect(dialog).toHaveCount(0);
  const action = detail.getByTestId('workbench-apply-action');
  await expect(action.getByTestId('workbench-apply-capability')).toContainText('Unverified, apply allowed · acceptance receipt pending');
  await action.getByRole('button', { name: 'Apply to project' }).click();
  await expect(action).toHaveAttribute('data-step', 'refused', { timeout: T.long });
  // W1: every declared package is listed with what it requires and what was found.
  for (const name of declared) {
    const row = action.locator(`[data-testid="workbench-apply-package"][data-package="${name}"]`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText(`${name} · requires`);
  }
  const refused = testInfo.outputPath('dependencies-refused.png');
  await page.screenshot({ path: refused });
  await testInfo.attach('catalogue-apply-dependencies-refused', { path: refused, contentType: 'image/png' });

  // Seed both manifests from the daemon's report: missing at their declared range, incompatible aligned.
  const manifest = JSON.stringify({ dependencies: Object.fromEntries([
    ...report.missing.map(d => [d.name, d.range] as const),
    ...report.incompatible.map(d => [d.name, d.required] as const),
  ]) });
  for (const project of [first, second]) await writeFile(page.request, project.id, 'package.json', manifest);
  // The files the daemon will write, from its own prepared plan (preparing never writes the project).
  const planned = await cataloguePrepare(page.request, first.id, listed!.refKey);
  expect(planned.status(), await planned.text()).toBe(201);
  const catalogue = ((await planned.json()) as { catalogue: { files: Array<{ path: string }>; notices: string[] } }).catalogue;
  const written = [...new Set([...catalogue.files.map(file => file.path), ...catalogue.notices])];
  const component = catalogue.files[0]!.path;

  await action.getByRole('button', { name: 'Retry' }).click();
  await expect(action).toHaveAttribute('data-step', 'prepared', { timeout: T.long });
  await expect(action.getByText(component)).toBeVisible();
  await expect(action.getByText(/shadcn\/ui · MIT/u)).toBeVisible();
  const prepared = testInfo.outputPath('prepared.png');
  await page.screenshot({ path: prepared });
  await testInfo.attach('catalogue-apply-prepared', { path: prepared, contentType: 'image/png' });
  await action.getByRole('button', { name: 'Confirm apply' }).click();
  await expect(action).toHaveAttribute('data-step', 'applied', { timeout: T.long });
  await expect(action.getByRole('status')).toContainText('Applied files');
  for (const file of written) {
    expect((await raw(page.request, first.id, file)).ok(), `${file} saved in the first project`).toBeTruthy();
  }
  expect(await (await raw(page.request, first.id, 'src/App.tsx')).text()).toContain('od:adopted shadcn/button');

  // Second-project reuse: the same admitted reference, its own plan, preimages and undo.
  detail = await openShadcnButton(page, second);
  const reuse = detail.getByTestId('workbench-apply-action');
  await reuse.getByRole('button', { name: 'Apply to project' }).click();
  await expect(reuse).toHaveAttribute('data-step', 'prepared', { timeout: T.long });
  await reuse.getByRole('button', { name: 'Confirm apply' }).click();
  await expect(reuse).toHaveAttribute('data-step', 'applied', { timeout: T.long });
  expect((await raw(page.request, second.id, component)).ok()).toBeTruthy();

  // Undo in the second project restores its exact bytes and leaves the first project applied.
  await reuse.getByRole('button', { name: 'Undo' }).click();
  await expect(reuse).toHaveAttribute('data-step', 'undone', { timeout: T.long });
  await expect(reuse.getByRole('status')).toContainText('Undone');
  expect(await (await raw(page.request, second.id, 'src/App.tsx')).text()).toBe(ENTRY);
  expect((await raw(page.request, second.id, component)).status()).toBe(404);
  expect((await raw(page.request, first.id, component)).ok()).toBeTruthy();
  const undone = testInfo.outputPath('undone.png');
  await page.screenshot({ path: undone });
  await testInfo.attach('catalogue-apply-undone', { path: undone, contentType: 'image/png' });
});
