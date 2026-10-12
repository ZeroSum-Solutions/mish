import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Adoption status agrees with apply-off at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    const response = await page.request.post('/api/projects', { data: { id: `q3-off-${width}-${Date.now()}`, name: 'Apply-off QA', metadata: { kind: 'prototype', nameSource: 'user' } } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const { project, conversationId } = await response.json();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${project.id}/conversations/${conversationId}`);
    await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
    await page.getByTestId('chat-plus-trigger').click();
    await page.getByTestId('composer-plus-resources').click();
    await page.getByRole('textbox', { name: 'Search resources' }).fill('Button');
    await page.getByRole('button', { name: 'Button · unverified', exact: true }).click();
    const detail = page.getByTestId('workbench-resource-detail');
    await expect(detail.getByTestId('workbench-apply-action')).toHaveAttribute('data-step', 'off', { timeout: T.long });
    await expect(detail).toContainText('Apply is off on this machine');
    await expect(detail).not.toContainText('apply allowed');
    await detail.getByTestId('workbench-apply-action').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `../.tmp/q3ux/apply-off-${width}.png`, fullPage: true });
  });
}
