import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { PNG } from 'pngjs';
import { digest } from './api.ts';
import { VIEWPORTS } from './settings.ts';

/** Separate from artifact capture: public reference resources must load to preserve the design. */
export const referenceProtocol = {
  schema: 'quality-reference-capture/1', viewports: [VIEWPORTS[4], VIEWPORTS[2]],
  deviceScaleFactor: 1, reducedMotion: 'reduce', fullPage: true,
  serviceWorkers: 'block', requests: 'GET only; public resources allowed',
  lazyContent: 'scroll every viewport (300ms), settle images/fonts, return to top (500ms)', scrollBudgetPx: 50000,
  consent: 'Reject all or Reject all cookies when that exact control is present', imageWaitMs: 15000,
} as const;
export const REFERENCE_PROTOCOL_DIGEST = digest(JSON.stringify(referenceProtocol) + readFileSync(new URL('./reference-capture.ts', import.meta.url), 'utf8'));
export interface CalibrationImage { width: number; height: number; file: string; sha256: string }
export async function captureReferencePage(browser: Browser, url: string, out: string, id: string): Promise<CalibrationImage[]> {
  if (!/^P\d{2}$/u.test(id)) throw new Error('Use blind page IDs P01..P99');
  const origin = new URL(url);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Invalid reference URL');
  await mkdir(out, { recursive: true });
  const images: CalibrationImage[] = [];
  for (const viewport of referenceProtocol.viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    try {
      await context.route('**/*', route => route.request().method() === 'GET' ? route.continue() : route.abort());
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      page.on('dialog', dialog => void dialog.dismiss());
      const response = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      if (!response?.ok()) throw new Error(`Reference HTTP ${response?.status()}`);
      const reject = page.getByRole('button', { name: /^(Reject all|Reject all cookies)$/iu });
      if (await reject.count() === 1 && await reject.isVisible()) await reject.click({ timeout: 3000 });
      await page.evaluate(async () => {
        document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
        for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
          if (y > 50000) throw new Error('Reference exceeds scroll budget');
          scrollTo(0, y);
          await new Promise<void>(resolve => setTimeout(resolve, 300));
        }
        await document.fonts.ready;
        scrollTo(0, 0);
        await new Promise<void>(resolve => setTimeout(resolve, 500));
      });
      await page.waitForFunction(() => [...document.images].every(image => image.complete), undefined, { timeout: referenceProtocol.imageWaitMs }).catch(() => { /* Preserve incomplete public resources in the receipt, never invent a load pass. */ });
      const incompleteImages = await page.evaluate(() => [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => ({ alt: image.alt, complete: image.complete })));
      if (await page.evaluate(() => document.fonts.status !== 'loaded')) throw new Error('Reference fonts did not settle');
      const height = await page.evaluate(() => Math.max(innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight));
      const file = `${id}-${viewport.width}.png`;
      const bytes = await page.screenshot({ path: join(out, file), fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width: viewport.width, height }, timeout: 30000 });
      const png = PNG.sync.read(bytes);
      if (png.width !== viewport.width || png.height < height) throw new Error('Incomplete full-page reference capture');
      images.push({ width: png.width, height: png.height, file, sha256: digest(bytes) });
      await writeFile(join(out, `${id}-${viewport.width}-capture.json`), JSON.stringify({ protocol: REFERENCE_PROTOCOL_DIGEST, browser: browser.version(), viewport, height, incompleteImages, sha256: digest(bytes), capturedAt: new Date().toISOString() }, null, 2));
    } finally { await context.close(); }
  }
  return images;
}
export async function launchReferenceBrowser() { return chromium.launch({ headless: true }); }
