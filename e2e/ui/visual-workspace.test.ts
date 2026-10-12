import { expect, test } from '@/playwright/suite';
import type { Locator, Page } from '@playwright/test';
import { parseSessionModelSnapshot, type SessionModelSnapshot } from '@mish/contracts';
import {
  captureVisual,
  captureVisualTarget,
  configureVisualPage,
  gotoVisualHome,
  gotoVisualWorkspace,
  mockSignedInVelaAccount,
  prepareVisualConversationPicker,
  prepareVisualWorkspaceFileList,
  prepareVisualWorkspacePreview,
  openSettingsDetailsFromHeader,
  VISUAL_AMR_AGENT,
  VISUAL_CLI_AGENTS,
} from '@/playwright/visual';

// Advertise preferences only in the capture that exercises those controls.
const VISUAL_CODEX_AGENT = VISUAL_CLI_AGENTS.find((agent) => agent.id === 'codex')!;
const VISUAL_CODEX_REASONING_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
] as const;

test('[P2] captures the project workspace surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);

  await captureVisual(page, 'visual-project-workspace');
});

test('[P1] keeps the project account action host anchored to the right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const accountActionsRect = await page
    .getByTestId('workspace-chrome-account-actions')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
  expect(accountActionsRect.left).toBeGreaterThan(1000);
  expect(1280 - accountActionsRect.right).toBeLessThanOrEqual(24);
});

test('[P2] captures the workspace staged attachments surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);
  // Attachments use the composer tray; `staged-contexts` is reserved for
  // run context such as skills, MCP servers, connectors, and plugins. Keep the
  // visual witness on the surface the user actually sees after an upload.
  const uploadResponse = page.waitForResponse(
    (response) => /\/api\/workbench\/intake\/[^/]+\/files\/[^/]+$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'PUT',
  );
  const attachResponse = page.waitForResponse(
    (response) => /\/api\/workbench\/intake\/[^/]+\/attach$/.test(new URL(response.url()).pathname)
      && response.request().method() === 'POST',
  );
  await page.getByTestId('chat-file-input').setInputFiles({
    name: 'visual-reference.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Visual staged-context fixture.\n', 'utf8'),
  });
  expect((await uploadResponse).ok()).toBeTruthy();
  expect((await attachResponse).ok()).toBeTruthy();

  const stagedAttachments = page.getByTestId('staged-attachments');
  await expect(stagedAttachments).toBeVisible();
  // Document cards may middle-truncate their visible basename. The full file
  // name remains the stable title contract on the card.
  await expect(stagedAttachments.getByTitle('visual-reference.txt', { exact: true })).toBeVisible();

  await captureVisual(page, 'visual-workspace-staged-attachments');
});

test('[P1] @critical captures CSS hotspot workspace, preview, and settings surfaces', async ({ page }) => {
  test.setTimeout(90_000);

  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);
  await captureVisual(page, 'visual-critical-workspace');

  await prepareVisualWorkspacePreview(page);
  await captureVisual(page, 'visual-critical-workspace-preview');

  const dialog = await openSettingsDetailsFromHeader(page);
  // Assert the section nav, not a heading — same reason `prepareVisualSettingsDialog`
  // does: the surface's own <h2> is consumed as its accessible name via
  // aria-labelledby, and opening from a project lands on the execution section
  // whose heading reads "Models & providers", so a /Settings|General|Execution
  // mode/ probe can never match either presentation.
  await expect(dialog.getByTestId('settings-nav-execution')).toBeVisible();
  await captureVisual(page, 'visual-critical-settings');
});

test('[P2] captures the topbar execution switcher surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-chip').click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  // Home now exposes execution options through the same inline picker as a
  // conversation. Keep positive mode, agent, model and Settings witnesses.
  await expect(popover.getByTestId('inline-model-switcher-mode-daemon')).toHaveAttribute('aria-pressed', 'true');
  await expect(popover.getByTestId('inline-model-switcher-agent-mock')).toHaveAttribute('aria-checked', 'true');
  await expect(popover.getByTestId('inline-model-switcher-agent-model')).toContainText('Default');
  await expect(popover.getByTestId('inline-model-switcher-open-settings')).toBeVisible();

  await captureVisual(page, 'visual-topbar-execution-switcher');
  await captureVisualTarget(
    page,
    'visual-topbar-execution-switcher-popover',
    page.getByTestId('inline-model-switcher-popover'),
  );
});

test('[P1] captures the topbar signed-in Mishh Mashh model picker', async ({ page }) => {
  test.setTimeout(60_000);

  await configureVisualPage(page, {
    agents: [...VISUAL_CLI_AGENTS, VISUAL_AMR_AGENT],
    config: {
      agentId: 'amr',
      agentModels: { amr: { model: 'deepseek-v4-flash', reasoning: 'default' } },
      agentCliEnv: { amr: { MISH_AMR_PROFILE: 'test' } },
    },
  });
  await mockSignedInVelaAccount(page);
  // Require the popover's own signed-in response before its account capture.
  let velaStatusRequests = 0;
  await page.route('**/api/integrations/vela/status', async (route) => {
    velaStatusRequests += 1;
    await route.fallback();
  });
  await gotoVisualHome(page);

  const requestsBeforeOpen = velaStatusRequests;
  await page.getByTestId('inline-model-switcher-chip').click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  // InlineModelSwitcher refetches the AMR status whenever the popover opens
  // with Mishh Mashh installed, so a landed response proves the signed-in
  // render happened.
  await expect.poll(() => velaStatusRequests).toBeGreaterThan(requestsBeforeOpen);

  // EntryShell intentionally enables the full picker. Its AMR account and
  // searchable catalog replace the former compact model-only surface.
  await expect(popover.getByTestId('inline-model-switcher-agent-amr')).toHaveAttribute('aria-checked', 'true');
  await expect(popover.getByTestId('inline-model-switcher-agent-model')).toContainText('DeepSeek V4 Flash');
  // The card opens on the Model tab; the account row lives on the Agent tab.
  await popover.getByTestId('inline-model-switcher-tab-source').click();
  await expect(popover.locator('.inline-switcher__account')).toBeVisible();
  await expect(popover.getByRole('radio', { name: 'Mishh Mashh plus', exact: true })).toBeVisible();
  // This fixture grants no billing-management permission.
  await expect(popover.getByTestId('inline-model-switcher-account-upgrade')).toHaveCount(0);
  await expect(popover).toContainText('$247.51');

  await captureVisual(page, 'visual-topbar-mish-model-picker');
});

test('[P2] captures the topbar local CLI model list surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'claude',
      agentModels: { claude: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);

  const chip = page.getByTestId('inline-model-switcher-chip');
  await chip.click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('inline-model-switcher-agent-claude')).toHaveAttribute('aria-checked', 'true');
  // One card: the catalog is listed in place on the Model tab.
  const modelList = page.getByTestId('inline-model-switcher-agent-model-popover');
  await expect(modelList.getByRole('option', { name: 'Sonnet (alias)', exact: true })).toBeVisible();
  await expect(modelList.getByRole('option', { name: 'Default (CLI config)', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inline-model-switcher-agent-model-search')).toBeVisible();

  await captureVisual(page, 'visual-topbar-local-cli-model-list');
  await captureVisualTarget(page, 'visual-topbar-local-cli-model-list-popover', [chip, popover, modelList]);
});

test('[P2] captures the topbar BYOK execution switcher surface', async ({ page }) => {
  await configureVisualPage(page, {
    // No local agent, which is the premise the popover assertions below already
    // state ("a BYOK config has no local agent"). `configureVisualPage`
    // otherwise serves `[MOCK_AGENT]` from `/api/agents`; the popover body must
    // derive from `config.mode` either way, so the leanest fixture is the one
    // with nothing else to draw.
    agents: [],
    config: {
      mode: 'api',
      apiKey: 'sk-visual',
      apiProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      agentId: null,
    },
  });
  // Deterministic BYOK catalogue: opening the popover warms the shared
  // provider-models cache through the daemon (`/api/provider/models`), which
  // would otherwise forward the fixture key to the real provider endpoint.
  // The fulfilled list is what the capture and the option assertions render.
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        kind: 'success',
        latencyMs: 1,
        models: [
          { id: 'gpt-4o', label: 'gpt-4o' },
          { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
          { id: 'o3', label: 'o3' },
        ],
      }),
    });
  });
  await gotoVisualHome(page);

  const chip = page.getByTestId('inline-model-switcher-chip');
  await expect(chip.locator('.inline-switcher__byok-glyph')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-label', /gpt-4o/);
  await chip.click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId('inline-model-switcher-mode-api')).toHaveAttribute('aria-pressed', 'true');
  await expect(popover.getByTestId('inline-model-switcher-provider-openai')).toHaveAttribute('aria-pressed', 'true');
  const modelPicker = popover.getByTestId('inline-model-switcher-api-model');
  await expect(modelPicker).toBeVisible();
  await expect(modelPicker).toContainText('gpt-4o');
  await expect(popover.getByTestId('inline-model-switcher-open-settings')).toBeVisible();

  await captureVisual(page, 'visual-topbar-byok-switcher');
  await captureVisualTarget(
    page,
    'visual-topbar-byok-switcher-popover',
    page.getByTestId('inline-model-switcher-popover'),
  );

  // The catalogue is genuinely selectable, not a readout: the card lists the
  // provider's models in place.
  const modelPopover = page.getByTestId('inline-model-switcher-api-model-popover');
  await expect(modelPopover.getByRole('option', { name: 'gpt-4o-mini' })).toBeVisible();
});

test('[P2] captures the conversation model picker surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualConversationPicker(page);

  await captureVisual(page, 'visual-avatar-menu');
  await captureVisualTarget(page, 'visual-avatar-menu-panel', menu);
});

test('[P1] Conversation picker saves the signed-in AMR model choice', async ({ page }) => {
  test.setTimeout(60_000);

  await configureVisualPage(page, {
    agents: [...VISUAL_CLI_AGENTS, VISUAL_AMR_AGENT],
    config: {
      mode: 'daemon',
      agentId: 'amr',
      agentModels: { amr: { model: 'deepseek-v4-flash', reasoning: 'default' } },
      agentCliEnv: { amr: { MISH_AMR_PROFILE: 'test' } },
    },
  });
  await mockSignedInVelaAccount(page);
  // The captured account must include the completed signed-in response.
  let velaStatusRequests = 0;
  await page.route('**/api/integrations/vela/status', async (route) => {
    velaStatusRequests += 1;
    await route.fallback();
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const requestsBeforeOpen = velaStatusRequests;
  const menu = await prepareVisualConversationPicker(page);
  // The inline picker refetches login status on open whenever Mishh Mashh is
  // installed, so a landed response means the signed-in render has happened.
  await expect.poll(() => velaStatusRequests).toBeGreaterThan(requestsBeforeOpen);

  await expect(menu.getByTestId('inline-model-switcher-agent-amr')).toHaveAttribute('aria-checked', 'true');
  await menu.getByTestId('inline-model-switcher-tab-source').click();
  await expect(menu.locator('.inline-switcher__account')).toBeVisible();
  await expect(menu).toContainText('$247.51');
  await menu.getByTestId('inline-model-switcher-tab-model').click();
  const saved = await saveVisualConversationModel(page, menu, 'DeepSeek V4 Flash');
  expect(saved.choice).toEqual({ agentId: 'amr', modelId: 'deepseek-v4-flash' });
  const modelList = page.getByTestId('inline-model-switcher-agent-model-popover');
  await expect(modelList.getByRole('option', { name: 'DeepSeek V4 Flash', exact: true })).toHaveAttribute('aria-selected', 'true');
  await captureVisual(page, 'visual-avatar-mish-model-picker');
});

test('[P2] captures the conversation reasoning and service tier selectors', async ({ page }) => {
  await configureVisualPage(page, {
    // Only advertise preferences the current model/runtime supports.
    agents: [
      {
        ...VISUAL_CODEX_AGENT,
        reasoningOptions: VISUAL_CODEX_REASONING_OPTIONS,
        models: VISUAL_CODEX_AGENT.models.map(model => model.id === 'gpt-5.4'
          ? { ...model, serviceTierOptions: [{ id: 'priority', label: 'Fast' }] }
          : model),
      },
      ...VISUAL_CLI_AGENTS.filter((agent) => agent.id !== 'codex'),
    ],
    config: {
      agentId: 'codex',
      agentModels: { codex: { model: 'gpt-5.4', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualConversationPicker(page);
  const savedModel = await saveVisualConversationModel(page, menu, 'GPT-5.4');
  expect(savedModel.choice).toEqual({ agentId: 'codex', modelId: 'gpt-5.4' });
  const reasoningSelect = menu.getByRole('combobox', { name: 'Reasoning', exact: true });
  await expect(reasoningSelect).toHaveCount(1);
  await expect(reasoningSelect).toHaveValue('default');
  await expect(reasoningSelect.locator('option')).toHaveText(['Default', 'Medium', 'High']);
  const reasoningAck = await saveVisualPreference(page, () => reasoningSelect.selectOption('high'));
  expect(reasoningAck.choice).toEqual(savedModel.choice);
  expect(reasoningAck.revision).toBe(savedModel.revision);
  await expect(reasoningSelect).toHaveValue('high');

  const tierSelect = menu.getByRole('combobox', { name: 'Service tier', exact: true });
  await expect(tierSelect).toHaveValue('default');
  await expect(tierSelect.locator('option')).toHaveText(['Default', 'Fast']);
  const tierAck = await saveVisualPreference(page, () => tierSelect.selectOption('priority'));
  expect(tierAck.choice).toEqual(savedModel.choice);
  expect(tierAck.revision).toBe(savedModel.revision);
  await expect(tierSelect).toHaveValue('priority');
  await expect(reasoningSelect).toHaveValue('high');

  await captureVisual(page, 'visual-avatar-local-agent-list');
  await captureVisualTarget(page, 'visual-avatar-local-agent-list-panel', menu);
});

test('[P2] captures the conversation local agent model list surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'claude',
      agentModels: { claude: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualConversationPicker(page);
  const saved = await saveVisualConversationModel(page, menu, 'Sonnet (alias)');
  expect(saved.choice).toEqual({ agentId: 'claude', modelId: 'sonnet-alias' });
  const modelList = page.getByTestId('inline-model-switcher-agent-model-popover');
  await expect(modelList.getByRole('option', { name: 'Sonnet (alias)', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inline-model-switcher-agent-model-search')).toBeVisible();

  await captureVisual(page, 'visual-project-avatar-model-dropdown');
  await captureVisualTarget(page, 'visual-project-avatar-model-dropdown-popover', [menu, modelList]);
});

/** Capture only an acknowledged conversation choice, never optimistic UI. */
async function saveVisualPreference(page: Page, action: () => Promise<unknown>): Promise<SessionModelSnapshot> {
  const savedResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/workbench/sessions/visual-conversation-launchpad/model'
      && response.request().method() === 'PUT',
  );
  await action();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  const saved = parseSessionModelSnapshot(await response.json());
  expect(saved.projectId).toBe('visual-project-launchpad');
  expect(saved.sessionId).toBe('visual-conversation-launchpad');
  await expect(page.getByTestId('session-model-status')).toHaveCount(0);
  return saved;
}

async function saveVisualConversationModel(page: Page, menu: Locator, name: string): Promise<SessionModelSnapshot> {
  // One card: the catalog is listed in place; picking keeps the card open.
  const modelList = page.getByTestId('inline-model-switcher-agent-model-popover');
  await expect(modelList).toBeVisible();
  const saved = await saveVisualPreference(page, () => modelList.getByRole('option', { name, exact: true }).click());
  expect(saved.revision).toBe(1);
  await expect(modelList.getByRole('option', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  return saved;
}
