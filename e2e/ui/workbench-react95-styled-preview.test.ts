import { randomUUID } from 'node:crypto';
import { test, expect } from '@/playwright/suite';
import { routeMockAgents, routeAppConfig, STORAGE_KEY } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

// R07 round 3 live proof on the real local UI/API chain (no workbench route mocks): a React95
// kit template found through search is inspected as a styled-components preview, and its
// Enlarge view reports ready only once the runtime's style[data-styled] sheet holds rules.
// Replaces the batch 5+6 gap spec (no live styled-components source existed before 7+8).
test('[P1] React95 template previews through the styled-components adapter from search to Enlarge', async ({ page }, testInfo) => {
  test.setTimeout(T.xlong * 2);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await routeMockAgents(page);
  await routeAppConfig(page);
  await page.addInitScript(({ key }) => {
    if (window !== window.top) return;
    localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } }));
  }, { key: STORAGE_KEY });
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = await page.request.post('/api/projects', { data: { id: randomUUID(), name: 'R07 React95', skillId: null, designSystemId: null, metadata: { kind: 'prototype', nameSource: 'user' } } });
  expect(project.ok()).toBeTruthy();
  const created = await project.json();
  await page.goto(`/projects/${created.project.id}/conversations/${created.conversationId}`);
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });

  await page.getByTestId('chat-plus-trigger').click();
  await page.getByTestId('composer-plus-resources').click();
  // Retro intent in the query: React95 is offered only when the user asks for it (AC-R17.4).
  await page.getByRole('textbox', { name: 'Search resources' }).fill('windows 95 application window');
  const title = 'React95 · Windows95 application window';
  const result = page.getByRole('button', { name: new RegExp(`^${title} · `, 'u') });
  await expect(result.first()).toBeVisible({ timeout: T.long });
  await result.first().click();
  const detail = page.getByTestId('workbench-resource-detail');
  await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: T.long });

  // Inspect: the styled-components adapter and its target dependency.
  const preview = detail.locator('[data-preview-adapter="styled-components"]');
  await expect(preview).toHaveAttribute('data-preview-state', 'ready', { timeout: T.long });
  await expect(detail.getByTestId('workbench-target-dependencies')).toContainText('styled-components');
  // Ready means the runtime's sheet holds rules, not only that the document loaded.
  const frame = detail.locator('iframe').contentFrame();
  await expect.poll(() => frame.locator('html').evaluate(() => Array.from(document.querySelectorAll('style[data-styled]'))
    .reduce((total, sheet) => total + ((sheet as HTMLStyleElement).sheet?.cssRules.length ?? 0), 0))).toBeGreaterThan(0);
  await expect(frame.locator('[data-od-react95="window-app"]')).toBeVisible();

  // Enlarge: the same adapter reaches ready in the dialog.
  await detail.getByRole('button', { name: 'Enlarge preview' }).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-preview-adapter="styled-components"]')).toHaveAttribute('data-preview-state', 'ready', { timeout: T.long });
  const path = testInfo.outputPath('react95-enlarged.png');
  await page.screenshot({ path });
  await testInfo.attach('react95-enlarged', { path, contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
