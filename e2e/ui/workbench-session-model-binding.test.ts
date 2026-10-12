import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Locator, Page, Response } from '@playwright/test';
import {
  parseSessionModelChoice,
  parseSessionModelSnapshot,
  parseSessionRunAdmission,
  type SessionModelChoice,
  type SessionModelSnapshot,
  type SessionRunAdmission,
} from '@open-design/contracts';
import { clusterTest, expect } from '@/playwright/suite';
import { createFakeAgentRuntimes, type FakeAgentRuntime } from '@/playwright/fake-agents';
import { routeUnavailableVelaStatus } from '@/playwright/mock-factory';
import {
  PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS,
  PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS,
  warmPlaywrightBrowserRuntime,
  warmPlaywrightDaemonRuntime,
} from '@/playwright/runtime-lifecycle';
import { createToolsDevSuite, e2eWorkspaceRoot } from '@/tools-dev/runtime';
import type { ToolsDevSuite } from '@/tools-dev/types';
import { T } from '@/timeouts';

// AC-R02 (docs/plans/2026-10-02-design-workbench/prd.md), W3 checklist box 4:
// one browser journey across the Home and canvas composers on a real daemon
// with the fake Codex CLI.
//
// - Home binds its choice (model A) to the turn it starts.
// - Switching the canvas composer to model B while that turn runs saves B for
//   the next turn only; the running turn keeps A and finishes.
// - The next turn runs on B, reports `model_changed`, and starts a fresh native
//   thread instead of resuming the old one; a same-model control turn after it
//   does resume, so the fixture can observe a resume at all.
// - The saved choice survives a daemon/web restart in the canvas UI, the
//   session model API and `od workbench model get`.
//
// The lower layers are pinned without a browser:
// e2e/tests/workbench/session-model-change-resume.test.ts (HTTP boundary) and
// apps/daemon/tests/workbench/replay-ac-r02.test.ts (replay rules).

const execFileAsync = promisify(execFile);
const STORAGE_KEY = 'open-design:config';
const MODEL_A = { id: 'gpt-6-sol', label: 'GPT-6 Sol' } as const;
const MODEL_B = { id: 'gpt-6-luna', label: 'GPT-6 Luna' } as const;
// The fake Codex sleeps 15s on this prompt, so the turn is still running while
// the composer switches models.
const SLOW_PROMPT = 'Create a slow reload deterministic smoke artifact';
const FOLLOW_UP_PROMPT = 'Create a follow-up deterministic smoke artifact';

type Receipt = { pid: number; mode: string; event: string; method?: string };
type NativeSessionRecovery = { state: string; guardReason: string | null };
type BindingRuntime = ToolsDevSuite & {
  failed: boolean;
  codex: FakeAgentRuntime;
  runtimeEnv: Record<string, string>;
};

const test = clusterTest.extend<{ bindingPage: Page }, { bindingRuntime: BindingRuntime }>({
  bindingRuntime: [async ({}, use, workerInfo) => {
    const namespace = `session-model-binding-${process.pid}-${workerInfo.workerIndex}`;
    const root = join(e2eWorkspaceRoot(), '.tmp', 'e2e', namespace);
    const scratch = join(root, 'scratch');
    await mkdir(scratch, { recursive: true });
    const fake = await createFakeAgentRuntimes({ root: join(scratch, 'fake-agents'), runtimeIds: ['codex'], recordInvocations: true });
    const runtimeEnv = {
      ...fake.codex.env,
      HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), AMR_HOME: join(scratch, 'amr-home'),
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', VELA_RUNTIME_KEY: '',
      // The fixture records JSON-RPC methods (thread/start vs thread/resume)
      // only on the app-server transport.
      OD_CODEX_TRANSPORT: 'app-server',
    };
    const runtime = Object.assign(createToolsDevSuite({
      namespace, root, ownerPid: process.pid,
      toolsDevRoot: join(scratch, 'tools-dev'), dataDir: join(scratch, 'data'), codexHomeDir: join(scratch, 'codex-home'),
    }), { failed: false, codex: fake.codex, runtimeEnv });
    try {
      await runtime.startWeb(runtimeEnv);
      await warmPlaywrightDaemonRuntime(runtime.url.daemon('/api/health'));
      await use(runtime);
    } catch (error) { runtime.failed = true; throw error; }
    finally { await runtime.stopWeb(runtimeEnv); if (!runtime.failed) await rm(root, { recursive: true, force: true }); }
  }, { scope: 'worker', timeout: PLAYWRIGHT_TOOLS_DEV_FIXTURE_TIMEOUT_MS }],
  baseURL: async ({ bindingRuntime }, use) => { await use(bindingRuntime.url.web()); },
  bindingPage: [async ({ page, bindingRuntime }, use) => {
    await routeUnavailableVelaStatus(page);
    await page.route('https://**', route => route.abort());
    await page.addInitScript(({ key }) => {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'codex', apiKey: '',
        apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiProviderBaseUrl: 'https://api.anthropic.com',
        model: '', agentModels: { codex: { model: 'default', reasoning: 'default' } }, skillId: null, designSystemId: null,
        onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false },
      }));
    }, { key: STORAGE_KEY });
    try {
      await configureDaemon(page, bindingRuntime);
      await warmPlaywrightBrowserRuntime(page, '/', page.getByTestId('home-hero-input'), {
        timeoutMs: PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS - T.short,
      });
      await use(page);
    } catch (error) { bindingRuntime.failed = true; throw error; }
  }, { timeout: PLAYWRIGHT_WEB_WARMUP_TIMEOUT_MS }],
});
test.use({ trace: 'on', screenshot: 'only-on-failure' });
test.afterEach(async ({ bindingRuntime }, info) => { if (info.status !== info.expectedStatus) bindingRuntime.failed = true; });

test('[P0] Home and canvas composers bind the model choice to the next turn, survive restart, and start fresh on a model change', async ({ bindingPage: page, bindingRuntime: runtime }, info) => {
  test.setTimeout(T.xlong * 4);
  const discovery = await page.request.get('/api/agents');
  expect(discovery.ok()).toBeTruthy();
  const discoveredAt = new Date().toISOString();
  const codex = (await discovery.json() as { agents: Array<{ id: string; available: boolean; models: Array<{ id: string; label: string }> }> }).agents
    .find(agent => agent.id === 'codex');
  expect(codex?.available, 'Fake Codex must be discovered by the real daemon').toBe(true);
  for (const model of [MODEL_A, MODEL_B]) {
    expect(codex!.models, `Discovery must offer ${model.label}`).toContainEqual(expect.objectContaining(model));
  }

  // Every turn the browser starts, in order.
  const runResponses: Response[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST') runResponses.push(response);
  });

  // --- Home: choose model A, then start the first turn from the Home composer.
  const home = page.getByTestId('home-hero');
  await pickCodexModel(page, home, MODEL_A.label);
  await expect.poll(() => homeChoice(page)).toMatchObject({ agentId: 'codex', modelId: MODEL_A.id });
  const createdResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST');
  const firstRunResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST', { timeout: T.long });
  await page.getByTestId('home-hero-input').fill(SLOW_PROMPT);
  await page.getByTestId('home-hero-submit').click();
  const created = await (await createdResponse).json() as { project: { id: string }; conversationId: string };
  const projectId = created.project.id;
  const sessionId = created.conversationId;
  const first = await acceptedRun(await firstRunResponse);
  expect(first.body).toMatchObject({ agentId: 'codex', model: MODEL_A.id, conversationId: sessionId });
  expect(first.admission.requested).toEqual({ agentId: 'codex', modelId: MODEL_A.id });
  const modelEndpoint = (base: string) => `${base}/api/workbench/sessions/${sessionId}/model`;
  const readModel = async (base = runtime.url.web()): Promise<SessionModelSnapshot> => {
    const response = await page.request.get(modelEndpoint(base), { headers: { 'x-od-project-id': projectId } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return parseSessionModelSnapshot(await response.json());
  };
  expect((await readModel()).choice).toEqual({ agentId: 'codex', modelId: MODEL_A.id });

  // --- Canvas: switch to model B while the first turn is still running.
  const canvas = page.getByTestId('chat-composer');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/conversations/${sessionId}`));
  await expect(canvas).toBeVisible({ timeout: T.long });
  await expect.poll(() => runStatus(page, runtime.url.web(), first.runId), { message: 'the first turn must be running for this check' }).toBe('running');
  await pickCodexModel(page, canvas, MODEL_B.label);
  await expect.poll(async () => (await readModel()).choice).toEqual({ agentId: 'codex', modelId: MODEL_B.id });
  // The responsive toolbar (fix/chat-composer-responsive) dropped the
  // persistent "Model for the next turn" row for the ready state — keeping
  // it would break the single-row toolbar geometry every time a session is
  // merely idle (e2e/ui/composer-responsive.test.ts pins that invariant).
  // The caption moved to the compact model chip's tooltip/accessible name
  // instead (InlineModelSwitcher's `sessionModel.nextTurn` prefix), which is
  // where this assertion now looks; it still proves the UI is telling the
  // user B, not the still-running A, is bound for the next turn.
  await expect(canvas.getByTestId('inline-model-switcher-chip')).toHaveAccessibleName(
    new RegExp(`Model for the next turn:.*${escaped(MODEL_B.label)}`, 'i'),
  );
  expect(await runStatus(page, runtime.url.web(), first.runId), 'switching models must not stop the running turn').toBe('running');
  expect(runResponses, 'switching models must not start or restart a turn').toHaveLength(1);

  // The running turn finishes on A.
  await expect.poll(() => runStatus(page, runtime.url.web(), first.runId), { timeout: T.xlong }).toBe('succeeded');
  const firstRow = (await conversationMessages(page, runtime.url.web(), projectId, sessionId)).find(message => message.runId === first.runId);
  expect(firstRow?.modelAdmission?.requested).toEqual({ agentId: 'codex', modelId: MODEL_A.id });
  expect(runResponses).toHaveLength(1);

  // --- Next turn from the canvas composer runs on B and starts a fresh native session.
  let pids = await receiptPids(runtime);
  const second = await acceptedRun(await sendCanvasPrompt(page, FOLLOW_UP_PROMPT));
  expect(second.body).toMatchObject({ agentId: 'codex', model: MODEL_B.id });
  expect(second.admission.requested).toEqual({ agentId: 'codex', modelId: MODEL_B.id });
  expect(second.admission.replayNotice?.reason).toBe('model-switch');
  expect(second.admission.replayNotice?.includedMessages ?? 0, 'the fresh session receives the earlier turn as transcript').toBeGreaterThanOrEqual(2);
  await expect.poll(() => runStatus(page, runtime.url.web(), second.runId), { timeout: T.xlong }).toBe('succeeded');
  expect(await nativeSessionRecovery(page, runtime.url.web(), second.runId)).toMatchObject({ state: 'resume_skipped', guardReason: 'model_changed' });
  const secondMethods = await appServerMethodsSince(runtime, pids);
  expect(secondMethods).toContain('thread/start');
  expect(secondMethods, 'the old native thread id must not be passed').not.toContain('thread/resume');

  // Control: another turn on the same saved model does resume.
  pids = await receiptPids(runtime);
  const third = await acceptedRun(await sendCanvasPrompt(page, FOLLOW_UP_PROMPT));
  expect(third.admission.requested).toEqual({ agentId: 'codex', modelId: MODEL_B.id });
  await expect.poll(() => runStatus(page, runtime.url.web(), third.runId), { timeout: T.xlong }).toBe('succeeded');
  expect(await nativeSessionRecovery(page, runtime.url.web(), third.runId)).toMatchObject({ state: 'resume_attempted' });
  expect(await appServerMethodsSince(runtime, pids)).toContain('thread/resume');

  const beforeRestart = await readModel();
  expect(beforeRestart.choice).toEqual({ agentId: 'codex', modelId: MODEL_B.id });
  const beforeShot = info.outputPath('session-model-before-restart.png');
  await page.screenshot({ path: beforeShot });
  await info.attach('session-model-before-restart', { path: beforeShot, contentType: 'image/png' });

  // --- Restart daemon and web on the same data root; the saved choice survives.
  await runtime.stopWeb(runtime.runtimeEnv);
  await runtime.startWeb(runtime.runtimeEnv);
  await warmPlaywrightDaemonRuntime(runtime.url.daemon('/api/health'));
  const base = runtime.url.web();
  await configureDaemon(page, runtime, base);
  await warmPlaywrightBrowserRuntime(page, `${base}/projects/${projectId}/conversations/${sessionId}`, canvas.getByTestId('chat-composer-input'));
  const afterRestart = await readModel(base);
  expect(afterRestart).toEqual(beforeRestart);
  const popup = await openPicker(page, canvas);
  await showTab(popup, 'source');
  await expect(popup.getByTestId('inline-model-switcher-agent-codex')).toHaveAttribute('aria-checked', 'true');
  await showTab(popup, 'model');
  await expect(page.getByTestId('inline-model-switcher-agent-model-popover').getByRole('option', { selected: true })).toContainText(MODEL_B.label);
  const afterShot = info.outputPath('session-model-after-restart.png');
  await page.screenshot({ path: afterShot });
  await info.attach('session-model-after-restart', { path: afterShot, contentType: 'image/png' });
  await closePicker(page, canvas);
  const { stdout } = await execFileAsync(process.execPath, [
    join(e2eWorkspaceRoot(), 'apps/daemon/dist/cli.js'), 'workbench', 'model', 'get',
    '--session', sessionId, '--project', projectId, '--daemon-url', runtime.url.daemon(), '--json',
  ], { timeout: T.medium, env: { ...process.env, HOME: join(runtime.root, 'scratch', 'home'), OD_DAEMON_URL: runtime.url.daemon() } });
  expect(parseSessionModelSnapshot(JSON.parse(stdout))).toEqual(afterRestart);
  // Opening the conversation after restart did not start a turn.
  expect(runResponses).toHaveLength(3);

  await info.attach('session-model-binding-identity', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    projectId, sessionId, discoveredAt, offered: [MODEL_A, MODEL_B],
    runs: [first, second, third].map(run => ({ runId: run.runId, requested: run.admission.requested, replayNotice: run.admission.replayNotice ?? null })),
    savedChoice: afterRestart,
    limits: ['Real daemon, web and od CLI; fake Codex app-server CLI', 'No provider account, credentials or subscription run'],
  }, null, 2)) });
});

async function configureDaemon(page: Page, runtime: BindingRuntime, base = ''): Promise<void> {
  const response = await page.request.put(`${base}/api/app-config`, { data: {
    onboardingCompleted: true, agentId: 'codex',
    agentModels: { codex: { model: 'default', reasoning: 'default' } },
    agentCliEnv: { codex: runtime.codex.env },
    skillId: null, designSystemId: null, odNextStrategyMode: 'off',
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function openPicker(page: Page, host: Locator): Promise<Locator> {
  const popup = host.getByTestId('inline-model-switcher-popover');
  if (!await popup.isVisible()) await host.getByTestId('inline-model-switcher-chip').click();
  await expect(popup).toBeVisible();
  return popup;
}
/** The picker is one card with two tabs: Model (the catalog) and Agent/Provider. */
async function showTab(popup: Locator, tab: 'model' | 'source'): Promise<void> {
  const control = popup.getByTestId(`inline-model-switcher-tab-${tab}`);
  if (await control.getAttribute('aria-selected') !== 'true') await control.click();
  await expect(control).toHaveAttribute('aria-selected', 'true');
}
async function closePicker(page: Page, host: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3 && await host.getByTestId('inline-model-switcher-popover').isVisible(); attempt++) await page.keyboard.press('Escape');
  await expect(host.getByTestId('inline-model-switcher-popover')).toBeHidden();
}
async function pickCodexModel(page: Page, host: Locator, label: string): Promise<void> {
  const popup = await openPicker(page, host);
  await showTab(popup, 'source');
  await popup.getByTestId('inline-model-switcher-mode-daemon').click();
  await popup.getByTestId('inline-model-switcher-agent-codex').click();
  await showTab(popup, 'model');
  const option = page.getByTestId('inline-model-switcher-agent-model-popover').getByRole('option', { name: new RegExp(`^${escaped(label)}$`, 'i') });
  await expect(option, `Codex model ${label} must be selectable`).toBeVisible();
  await option.click();
  await closePicker(page, host);
}
async function homeChoice(page: Page): Promise<SessionModelChoice> {
  return parseSessionModelChoice(await page.evaluate(() => {
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith('od:home-model-choice:'));
    if (keys.length !== 1) throw new Error(`Expected one public Home choice, received ${keys.length}`);
    return JSON.parse(sessionStorage.getItem(keys[0]!)!);
  }));
}

async function sendCanvasPrompt(page: Page, prompt: string): Promise<Response> {
  const input = page.getByTestId('chat-composer-input');
  const send = page.getByTestId('chat-send');
  await input.click();
  await input.fill(prompt);
  await expect(send).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST', { timeout: T.long }),
    send.click(),
  ]);
  return response;
}
async function acceptedRun(response: Response): Promise<{ runId: string; body: Record<string, unknown>; admission: SessionRunAdmission }> {
  expect(response.status(), await response.text()).toBe(202);
  const result = await response.json() as { runId: string; modelAdmission: unknown };
  return { runId: result.runId, body: response.request().postDataJSON() as Record<string, unknown>, admission: parseSessionRunAdmission(result.modelAdmission) };
}
async function runStatus(page: Page, base: string, runId: string): Promise<string> {
  const response = await page.request.get(`${base}/api/runs/${encodeURIComponent(runId)}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { status: string }).status;
}
async function conversationMessages(page: Page, base: string, projectId: string, sessionId: string) {
  const response = await page.request.get(`${base}/api/projects/${projectId}/conversations/${sessionId}/messages`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { messages: Array<{ id: string; runId?: string; modelAdmission?: SessionRunAdmission }> }).messages;
}
/** The guard decision the daemon published before spawning the turn's native process. */
async function nativeSessionRecovery(page: Page, base: string, runId: string): Promise<NativeSessionRecovery | null> {
  const response = await page.request.get(`${base}/api/runs/${encodeURIComponent(runId)}/events`);
  expect(response.ok()).toBeTruthy();
  for (const line of (await response.text()).split('\n')) {
    if (!line.startsWith('data:') || !line.includes('native_session_recovery')) continue;
    try {
      const payload = JSON.parse(line.slice(5).trim()) as { type?: string; nativeSessionRecovery?: NativeSessionRecovery };
      if (payload.type === 'native_session_recovery' && payload.nativeSessionRecovery) return payload.nativeSessionRecovery;
    } catch { /* not a JSON frame */ }
  }
  return null;
}
async function readReceipts(runtime: BindingRuntime): Promise<Receipt[]> {
  const text = await readFile(runtime.codex.invocation!.path, 'utf8');
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line) as Receipt) : [];
}
async function receiptPids(runtime: BindingRuntime): Promise<Set<number>> {
  return new Set((await readReceipts(runtime)).map(receipt => receipt.pid));
}
async function appServerMethodsSince(runtime: BindingRuntime, before: Set<number>): Promise<Array<string | undefined>> {
  return (await readReceipts(runtime))
    .filter(receipt => receipt.mode === 'app-server' && receipt.event === 'request' && !before.has(receipt.pid))
    .map(receipt => receipt.method);
}
