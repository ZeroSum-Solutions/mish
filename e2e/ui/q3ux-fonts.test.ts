import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

for (const width of [390, 1280]) {
  test(`[P2] Kit specimen loads its named display face at ${width}px`, async ({ page }) => {
    test.skip(process.env.OD_Q3_LIVE_FONTS !== '1', 'Live CDN diagnostic: run with OD_Q3_LIVE_FONTS=1; offline font-source coverage lives in daemon unit tests.');
    test.setTimeout(90_000);
    await applyStandardMocks(page);
    const created = await page.request.post('/api/brands', { data: {
      designMd: `# Q3 Font QA ${width}\n\n## Typography\n| Role | Face |\n|---|---|\n| Display | Playfair Display |\n| Body | DM Sans |`,
    } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    let designSystemId: string | undefined;
    await expect.poll(async () => {
      const detail = await (await page.request.get(`/api/brands/${id}`)).json();
      designSystemId = detail.meta.designSystemId;
      return detail.meta.status;
    }, { timeout: T.long }).toBe('ready');
    expect(designSystemId).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/api/design-systems/${encodeURIComponent(designSystemId!)}/static?path=system%2Fkit.html`);
    await expect(page.locator('h1')).toBeVisible();
    const loaded = await page.evaluate(async () => {
      const heading = document.querySelector('h1')!;
      const style = getComputedStyle(heading);
      const faces = await document.fonts.load(`${style.fontWeight} ${style.fontSize} "Playfair Display"`);
      return { family: style.fontFamily, faces: faces.length, status: faces.map(face => face.status) };
    });
    expect(loaded.family).toContain('Playfair Display');
    expect(loaded.faces).toBeGreaterThan(0);
    expect(loaded.status.every(status => status === 'loaded')).toBe(true);
    // Browser's actual glyph provider proves a downloaded face, rather than merely CSS declaration.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.some(font => font.isCustomFont && font.familyName.includes('Playfair'))).toBe(true);
    await page.screenshot({ path: `../.tmp/q3ux/fonts-${width}.png`, fullPage: false });
    await cdp.detach();
  });
}
