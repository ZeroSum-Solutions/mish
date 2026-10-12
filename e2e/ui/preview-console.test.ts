import { test, expect } from '@/playwright/suite';
import { T } from '@/timeouts';

test('[P2] Home previews have isolated storage and load grain without CSP errors', async ({ page, request, toolsDev }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const config = await request.put(toolsDev.url.daemon('/api/app-config'), {
    data: { onboardingCompleted: true, telemetry: { metrics: false, content: false, artifactManifest: false } },
  });
  expect(config.ok()).toBe(true);
  const pageerrors: string[] = [];
  const cspErrors: string[] = [];
  page.on('pageerror', (error) => pageerrors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy|Content-Security-Policy|violates.*directive/i.test(message.text())) cspErrors.push(message.text());
  });
  await page.goto('/');
  await expect(page).not.toHaveURL(/onboarding/);
  const families = ['fervor', 'watson', 'wrenfield', 'maben', 'halcyon'];
  for (const family of families) {
    const iframe = page.locator(`iframe[src*="/api/plugins/example-agency-${family}/preview"]`);
    await expect(iframe).toBeAttached({ timeout: T.long });
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect.poll(() => page.frames().some((frame) => frame.url().includes(`example-agency-${family}/preview`)), { timeout: T.long }).toBe(true);
    const frame = page.frames().find((candidate) => candidate.url().includes(`example-agency-${family}/preview`))!;
    await frame.waitForLoadState('load');
    await page.evaluate(() => localStorage.setItem('q3-parent', 'private'));
    const storage = await frame.evaluate(() => {
      const parentValue = localStorage.getItem('q3-parent');
      localStorage.setItem('q3-preview', 'ready');
      sessionStorage.setItem('q3-slide', '2');
      return { origin: self.origin, parentValue, value: localStorage.getItem('q3-preview'), slide: sessionStorage.getItem('q3-slide') };
    });
    expect(storage).toEqual({ origin: 'null', parentValue: null, value: 'ready', slide: '2' });
    if (family === 'fervor' || family === 'wrenfield') {
      const png = await frame.evaluate(async () => {
        const image = new Image();
        image.src = 'grain.png';
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
      expect(png).toEqual({ width: 64, height: 64 });
    }
  }
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
  await testInfo.attach('preview-console', { body: JSON.stringify({ pageerrors, cspErrors }), contentType: 'application/json' });
  expect(pageerrors).toEqual([]);
  expect(cspErrors).toEqual([]);
});
