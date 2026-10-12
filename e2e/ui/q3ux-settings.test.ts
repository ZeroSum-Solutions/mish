import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Settings section survives reload and history at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings');
    await page.locator('.settings-nav-item').filter({ hasText: 'Licensed packs' }).click();
    await expect(page).toHaveURL(/\/settings\/licensedPacks$/);
    await expect(page.getByTestId('licensed-packs-section')).toBeVisible({ timeout: T.long });
    await page.reload();
    await expect(page.getByTestId('licensed-packs-section')).toBeVisible({ timeout: T.long });
    await page.screenshot({ path: `../.tmp/q3ux/settings-${width}.png`, fullPage: true });
    await page.locator('.settings-nav-item').filter({ hasText: 'General' }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/licensedPacks$/);
    await expect(page.getByTestId('licensed-packs-section')).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId('licensed-packs-section')).toHaveCount(0);
  });
}
