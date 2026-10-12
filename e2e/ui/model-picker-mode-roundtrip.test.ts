import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Locator, Page } from '@playwright/test';
import { parseSessionModelChoice, parseSessionModelSnapshot, type SessionModelChoice } from '@mish/contracts';
import { clusterTest, expect } from '@/playwright/suite';
import { createFakeAgentRuntimes } from '@/playwright/fake-agents';
import { routeUnavailableVelaStatus } from '@/playwright/mock-factory';
import { warmPlaywrightBrowserRuntime, warmPlaywrightDaemonRuntime, PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS, PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS } from '@/playwright/runtime-lifecycle';
import { createToolsDevSuite, e2eWorkspaceRoot } from '@/tools-dev/runtime';
import type { ToolsDevSuite } from '@/tools-dev/types';
import { T } from '@/timeouts';

const execFileAsync = promisify(execFile);
const storageKey = 'mish:config';
type Runtime = ToolsDevSuite & { failed: boolean };
type ReadyPage = { page: Page; generationRequests: () => number };
// The fake binaries enter the isolated daemon environment BEFORE startup.
// This avoids changing Settings/credentials or depending on host CLI installs.
const test = clusterTest.extend<{ pickerPage: ReadyPage }, { pickerRuntime: Runtime }>({
  pickerRuntime: [async ({}, use, workerInfo) => {
    const namespace = `picker-roundtrip-${process.pid}-${workerInfo.workerIndex}`;
    const root = join(e2eWorkspaceRoot(), '.tmp', 'e2e', namespace);
    const scratch = join(root, 'scratch'); await mkdir(scratch, { recursive: true });
    const fake = await createFakeAgentRuntimes({ root: join(scratch, 'fake-agents'), runtimeIds: ['claude', 'opencode'] });
    const runtime = Object.assign(createToolsDevSuite({ namespace, root, ownerPid: process.pid,
      toolsDevRoot: join(scratch, 'tools-dev'), dataDir: join(scratch, 'data'), codexHomeDir: join(scratch, 'codex-home'),
    }), { failed: false });
    try {
      await runtime.startWeb({ ...fake.claude.env, ...fake.opencode.env,
        HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), AMR_HOME: join(scratch, 'amr-home'),
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', VELA_RUNTIME_KEY: '',
      });
      await warmPlaywrightDaemonRuntime(runtime.url.daemon('/api/health'));
      // The page fixture warms HTML AND client bootstrap in the same browser.
      await use(runtime);
    } catch (error) { runtime.failed = true; throw error; }
    finally { await runtime.stopWeb(); if (!runtime.failed) await rm(root, { recursive: true, force: true }); }
  }, { scope: 'worker', timeout: PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS }],
  baseURL: async ({ pickerRuntime }, use) => { await use(pickerRuntime.url.web()); },
  pickerPage: [async ({ page, pickerRuntime }, use, info) => {
    await routeUnavailableVelaStatus(page);
    await page.route('https://**', route => route.abort());
    let generationRequests = 0;
    await page.route('**/api/runs', async route => {
      if (route.request().method() === 'POST') { generationRequests++; await route.abort(); }
      else await route.continue();
    });
    await page.addInitScript(({ key }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'claude', apiKey: '',
        apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiProviderBaseUrl: 'https://api.anthropic.com',
        model: '', agentModels: { claude: { model: 'default' } }, skillId: null, designSystemId: null,
        onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false },
      }));
    }, { key: storageKey });
    try {
      const started = Date.now();
      await warmPlaywrightBrowserRuntime(page, '/', page.getByTestId('home-hero-input'), {
        timeoutMs: PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS - T.short,
      });
      await info.attach('picker-browser-ready', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        url: page.url(), elapsedMs: Date.now() - started, sameJourneyPage: true,
        appMounted: await page.locator('html').getAttribute('data-od-app-mounted'),
        editorEditable: await page.getByTestId('home-hero-input').isEditable(),
        bootstrapBudgetMs: PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS,
      })) });
      await use({ page, generationRequests: () => generationRequests });
    } catch (error) { pickerRuntime.failed = true; throw error; }
  }, { timeout: PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS }],
});
test.use({ trace: 'on', screenshot: 'only-on-failure' });
test.afterEach(async ({ pickerRuntime }, info) => { if (info.status !== info.expectedStatus) pickerRuntime.failed = true; });

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function openPicker(page: Page, host: Locator) {
  const popup = host.getByTestId('inline-model-switcher-popover');
  if (!await popup.isVisible()) await host.getByTestId('inline-model-switcher-chip').click();
  await expect(popup).toBeVisible();
  const viewportWidth = page.viewportSize()?.width ?? await page.evaluate(() => innerWidth);
  await expect.poll(async () => {
    const bounds = await popup.boundingBox();
    return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= viewportWidth;
  }, { message: 'The complete model picker must fit horizontally in the viewport' }).toBe(true);
  return popup;
}
/** The picker is one card with two tabs: Model (the catalog) and Agent/Provider. */
async function showTab(popup: Locator, tab: 'model' | 'source') {
  const control = popup.getByTestId(`inline-model-switcher-tab-${tab}`);
  if (await control.getAttribute('aria-selected') !== 'true') await control.click();
  await expect(control).toHaveAttribute('aria-selected', 'true');
}
async function closePicker(page: Page, host: Locator) {
  for (let attempt = 0; attempt < 3 && await host.getByTestId('inline-model-switcher-popover').isVisible(); attempt++) await page.keyboard.press('Escape');
  await expect(host.getByTestId('inline-model-switcher-popover')).toBeHidden();
}
async function pickLocalModel(page: Page, host: Locator, label: string) {
  const popup = await openPicker(page, host);
  await showTab(popup, 'source');
  await popup.getByTestId('inline-model-switcher-mode-daemon').click();
  await popup.getByTestId('inline-model-switcher-agent-claude').click();
  await showTab(popup, 'model');
  const list = page.getByTestId('inline-model-switcher-agent-model-popover');
  const option = list.getByRole('option', { name: new RegExp(`^${escaped(label)}$`, 'i') });
  await expect(option, `Published Claude model ${label} must be selectable`).toBeVisible();
  await option.click(); await closePicker(page, host);
}
async function homeChoice(page: Page): Promise<SessionModelChoice> {
  return parseSessionModelChoice(await page.evaluate(() => {
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith('od:home-model-choice:'));
    if (keys.length !== 1) throw new Error(`Expected one public Home choice, received ${keys.length}`);
    return JSON.parse(sessionStorage.getItem(keys[0]!)!);
  }));
}

// One browser witness for the complete Home -> real Conversation boundary.
// Persistence endpoints and discovery remain real; no generation request is sent.
test('[P0] Home and Canvas retain local and keyless BYOK choices through repeated mode roundtrips', async ({ pickerPage, pickerRuntime }, info) => {
  test.setTimeout(T.xlong);
  const { page } = pickerPage;
  const discovery = await page.request.get('/api/agents'); expect(discovery.ok()).toBeTruthy();
  const agents = (await discovery.json() as { agents: Array<{ id: string; available: boolean; models: Array<{ id: string; label: string; enabled?: boolean }> }> }).agents;
  const claude = agents.find(agent => agent.id === 'claude');
  expect(claude?.available, 'Fake Claude must be discovered by the real daemon').toBe(true);
  const models = ['opus', 'sonnet', 'haiku'].map(family => {
    const model = claude!.models.find(model => model.id.startsWith('claude-') && model.id.includes(family) && model.enabled !== false);
    expect(model, `Real discovery must offer an enabled ${family} model; no invented model fallback`).toBeDefined(); return model!;
  });
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  const defaultsBefore = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  const home = page.getByTestId('home-hero');
  const choices: SessionModelChoice[] = [];
  let byok: SessionModelChoice | undefined;

  async function roundtrip(host: Locator, readChoice: () => Promise<SessionModelChoice>, model: typeof models[number]) {
    await pickLocalModel(page, host, model.label);
    await expect.poll(readChoice).toMatchObject({ agentId: 'claude', modelId: model.id });
    let popup = await openPicker(page, host);
    await showTab(popup, 'source');
    await popup.getByTestId('inline-model-switcher-mode-api').click();
    popup = await openPicker(page, host);
    if (!byok) {
      await showTab(popup, 'source');
      await popup.getByTestId('inline-model-switcher-provider-openai').click();
      popup = await openPicker(page, host);
      await showTab(popup, 'model');
      const offered = page.getByTestId('inline-model-switcher-api-model-popover').getByRole('option');
      await expect(offered.first(), 'Keyless BYOK must offer a draft model, without claiming provider readiness').toBeVisible();
      await offered.first().click();
      await expect(page.getByTestId('session-model-status')).toHaveCount(0);
      await expect.poll(readChoice).toMatchObject({ agentId: 'byok-opencode', byokBinding: { protocol: 'openai' } });
      byok = await readChoice();
      expect(byok.modelId).not.toBe('default');
    } else await expect.poll(readChoice).toEqual(byok);
    choices.push(await readChoice());
    popup = await openPicker(page, host);
    await expect(popup.getByTestId('inline-model-switcher-mode-api')).toHaveAttribute('aria-pressed', 'true');
    await showTab(popup, 'source');
    await popup.getByTestId('inline-model-switcher-mode-daemon').click();
    popup = await openPicker(page, host);
    // Do not repair the bug by clicking the Local agent again here.
    await expect.poll(readChoice).toMatchObject({ agentId: 'claude', modelId: model.id });
    await expect(popup.getByTestId('inline-model-switcher-mode-daemon')).toHaveAttribute('aria-pressed', 'true');
    await expect(popup.getByTestId('inline-model-switcher-agent-claude')).toHaveAttribute('aria-checked', 'true');
    await closePicker(page, host);
    await openPicker(page, host); await closePicker(page, host);
  }
  for (const model of models) await roundtrip(home, () => homeChoice(page), model);
  await warmPlaywrightBrowserRuntime(page, '/', page.getByTestId('home-hero-input'), { reload: true });
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await expect.poll(() => homeChoice(page)).toMatchObject({ agentId: 'claude', modelId: models[2]!.id });

  const chip = home.getByTestId('inline-model-switcher-chip');
  await expect(chip).toHaveAttribute('aria-label', /Claude/i);
  await chip.focus(); await page.keyboard.press('Enter');
  const popup = home.getByTestId('inline-model-switcher-popover'); const modelTrigger = popup.getByTestId('inline-model-switcher-agent-model');
  await expect(modelTrigger).toBeVisible();
  const bounds = await popup.boundingBox(); const triggerBounds = await modelTrigger.boundingBox();
  expect(bounds).not.toBeNull(); expect(triggerBounds).not.toBeNull();
  expect(triggerBounds!.y - bounds!.y, 'Local model selector must sit near the popup top').toBeLessThan(180);
  let reached = await modelTrigger.evaluate(element => element.contains(document.activeElement));
  for (let step = 0; step < 12 && !reached; step++) { await page.keyboard.press('Tab'); reached = await modelTrigger.evaluate(element => element.contains(document.activeElement)); }
  expect(reached, 'The in-card model list must be reachable from the chip with keyboard navigation').toBe(true);
  await expect(page.getByTestId('inline-model-switcher-agent-model-popover')).toBeVisible();
  const screenshot = info.outputPath('model-picker-home-keyboard.png'); await page.screenshot({ path: screenshot });
  await info.attach('model-picker-home-keyboard', { path: screenshot, contentType: 'image/png' }); await closePicker(page, home);

  const projectId = randomUUID();
  const project = await page.request.post('/api/projects', { data: { id: projectId, name: 'Picker roundtrip proof', skillId: null, designSystemId: null, metadata: { kind: 'prototype' }, pendingPrompt: null } });
  expect(project.ok(), await project.text()).toBeTruthy();
  const created = await page.request.post(`/api/projects/${projectId}/conversations`, { data: { title: 'Picker choices only', sessionMode: 'design' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const sessionId = (await created.json() as { conversation: { id: string } }).conversation.id;
  const endpoint = `/api/workbench/sessions/${sessionId}/model`;
  const readCanvas = async () => {
    const response = await page.request.get(endpoint, { headers: { 'x-od-project-id': projectId } });
    expect(response.ok(), await response.text()).toBeTruthy(); return parseSessionModelSnapshot(await response.json());
  };
  const canvas = page.getByTestId('chat-composer');
  await warmPlaywrightBrowserRuntime(page, `/projects/${projectId}/conversations/${sessionId}`, canvas.getByTestId('chat-composer-input'));
  await expect(canvas).toBeVisible();
  // A Conversation has its own provider/model draft; select it once, then preserve it.
  byok = undefined;
  for (const model of models) {
    await roundtrip(canvas, async () => { const choice = (await readCanvas()).choice; expect(choice).not.toBeNull(); return choice!; }, model);
    const snapshot = await readCanvas();
    const { stdout } = await execFileAsync(process.execPath, [join(e2eWorkspaceRoot(), 'apps/daemon/dist/cli.js'), 'workbench', 'model', 'get', '--session', sessionId, '--project', projectId, '--daemon-url', pickerRuntime.url.daemon(), '--json'], { timeout: T.medium, env: { ...process.env, HOME: join(pickerRuntime.root, 'scratch', 'home'), OD_DAEMON_URL: pickerRuntime.url.daemon() } });
    expect(parseSessionModelSnapshot(JSON.parse(stdout))).toEqual(snapshot);
  }
  const final = await readCanvas();
  await warmPlaywrightBrowserRuntime(page, page.url(), canvas.getByTestId('chat-composer-input'), { reload: true });
  await expect(canvas).toBeVisible();
  await openPicker(page, canvas);
  await expect(canvas.getByTestId('inline-model-switcher-agent-claude')).toHaveAttribute('aria-checked', 'true');
  await expect(canvas.getByTestId('inline-model-switcher-agent-model-popover').getByRole('option', { selected: true })).toContainText(models[2]!.label);
  const canvasScreenshot = info.outputPath('model-picker-canvas.png');
  await page.screenshot({ path: canvasScreenshot });
  await info.attach('model-picker-canvas', { path: canvasScreenshot, contentType: 'image/png' });
  expect(await readCanvas()).toEqual(final);
  await closePicker(page, canvas);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey)).toMatchObject({ agentId: defaultsBefore.agentId, agentModels: defaultsBefore.agentModels, apiKey: '' });
  expect(pickerPage.generationRequests()).toBe(0);
  await info.attach('model-picker-roundtrip-identity', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ projectId, sessionId, offeredModels: models, byokDrafts: choices, final, limits: ['Real source daemon/model APIs and compiled od; fake CLI discovery', 'No generation, provider availability, credentials or Settings mutation tested'] }, null, 2)) });
});
