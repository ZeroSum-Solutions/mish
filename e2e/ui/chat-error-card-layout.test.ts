import { expect, test } from '@/playwright/suite';
import type { Locator, Page } from '@playwright/test';

import {
  AMR_PERSONAL_WORKSPACE_HEADERS,
  createProjectViaApi,
  gotoProject,
  mockAmrWalletSnapshot,
  putAppConfig,
  seedBrowserConfig,
} from '@/playwright/amr';
import { runErrorCard } from '@/playwright/chat';
import { routeAgents } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

const AMR_AGENT = {
  id: 'amr',
  name: 'Mishh Mashh AMR',
  bin: 'vela',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

async function seedBalanceFailure(page: Page, locale: 'en') {
  await page.addInitScript((nextLocale) => {
    window.localStorage.setItem('open-design:locale', nextLocale);
    window.localStorage.setItem('open-design:locale-source', 'manual');
    window.localStorage.setItem('open-design.project.chatPanelWidth', '320');
  }, locale);
  await routeAgents(page, [AMR_AGENT]);
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [] } }));
  await page.route('**/api/design-templates', (route) =>
    route.fulfill({ json: { designTemplates: [] } }));
  await page.route('**/api/design-systems', (route) =>
    route.fulfill({ json: { designSystems: [] } }));
  await page.route('**/api/integrations/vela/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        loggedIn: true,
        profile: 'local',
        configPath: '/tmp/.amr/config.json',
        user: { id: 'layout-user', email: 'layout@example.com', plan: 'free' },
      }),
    }));
  await mockAmrWalletSnapshot(page, {
    profile: 'local',
    plan: 'free',
    balanceUsd: '0.00',
  });

  const config = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: 'amr',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    mediaProviders: {},
    agentModels: {
      amr: { model: 'default', reasoning: 'default' },
    },
  };
  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = `chat-error-layout-${locale}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-');
  const { conversationId } = await createProjectViaApi(
    page,
    projectId,
    `Chat error card ${locale}`,
  );
  const userMessageId = `u-${projectId}`;
  const userResponse = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${userMessageId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'user',
        content: 'Generate a landing page',
        createdAt: Date.now() - 2_000,
      },
    },
  );
  expect(userResponse.ok(), `upsert user message: ${await userResponse.text()}`).toBeTruthy();

  const assistantResponse = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/a-${projectId}`,
    {
      headers: { ...AMR_PERSONAL_WORKSPACE_HEADERS },
      data: {
        role: 'assistant',
        content: '',
        agentId: 'amr',
        runId: `run-${projectId}`,
        runStatus: 'failed',
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
        preTurnFileNames: [],
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: 'AMR Cloud reported insufficient balance.',
            code: 'AMR_INSUFFICIENT_BALANCE',
          },
        ],
      },
    },
  );
  expect(
    assistantResponse.ok(),
    `upsert assistant message: ${await assistantResponse.text()}`,
  ).toBeTruthy();

  await gotoProject(page, projectId);
  const split = page.locator('.split');
  await expect(split).toBeVisible({ timeout: T.long });
  await split.evaluate((element) => {
    (element as HTMLElement).style.setProperty('--project-chat-panel-width', '320px');
  });
}

async function expectUpgradeCardContained(
  card: Locator,
  upgradeAction: Locator,
) {
  await expect(upgradeAction).toBeVisible();
  await upgradeAction.click({ trial: true });

  const layout = await card.evaluate((element) => {
    const button = element.querySelector<HTMLElement>('button');
    const cardRect = element.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect() ?? null;
    return {
      cardClientWidth: element.clientWidth,
      cardScrollWidth: element.scrollWidth,
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      buttonLeft: buttonRect?.left ?? -1,
      buttonRight: buttonRect?.right ?? -1,
      buttonWidth: buttonRect?.width ?? -1,
      buttonHeight: buttonRect?.height ?? -1,
    };
  });

  // The 320px split leaves 276px of content width inside the real upgrade card.
  // Pin that geometry so a wider test viewport cannot hide this regression.
  expect(layout.cardClientWidth).toBe(276);
  expect(layout.cardScrollWidth).toBe(layout.cardClientWidth);
  expect(layout.buttonWidth).toBeGreaterThan(0);
  expect(layout.buttonHeight).toBeGreaterThan(0);
  expect(layout.buttonLeft).toBeGreaterThanOrEqual(layout.cardLeft);
  expect(layout.buttonRight).toBeLessThanOrEqual(layout.cardRight);
}

test("[P1] en balance recovery actions stay inside a narrow ChatPane", async ({ page }) => {
  await seedBalanceFailure(page, "en");

  const card = page.getByTestId('chat-upgrade-card');
  await expect(card).toHaveAttribute('data-out', 'true', { timeout: T.long });
  await expect(card).toContainText('$0.00');
  await expect(card).toContainText("You can’t start a new task right now");
  await expect(runErrorCard(page)).toHaveCount(0);
  await expectUpgradeCardContained(card, card.getByRole('button', { name: "Upgrade" }));
});

test('[P1] expanded English balance actions stay inside a narrow ChatPane', async ({ page }) => {
  await seedBalanceFailure(page, 'en');

  const card = page.getByTestId('chat-upgrade-card');
  await expect(card).toHaveAttribute('data-out', 'true', { timeout: T.long });
  await expect(card).toContainText('$0.00');
  await expect(card).toContainText('You can’t start a new task right now');
  await expect(runErrorCard(page)).toHaveCount(0);
  const upgrade = card.getByRole('button', { name: 'Upgrade' });
  await expectUpgradeCardContained(card, upgrade);
});
