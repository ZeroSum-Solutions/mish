import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@/playwright/suite';
import { openNewProjectModal } from '@/playwright/rail';
import { activeArtifactPreviewFrame, settledActiveArtifactPreview } from '@/playwright/artifact-preview';
import { clickPreviewToolbarAction } from '@/playwright/workspace';
import { createFakeAgentRuntimes } from '@/playwright/fake-agents';
import { T } from '@/timeouts';
import { renderAgencySite } from '../../design-templates/agency-site/scripts/render.ts';

const execFileAsync = promisify(execFile);
const template = fileURLToPath(new URL('../../design-templates/agency-site/', import.meta.url));

test('[P1] agency starter survives canvas editing and scopes publication', async ({ page, toolsDev }, testInfo) => {
  test.setTimeout(T.xlong);
  const fake = await createFakeAgentRuntimes({ root: join(toolsDev.root, 'scratch', 'agency-agents') });
  const config = { mode: 'daemon', agentId: 'codex', onboardingCompleted: true, skillId: null, designSystemId: null, agentModels: { codex: { model: 'default', reasoning: 'default' } }, agentCliEnv: { codex: fake.codex.env } };
  const priorConfig = await (await page.request.get('/api/app-config')).json();
  expect((await page.request.put('/api/app-config', { data: config })).ok()).toBeTruthy();
  await page.addInitScript((value) => localStorage.setItem('open-design:config', JSON.stringify(value)), config);
  try {
    const catalog = await (await page.request.get('/api/design-templates')).json();
    expect(catalog.designTemplates.some((s: { id: string }) => s.id === 'agency-site')).toBe(true);
    expect((await page.request.get('/api/skills/agency-site/example')).ok()).toBeTruthy();
    await page.goto('/');
    await openNewProjectModal(page);
    await page.getByTestId('new-project-tab-prototype').click();
    await page.getByTestId('newproj-start-agency-site').click();
    await expect(page.getByTestId('newproj-start-agency-site')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('new-project-name').fill('Agency workflow proof');
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/projects');
    await page.getByTestId('create-project').click();
    const response = await created; expect(response.ok()).toBeTruthy();
    const { project } = await response.json();
    expect(project.skillId).toBe('agency-site');
    const filesUrl = `/api/projects/${project.id}/files`;
    const recipe = JSON.parse(await readFile(join(template, 'scripts/fixtures/jewelry.json'), 'utf8'));
    const rendered = renderAgencySite(recipe, 'site-r1.html');
    const registerThroughCli = async (value: typeof recipe, entry: string) => {
      const recipePath = join(toolsDev.root, 'scratch', `${value.revision}.json`);
      const outDir = join(toolsDev.root, 'scratch', `candidate-${value.revision}`);
      await writeFile(recipePath, JSON.stringify(value));
      await execFileAsync(process.execPath, ['--experimental-strip-types', join(template, 'scripts/compose.ts'), '--input', recipePath, '--assets', join(template, 'assets'), '--out-dir', outDir, '--entry', entry]);
      const emitted = JSON.parse(await readFile(join(outDir, `${entry}.artifact.json`), 'utf8'));
      const cli = [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../../apps/daemon/src/cli.ts', import.meta.url))];
      const call = (args: string[]) => execFileAsync(process.execPath, [...cli, ...args, '--daemon-url', toolsDev.url.daemon('')]);
      for (const file of emitted.supportingFiles) await call(['files', 'upload', project.id, join(outDir, file), '--as', file]);
      await call(['artifacts', 'create', '--project', project.id, '--name', entry, '--input', join(outDir, entry), '--manifest', join(outDir, `${entry}.artifact.json`)]);
      const list = await (await page.request.get(filesUrl)).json();
      expect(list.files.find((f: { name: string }) => f.name === entry).artifactManifest).toMatchObject(emitted);
    };
    for (const name of ['brief.md', 'recipe.json', 'notes.txt', 'prior.html']) {
      expect((await page.request.post(filesUrl, { data: { name, content: 'Private agency working material' } })).ok()).toBeTruthy();
    }
    const registration = { name: 'site-r1.html', content: rendered.html, artifact: true, overwrite: false, artifactManifest: rendered.manifest, versionSource: 'ai', versionLabel: 'Recipe r1' };
    await registerThroughCli(recipe, 'site-r1.html');
    const initialHistory = await (await page.request.get(`${filesUrl}/site-r1.html/versions`)).json();
    const initialVersion = initialHistory.versions.find((v: { current: boolean }) => v.current);
    expect(initialVersion).toBeTruthy();
    await page.goto(`/projects/${project.id}/files/site-r1.html`);
    const preview = activeArtifactPreviewFrame(page);
    await expect(preview.getByRole('heading', { name: 'A quiet kind of presence.' })).toBeVisible();
    await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
    await expect(preview.locator('html[data-od-edit-mode]')).toHaveCount(1);
    const heading = preview.locator('[data-od-id="introduction--title"]');
    await heading.click();
    await expect(heading).toHaveAttribute('data-od-edit-selected', 'true');
    const textInput = page.locator('.manual-edit-modal').getByRole('textbox', { name: 'Text', exact: true });
    await expect(textInput).toHaveValue('A quiet kind of presence.');
    await textInput.fill('A presence of your own.');
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === filesUrl);
    await page.locator('.manual-edit-modal').getByRole('button', { name: /^Save$/ }).click();
    const saveResponse = await saved; expect(saveResponse.ok()).toBeTruthy();
    const saveBody = await saveResponse.json(); expect(saveBody.versionWarning).toBeUndefined();
    await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(activeArtifactPreviewFrame(page).getByRole('heading', { name: 'A presence of your own.' })).toBeVisible();
    const editedSource = await (await page.request.get(`${filesUrl}/site-r1.html`)).text();
    expect(editedSource).toContain('A presence of your own.');
    const fileList = await (await page.request.get(filesUrl)).json();
    expect(fileList.files.find((f: { name: string }) => f.name === 'site-r1.html').artifactManifest.metadata).toEqual(rendered.manifest.metadata);
    const history = await (await page.request.get(`${filesUrl}/site-r1.html/versions`)).json();
    expect(history.versions.filter((v: { current: boolean }) => v.current)).toHaveLength(1);
    expect(history.versions.length).toBeGreaterThan(initialHistory.versions.length);
    const prior = await (await page.request.get(`${filesUrl}/site-r1.html/versions/${initialVersion.id}`)).json();
    expect(prior.content).toContain('A quiet kind of presence.');
    expect((await page.request.post(filesUrl, { data: registration })).ok()).toBe(false);
    expect(await (await page.request.get(`${filesUrl}/site-r1.html`)).text()).toBe(editedSource);
    await registerThroughCli({ ...recipe, revision: 'r2' }, 'site-r2.html');
    expect(await (await page.request.get(`${filesUrl}/site-r1.html`)).text()).toBe(editedSource);
    const editedVersion = history.versions.find((v: { current: boolean }) => v.current);
    for (const version of [initialVersion, editedVersion]) {
      const restored = await page.request.post(`${filesUrl}/site-r1.html/versions/${version.id}/restore`);
      expect(restored.ok(), await restored.text()).toBeTruthy();
      const list = await (await page.request.get(filesUrl)).json();
      expect(list.files.find((f: { name: string }) => f.name === 'site-r1.html').artifactManifest.metadata).toEqual(rendered.manifest.metadata);
    }
    expect(await (await page.request.get(`${filesUrl}/site-r1.html`)).text()).toBe(editedSource);
    const preflightResponse = await page.request.post(`/api/projects/${project.id}/deploy/preflight`, { data: { fileName: 'site-r1.html', providerId: 'vercel-self' } });
    expect(preflightResponse.ok(), await preflightResponse.text()).toBeTruthy();
    const preflight = await preflightResponse.json();
    expect(preflight.files.map((f: { path: string }) => f.path)).toEqual(['index.html', ...rendered.manifest.supportingFiles]);
    const { frame } = await settledActiveArtifactPreview(page, T.long);
    await expect(frame.locator('img')).toHaveCount(1);
    await expect.poll(() => frame.locator('img').evaluateAll((images) => images.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('agency-canvas-edited.png'), fullPage: true });
    await testInfo.attach('workflow-evidence', { body: JSON.stringify({ projectId: project.id, initialVersion, versions: history.versions, preflight, previewUrl: frame.url() }, null, 2), contentType: 'application/json' });
  } finally {
    const restored = await fetch(toolsDev.url.daemon('/api/app-config'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(priorConfig), signal: AbortSignal.timeout(T.short) });
    expect(restored.ok).toBeTruthy();
  }
});
