/** Read-only diagnostic against an explicitly supplied local runtime. No lifecycle or provider calls. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { T } from '../lib/timeouts.ts';

interface Item { id: string; assetKind?: string; displayTitle?: string; name?: string; privateImplementation?: { previewUrl: string }; }
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Audit requires a loopback origin');
const label = process.argv[3] ?? 'before';
const onlineMedia = process.argv.includes('--online-media');
const sceneAssets = process.argv.includes('--scene-assets');
const sceneUrls = new Set(['https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode', 'https://unpkg.com/@splinetool/runtime@2.0.58/build/bevel.wasm', 'https://cdn.spline.design/@splinetool/runtime@2.0.58/build/process.wasm']);
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid audit label');
const out = resolve(process.cwd(), '../.tmp/catalog-audit/live', label);
await mkdir(out, { recursive: true });
const load = async (path: string): Promise<Item[]> => {
  const response = await fetch(new URL(path, origin));
  if (!response.ok) throw new Error(`Catalog ${response.status}`);
  return ((await response.json()) as { catalog: { items: Item[] } }).catalog.items;
};
// A browsing cleanup may hide alias/fragment rows while their stable URLs stay reachable.
// --baseline rechecks the original full inventory, including every retained alias.
const baseline = process.argv.includes('--baseline');
const saved = async (name: string): Promise<Item[]> => ((JSON.parse(await readFile(resolve(process.cwd(), '../.tmp/catalog-audit', name), 'utf8'))) as { catalog: { items: Item[] } }).catalog.items;
const discovered = baseline ? [...await saved('cult.json'), ...await saved('21st.json')] : [...await load('/api/cult/catalog'), ...await load('/api/21st')];
const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7).split(',');
const items = only ? discovered.filter(item => only.includes(item.id)) : discovered;
if (only && items.length !== only.length) throw new Error('Unknown item in --only');
const stylesPath = process.argv.find(argument => argument.startsWith('--styles-json='))?.slice(14);
const candidateStyles = stylesPath ? JSON.parse(await readFile(resolve(stylesPath), 'utf8')) as Record<string, string> : {};
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const queue = [...items];
const results: Array<Record<string, unknown>> = [];
let complete = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const item = queue.shift()!;
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
      const blockedExternalRequests: string[] = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const permittedMedia = (onlineMedia && url.protocol === 'https:' && ['image', 'font'].includes(route.request().resourceType())) || (sceneAssets && sceneUrls.has(url.href));
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin.origin && !permittedMedia) { blockedExternalRequests.push(`${route.request().resourceType()} ${url.origin}${url.pathname}`); await route.abort(); }
        else await route.continue();
      });
      const page = await context.newPage();
      const errors: string[] = [], failedResources: string[] = [], policyErrors: string[] = [];
      const sceneResponses: Array<{ url: string; status: number }> = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => { if (request.url().startsWith(origin.origin) || (onlineMedia && ['image', 'font'].includes(request.resourceType()))) failedResources.push(request.url()); });
      page.on('response', response => { if (response.status() >= 400 && (response.url().startsWith(origin.origin) || (onlineMedia && ['image', 'font'].includes(response.request().resourceType())))) failedResources.push(`${response.status()} ${response.url()}`); });
      page.on('response', response => { if (sceneUrls.has(response.url())) sceneResponses.push({ url: response.url(), status: response.status() }); });
      page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) policyErrors.push(message.text().slice(0, 250)); });
      await page.addInitScript(() => {
        Object.assign(window, { __catalogMessages: [] });
        addEventListener('message', event => {
          if (event.data && typeof event.data === 'object' && /preview/.test(String(event.data.source))) {
            (window as unknown as { __catalogMessages: unknown[] }).__catalogMessages.push(event.data);
          }
        });
      });
      const framePath = item.id.startsWith('21st:')
        ? item.privateImplementation?.previewUrl ?? `/api/21st/${encodeURIComponent(item.id)}/preview`
        : `/api/cult/preview/${encodeURIComponent(item.id)}/frame?theme=light`;
      try {
        const response = await page.goto(new URL(framePath, origin).href, { waitUntil: 'load', timeout: T.long });
        if (candidateStyles[item.id]) await page.evaluate(css => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); }, candidateStyles[item.id]!);
        if (sceneAssets && item.id === '21st:serafimcloud-spline-scene') {
          await page.waitForResponse(response => response.url().endsWith('scene.splinecode') && response.ok(), { timeout: T.medium }).catch(() => {});
          await page.waitForTimeout(T.short);
        }
        const harness = item.assetKind === 'primitive' || item.assetKind === 'app';
        if (harness) await page.waitForFunction(() => (window as unknown as { __catalogMessages: Array<{ type: string }> }).__catalogMessages.some(message => message.type === 'ready' || message.type === 'error'), undefined, { timeout: T.medium }).catch(() => {});
        await page.evaluate(() => document.querySelectorAll('img').forEach(image => image.loading = 'eager'));
        await page.waitForFunction(() => [...document.images].every(image => image.complete), undefined, { timeout: T.short }).catch(() => {});
        await page.waitForTimeout(350);
        const observed = await page.evaluate(() => {
          const root = document.getElementById('root') ?? document.body;
          const elements = [...root.querySelectorAll<HTMLElement>('*')];
          const visible = elements.filter(element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0; });
          const textElements = visible.filter(element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
          const clipped = textElements.filter(element => { const r = element.getBoundingClientRect(); return r.right < 0 || r.left > innerWidth; }).map(element => (element.innerText ?? element.textContent ?? '').slice(0, 90)).slice(0, 20);
          const wrappedButtons = visible.filter(element => element.matches('button,a[role="button"]')).filter(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            const rects = [...range.getClientRects()].filter(rect => rect.width > 3 && rect.height > 3);
            return new Set(rects.map(rect => Math.round(rect.top))).size > 1;
          }).map(element => (element.innerText ?? element.textContent ?? '').slice(0, 90)).filter(Boolean);
          const overflowElements = visible.filter(element => { const r = element.getBoundingClientRect(); return r.right > innerWidth + 2 || r.left < -2; }).slice(0, 30).map(element => {
            const r = element.getBoundingClientRect(), s = getComputedStyle(element);
            return { tag: element.tagName, classes: element.getAttribute('class'), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), minWidth: s.minWidth, maxWidth: s.maxWidth, display: s.display, position: s.position, overflowX: s.overflowX, text: (element.innerText ?? element.textContent ?? '').slice(0, 80) };
          });
          const scrollRegions = visible.filter(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 2).map(element => ({ classes: element.getAttribute('class'), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
          return { messages: (window as unknown as { __catalogMessages: unknown[] }).__catalogMessages, text: root.innerText.trim().slice(0, 1800), visibleElements: visible.length, textElements: textElements.length, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), overflowElements, scrollRegions, clippedText: clipped, wrappedButtons, bodyHeight: document.body.scrollHeight, brokenImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).map(image => image.currentSrc.slice(0, 160)), canvases: root.querySelectorAll('canvas').length, headings: [...root.querySelectorAll<HTMLElement>('h1,h2,h3')].map(element => ({ text: element.innerText.slice(0, 150), font: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize })).slice(0, 15), buttons: [...root.querySelectorAll<HTMLElement>('button')].map(element => element.innerText).filter(Boolean).slice(0, 15) };
        });
        const screenshot = resolve(out, `${item.id.replace(':', '-')}-${width}.png`);
        let fullPageCaptureError: string | undefined;
        const pageSegments: string[] = [];
        try { await page.screenshot({ path: screenshot, fullPage: item.assetKind === 'page' }); }
        catch (error) {
          if (item.assetKind !== 'page') throw error;
          // A full-page compositing capture can fail while DOM observations remain
          // valid. Retain the capture error and record the entire page as viewport tiles.
          fullPageCaptureError = error instanceof Error ? error.message : String(error);
          await page.screenshot({ path: screenshot, fullPage: false });
          for (let top = 0; top < observed.bodyHeight; top += 720) {
            await page.evaluate(value => scrollTo(0, value), top);
            const tile = resolve(out, `${item.id.replace(':', '-')}-${width}-segment-${pageSegments.length}.png`);
            await page.screenshot({ path: tile, fullPage: false });
            pageSegments.push(tile);
          }
          await page.evaluate(() => scrollTo(0, 0));
        }
        if (sceneAssets && item.id === '21st:serafimcloud-spline-scene' && observed.canvases > 0) await page.locator('canvas').first().screenshot({ path: resolve(out, `scene-canvas-${width}.png`) });
        results.push({ id: item.id, title: item.displayTitle ?? item.name, width, status: response?.status(), framePath, screenshot, fullPageCaptureError, pageSegments, errors, failedResources, blockedExternalRequests, sceneResponses, policyErrors, ...observed });
      } catch (error) { results.push({ id: item.id, width, framePath, errors, failedResources, error: error instanceof Error ? error.message : String(error) }); }
      await context.close();
    }
    complete++;
    await writeFile(resolve(out, 'audit.json'), JSON.stringify({ label, origin: origin.origin, onlineMedia, networkPolicy: onlineMedia ? 'Existing HTTPS image/font requests permitted; external scripts, API and telemetry blocked' : 'All external network blocked', itemCount: items.length, completedItems: complete, results }, null, 2));
    if (complete % 20 === 0) console.log(`${complete}/${items.length}`);
  }
}));
await browser.close();
console.log(JSON.stringify({ items: items.length, renders: results.length, evidence: out, errors: results.filter(result => result.error || (result.errors as unknown[] | undefined)?.length).length, overflow: results.filter(result => Number(result.overflow) > 2).length }));
