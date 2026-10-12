import { expect, test } from '@/playwright/suite';
import { applyStandardMocks, routeSuccessfulRuns } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Explicit prototype name is honored and survives reload at ${width}px`, async ({ page }) => {
    await applyStandardMocks(page);
    await routeSuccessfulRuns(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const requested = `QA3-J1 Harbor Bakery ${width}`;
    await page.getByTestId('home-hero-input').fill(`Name the project "${requested}". One-page bakery site.`);
    const created = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/projects');
    await page.getByTestId('home-hero-submit').click();
    expect((await created).postDataJSON().name).toBe(requested);
    await expect(page.getByTestId('project-title')).toHaveText(requested, { timeout: T.long });
    const id = new URL(page.url()).pathname.split('/')[2];
    const response = await page.request.get(`/api/projects/${id}`);
    expect((await response.json()).project.name).toBe(requested);
    await page.reload();
    await expect(page.getByTestId('project-title')).toHaveText(requested, { timeout: T.long });
    await page.screenshot({ path: `../.tmp/q3ux/naming-${width}.png`, fullPage: true });
  });
}
