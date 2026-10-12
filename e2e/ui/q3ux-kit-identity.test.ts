import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Same-title installed kits have distinct visible picker identities at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    const title = `Q3 Identical Kit ${width}`;
    const ids: string[] = [];
    const revisions: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await page.request.post('/api/design-systems', { data: { title, category: 'Product', status: 'published', body: `# ${title}\n\n## Typography\nInter` } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const kit = (await response.json()).designSystem;
      ids.push(kit.id);
      revisions.push(kit.updatedAt ?? kit.createdAt);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const uniqueTitle = `Q3 Unique Kit ${width}`;
    const uniqueResponse = await page.request.post('/api/design-systems', { data: { title: uniqueTitle, category: 'Product', status: 'published', body: `# ${uniqueTitle}` } });
    expect(uniqueResponse.ok(), await uniqueResponse.text()).toBeTruthy();
    const uniqueKit = (await uniqueResponse.json()).designSystem;
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByTestId('home-hero-design-system-trigger').click();
    for (const id of ids) {
      const option = page.getByTestId(`project-ds-picker-option-${id}`);
      await expect(option).toBeVisible({ timeout: T.long });
      await expect(option).toContainText(title);
      await expect(option).toContainText(id);
      await expect(option).toHaveAttribute('aria-label', `${title}, Product`);
      const locale = await page.locator('html').getAttribute('lang') ?? 'en';
      const revision = revisions[ids.indexOf(id)]!;
      const date = new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(revision));
      await expect(option).toContainText(date);
      await expect(option).not.toContainText(revision);
      const identity = option.locator('span').filter({ hasText: id }).first();
      await identity.scrollIntoViewIfNeeded();
      const bounds = await identity.boundingBox();
      const row = await option.boundingBox();
      const sizing = await option.evaluate(node => {
        const style = getComputedStyle(node);
        return { height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight, shrink: style.flexShrink };
      });
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0), JSON.stringify(sizing)).toBeLessThanOrEqual((row?.y ?? 0) + (row?.height ?? 0));
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    }
    const uniqueOption = page.getByTestId(`project-ds-picker-option-${uniqueKit.id}`);
    await uniqueOption.scrollIntoViewIfNeeded();
    await expect(uniqueOption).toHaveAttribute('aria-label', `${uniqueTitle}, Product`);
    await expect(uniqueOption).not.toContainText(uniqueKit.id);
    await expect(uniqueOption).not.toContainText(uniqueKit.updatedAt ?? uniqueKit.createdAt);
    await page.screenshot({ path: `../.tmp/q3ux/kit-identity-${width}.png`, fullPage: true });
  });
}
