import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Catalog labels remain fully visible at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/catalog');
    const tabs = page.getByRole('tablist', { name: 'Catalog views' });
    await expect(page.getByTestId('catalog-segment-effects')).toBeVisible({ timeout: T.long });
    for (const value of ['effects', 'blocks', 'components', '21st']) {
      await page.getByTestId(`catalog-segment-${value}`).click();
      const bounds = await tabs.evaluate(node => {
        const track = node.getBoundingClientRect();
        return [...node.querySelectorAll('[role=tab]')].map(tab => {
          const rect = tab.getBoundingClientRect();
          return { label: tab.textContent, left: rect.left, right: rect.right, trackLeft: track.left, trackRight: track.right };
        });
      });
      for (const bound of bounds) {
        expect(bound.left, bound.label ?? '').toBeGreaterThanOrEqual(bound.trackLeft);
        expect(bound.right, bound.label ?? '').toBeLessThanOrEqual(bound.trackRight);
      }
    }
    await expect.poll(async () => tabs.evaluate(node => {
      const active = node.querySelector('[aria-selected=true]')!;
      const indicator = active.querySelector('[data-selection-indicator]');
      if (!indicator) return 0;
      const a = active.getBoundingClientRect(); const b = indicator.getBoundingClientRect();
      return Math.abs(a.left - b.left) + Math.abs(a.top - b.top);
    })).toBeLessThan(1);
    await page.screenshot({ path: `../.tmp/q3ux/catalog-${width}.png`, fullPage: true });
  });
}

for (const width of [390, 1280]) {
  test(`[P2] Project header tabs remain readable at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    const projectId = `q3-header-${width}-${Date.now()}`;
    expect((await page.request.post('/api/projects', { data: { id: projectId, name: 'Header QA', metadata: { kind: 'prototype' } } })).ok()).toBeTruthy();
    expect((await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'index.html', content: '<!doctype html><h1>Header QA</h1>', artifactManifest: { version: 1, kind: 'html', title: 'Header QA', entry: 'index.html', renderer: 'html', exports: ['html'] } } })).ok()).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}/files/index.html`);
    await expect(page.getByTestId('file-workspace')).toBeAttached({ timeout: T.long });
    if (width === 390) await page.getByRole('radio', { name: 'Preview / Files' }).click();
    const track = page.locator('.workspace .ws-tabs-bar');
    await expect(track).toBeVisible();
    await expect.poll(async () => (await track.boundingBox())?.width ?? 0).toBeGreaterThan(180);
    const first = track.getByRole('tab').first();
    await expect(first).toBeVisible();
    const bounds = await first.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `../.tmp/q3ux/project-${width}.png`, fullPage: true });
  });
}
