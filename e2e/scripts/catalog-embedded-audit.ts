/** Read-only graphics check in the product's opaque-origin iframe boundary.
 * The host is a synthetic localhost fixture, not the application's expanded modal. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Loopback origin required');
const label = process.argv[3] ?? 'after-embedded';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid audit label');
const out = resolve(process.cwd(), '../.tmp/catalog-audit/live', label);
await mkdir(out, { recursive: true });
const sceneAssets = new Set(['https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode', 'https://unpkg.com/@splinetool/runtime@2.0.58/build/bevel.wasm', 'https://cdn.spline.design/@splinetool/runtime@2.0.58/build/process.wasm']);
const results: Array<Record<string, unknown>> = [];
const spotifyEmbed = process.argv.includes('--spotify-embed');
const spotifyUrl = 'https://open.spotify.com/embed/track/5L2ELXkO17Iu9J8hwMktVJ';
const ids = spotifyEmbed ? ['21st:moumensoliman-glassmorphism-listen-app'] : ['21st:serafimcloud-spline-scene', '21st:rahil1202-scannercardstream', '21st:xordev-phosphor-30'];
for (const id of ids) {
  // Separate browser per graphics item avoids software renderer competition.
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    try {
    const errors: string[] = [], failedResources: string[] = [], blocked: string[] = [], responses: unknown[] = [];
    const host = new URL('/__catalog-audit-iframe', origin).href;
    const src = new URL(`/api/21st/${encodeURIComponent(id)}/preview?theme=light&motion=reduced`, origin).href;
    const previewBase = src.split('?')[0]!;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.href === host) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>html,body{margin:0}iframe{border:0;display:block;width:100vw;height:800px}</style></head><body><script>window.auditMessages=[];addEventListener('message',e=>window.auditMessages.push(e.data))</script><iframe src="${src}" sandbox="allow-scripts" allow="encrypted-media *" title="${id}"></iframe></body></html>` });
      const publicSpotifyStatic = spotifyEmbed && ([spotifyUrl, `${spotifyUrl}?utm_source=generator`].includes(url.href) || url.origin === 'https://embed-cdn.spotifycdn.com' && url.pathname.startsWith('/_next/static/') && ['script', 'stylesheet'].includes(route.request().resourceType()));
      const anonymousMedia = url.protocol === 'https:' && ['image', 'font'].includes(route.request().resourceType()) && (!spotifyEmbed || ['i.scdn.co', 'mosaic.scdn.co', 'embed-cdn.spotifycdn.com'].includes(url.hostname) || url.hostname === 'image-cdn-fa.spotifycdn.com' && url.pathname.startsWith('/image/') || url.hostname === 'encore.scdn.co' && url.pathname.startsWith('/fonts/'));
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin.origin && !(publicSpotifyStatic || sceneAssets.has(url.href) || anonymousMedia)) { blocked.push(`${route.request().resourceType()} ${url.href}`); return route.abort(); }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (request.url().startsWith(origin.origin)) failedResources.push(request.url()); });
    page.on('response', response => { if (response.url().startsWith(previewBase) || sceneAssets.has(response.url()) || spotifyEmbed && response.url().startsWith('https://')) responses.push({ url: response.url(), status: response.status() }); });
    await page.goto(host, { waitUntil: 'load', timeout: 30_000 });
    const frame = page.frames().find(candidate => candidate.url().startsWith(previewBase));
    if (!frame) throw new Error(`Missing iframe: ${id}`);
    await frame.waitForFunction((checkSpotify) => checkSpotify ? document.querySelector('iframe[src*="open.spotify.com"]') !== null : document.querySelector('canvas') !== null || document.body.innerText.includes('could not render'), spotifyEmbed, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    if (spotifyEmbed) await frame.locator('iframe[src*="open.spotify.com"]').scrollIntoViewIfNeeded();
    let provider = spotifyEmbed ? page.frames().find(candidate => candidate.url().startsWith(spotifyUrl)) : undefined;
    if (spotifyEmbed) for (let attempt = 0; attempt < 40 && !provider; attempt++) { await page.waitForTimeout(500); provider = page.frames().find(candidate => candidate.url().startsWith(spotifyUrl)); }
    if (provider) await provider.locator('button').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const providerObserved = provider ? await provider.evaluate(() => ({ origin: self.origin, text: document.body.innerText.slice(0, 2000), buttons: Array.from(document.querySelectorAll('button')).map(element => ({ text: element.textContent, ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title') })), audioElements: document.querySelectorAll('audio').length })).catch(error => ({ error: String(error) })) : undefined;
    const observed = await frame.evaluate(() => ({ text: document.body.innerText.slice(0, 1800), canvasCount: document.querySelectorAll('canvas').length, rootOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), origin: self.origin, visibleElements: Array.from(document.body.querySelectorAll('*')).filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).length, headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(element => element.textContent), buttons: Array.from(document.querySelectorAll('button')).map(element => element.textContent ?? '') }));
    const messages = await page.evaluate(() => (window as unknown as { auditMessages: unknown[] }).auditMessages);
    const screenshot = resolve(out, `${id.replace(':', '-')}-${width}.png`);
    await page.locator('iframe').screenshot({ path: screenshot });
    const canvasScreenshot = observed.canvasCount ? resolve(out, `${id.replace(':', '-')}-${width}-canvas.png`) : undefined;
    const canvasPaint: Array<{ screenshot: string; rgbMean: number; rgbStandardDeviation: number }> = [];
    for (let index = 0; index < observed.canvasCount; index++) {
      const canvasPath = index === 0 ? canvasScreenshot! : resolve(out, `${id.replace(':', '-')}-${width}-canvas-${index}.png`);
      const pixels = PNG.sync.read(await frame.locator('canvas').nth(index).screenshot({ path: canvasPath }));
      let sum = 0, squares = 0;
      for (let offset = 0; offset < pixels.data.length; offset += 4) for (let channel = 0; channel < 3; channel++) { const value = pixels.data[offset + channel]!; sum += value; squares += value * value; }
      const count = pixels.width * pixels.height * 3;
      const mean = sum / count;
      canvasPaint.push({ screenshot: canvasPath, rgbMean: mean, rgbStandardDeviation: Math.sqrt(Math.max(0, squares / count - mean * mean)) });
    }
    const providerScreenshot = spotifyEmbed ? resolve(out, `${id.replace(':', '-')}-${width}-spotify.png`) : undefined;
    if (providerScreenshot) await frame.locator('iframe[src*="open.spotify.com"]').screenshot({ path: providerScreenshot });
    results.push({ id, width, hostFixture: host, actualPreviewUrl: src, sandbox: 'allow-scripts', screenshot, canvasScreenshot, canvasPaint, providerObserved, providerScreenshot, providerPlayback: 'Not requested or exercised; no audio/control activation.', messages, errors, failedResources, blocked, responses, ...observed });
    } finally { await context.close(); }
  }
  } finally { await browser.close(); }
}
await writeFile(resolve(out, 'audit.json'), JSON.stringify({ scope: spotifyEmbed ? 'Actual local preview and public Spotify embedded player UI inside an opaque-origin sandbox. Only exact public document and observed static CDN/cover/fonts are permitted; analytics/API calls remain blocked. No playback or account flow. Not a full application modal interaction test.' : 'Actual graphics preview inside same-localhost synthetic host and opaque-origin sandbox. Not a full application modal interaction test.', results }, null, 2));
console.log(JSON.stringify({ renders: results.length, evidence: out, results: results.map(({ id, width, canvasCount, rootOverflow, errors }) => ({ id, width, canvasCount, rootOverflow, errors })) }));
