import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { T } from '../../lib/timeouts.ts';
import { verifyFiles } from './packet.ts';
import { safePath, digest } from './api.ts';
import { CAPTURE_SETTINGS, VIEWPORTS } from './settings.ts';
import { conversionProbe, keyboardProbe, formProbe, installMotionObserver, motionProbe, resourceProbe, observe } from './probes.ts';
import type { BenchmarkRun, Captures, CaptureFact, ResourceEvidence, SectionCapture } from './types.ts';
export const CAPTURE_PROTOCOL_DIGEST = digest(['capture.ts', 'probes.ts', 'settings.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'));
export { VIEWPORTS } from './settings.ts';
const MIME: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.avif': 'image/avif', '.json': 'application/json', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webp': 'image/webp', '.woff2': 'font/woff2' };
/** An ephemeral artifact server, never a tools-dev runtime. Only saved inventory files are served. */
export async function serveArtifacts(root: string, files: string[]) {
  const allowed = new Set(files); const canonicalRoot = await realpath(root);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') throw new Error('Read only');
      const name = decodeURIComponent(new URL(req.url!, 'http://capture').pathname.slice(1));
      const parts = safePath(name);
      if (!allowed.has(name)) throw new Error('Not in inventory');
      const path = await realpath(join(canonicalRoot, ...parts));
      const rel = relative(canonicalRoot, path);
      if (rel.startsWith('..') || resolve(canonicalRoot, rel) !== path) throw new Error('Outside root');
      res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function openPage(browser: Browser, origin: string, name: string, viewport: { width: number; height: number }, reducedMotion: 'reduce' | 'no-preference', fact: CaptureFact) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion, serviceWorkers: 'block', acceptDownloads: false });
  const requests: ResourceEvidence['requests'] = [];
  const attempts: Array<{ url: string; method: string; blocked: boolean }> = [];
  const pending: Promise<unknown>[] = [];
  let interacting = false;
  try {
    const page = await context.newPage();
    await installMotionObserver(page);
    await context.routeWebSocket('**/*', socket => { fact.blockedRequests.push(socket.url()); socket.close(); });
    page.on('request', request => { requests.push({ url: request.url(), type: request.resourceType(), status: null, bytes: null }); });
    page.on('response', response => {
      const record = [...requests].reverse().find(request => request.url === response.url() && request.status === null);
      if (record) {
        record.status = response.status();
        pending.push(response.body().then(bytes => { record.bytes = bytes.length; }).catch(() => { record.failure = 'Response bytes unavailable'; }));
      }
    });
    page.on('requestfailed', request => {
      const record = [...requests].reverse().find(record => record.url === request.url() && record.status === null);
      if (record) record.failure = request.failure()?.errorText ?? 'Request failed';
    });
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (interacting) attempts.push({ url: url.href, method: request.method(), blocked: true });
      if (url.origin !== origin) { fact.blockedRequests.push(url.href); await route.abort(); }
      else if (request.method() !== 'GET' || interacting) {
        // A synthetic 204 keeps native form navigation on the captured document.
        // No request reaches the artifact server; the attempted submission stays in evidence.
        if (request.isNavigationRequest()) await route.fulfill({ status: 204, body: '' }); else await route.abort();
      }
      else await route.continue();
    });
    page.on('console', message => { if (message.type() === 'error') fact.consoleErrors.push(message.text()); });
    page.on('pageerror', error => fact.consoleErrors.push(error.message));
    page.on('dialog', dialog => { pending.push(dialog.dismiss()); });
    const response = await page.goto(`${origin}/${name.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'load', timeout: T.long });
    if (!response?.ok()) throw new Error(`Page HTTP ${response?.status()}`);
    await page.evaluate(() => document.querySelectorAll('img').forEach(img => { img.loading = 'eager'; }));
    await page.waitForFunction(() => [...document.images].every(image => image.complete) && document.fonts.status === 'loaded', undefined, { timeout: T.long });
    // Render-frame waits sample scroll-triggered content, rather than guessing a sleep duration.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
        window.scrollTo(0, y); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (y > 50000) throw new Error('Page exceeds capture scroll budget');
      }
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => [...document.images].every(image => image.complete) && document.fonts.status === 'loaded', undefined, { timeout: T.long });
    return { page, context, requests, pending, attempts, interact: () => { interacting = true; } };
  } catch (error) { await context.close(); throw error; }
}

async function sections(page: Page, out: string, fact: CaptureFact, bytes: Buffer) {
  const boxes = await page.evaluate(selector => [...document.querySelectorAll(selector)].map(element => {
    const box = element.getBoundingClientRect();
    const parts: string[] = [];
    for (let node: Element | null = element; node && node !== document.documentElement; node = node.parentElement) {
      const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling.tagName === node!.tagName);
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return { selector: `html>${parts.join('>')}`, box: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height } };
  }).filter(section => section.box.width > 0 && section.box.height > 0), CAPTURE_SETTINGS.sectionSelector);
  const full = PNG.sync.read(bytes);
  for (const [index, section] of boxes.entries()) {
    const id = `${fact.id}-s${index}`;
    const record: SectionCapture = { id, ...section, screenshot: `screenshots/${id}.png` };
    fact.sections.push(record);
    try {
      const x = Math.max(0, Math.floor(section.box.x)), y = Math.max(0, Math.floor(section.box.y));
      const width = Math.min(full.width, Math.ceil(section.box.x + section.box.width)) - x;
      const height = Math.min(full.height, Math.ceil(section.box.y + section.box.height)) - y;
      if (width <= 0 || height <= 0) throw new Error('Section lies outside full-page capture');
      record.cropBox = { x, y, width, height };
      const crop = new PNG({ width, height }); PNG.bitblt(full, crop, x, y, width, height, 0, 0);
      const png = PNG.sync.write(crop); await writeFile(join(out, record.screenshot), png, { flag: 'wx' });
      record.screenshotSha256 = digest(png);
    } catch (error) { record.error = error instanceof Error ? error.message : 'Section capture failed'; }
  }
  return boxes.length;
}

export async function captureRun(out: string, run: BenchmarkRun): Promise<Captures> {
  await verifyFiles(out, run);
  if (JSON.stringify(run.fingerprint.captureSettings) !== JSON.stringify(CAPTURE_SETTINGS)) throw new Error('Run capture settings differ from current protocol');
  const briefs = JSON.parse(await readFile(join(out, 'cases.json'), 'utf8')) as import('./types.ts').BriefCase[];
  await mkdir(join(out, 'screenshots'));
  const captures: Captures = { schema: 'quality-captures/2', runId: run.runId, captureProtocolDigest: CAPTURE_PROTOCOL_DIGEST, browser: 'unavailable', facts: [] };
  const save = () => writeFile(join(out, 'captures.json'), JSON.stringify(captures, null, 2));
  await save();
  const browser = await chromium.launch({ headless: true }); captures.browser = browser.version();
  try {
    for (const item of run.cases) {
      const files = item.files.map(file => file.name);
      const pages = files.filter(file => /\.html?$/iu.test(file) && !file.startsWith('_brand-build/'));
      const brief = briefs.find(brief => brief.id === item.caseId)!;
      const server = await serveArtifacts(join(out, 'cases', item.caseId, 'files'), files);
      try {
        for (const [index, name] of pages.entries()) for (const viewport of VIEWPORTS) {
          const id = `${item.caseId}-p${index}-${viewport.width}`;
          const missing = { status: 'missing' as const, reason: 'Page probe did not complete' };
          const fact: CaptureFact = { id, caseId: item.caseId, page: name, viewport: { ...viewport }, screenshot: `screenshots/${id}.png`,
            horizontalOverflowPx: 0, consoleErrors: [], brokenImages: [], blockedRequests: [], sections: [], sectionEvidence: missing,
            conversion: missing, forms: missing, keyboard: missing, motion: missing, resources: missing };
          try {
            const reduced = await openPage(browser, server.url, name, { ...viewport }, 'reduce', fact);
            let reducedSample;
            try {
              reducedSample = await observe(() => motionProbe(reduced.page));
              const observed = await reduced.page.evaluate(() => ({
                height: Math.max(innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight),
                overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth),
                broken: [...document.images].filter(image => image.naturalWidth === 0).map(image => image.getAttribute('src') ?? ''),
              }));
              fact.horizontalOverflowPx = observed.overflow; fact.brokenImages = observed.broken;
              const png = await reduced.page.screenshot({ path: join(out, fact.screenshot), fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width: viewport.width, height: observed.height }, timeout: T.long });
              const dimensions = PNG.sync.read(png);
              fact.screenshotSha256 = digest(png); fact.documentHeightPx = observed.height; fact.screenshotHeightPx = dimensions.height;
              if (dimensions.height < observed.height || dimensions.width !== viewport.width) throw new Error('Screenshot does not cover the full document');
              fact.sectionEvidence = await observe(async () => ({ count: await sections(reduced.page, out, fact, png) }));
              if (fact.sectionEvidence.status === 'complete' && !fact.sectionEvidence.value.count) fact.sectionEvidence = { status: 'missing', reason: 'No visible landmark or section elements' };
              const destinationFiles = item.build?.plan.pages.filter(page => brief.conversion.destinationRoles.includes(page.role)).map(page => page.file) ?? [];
              fact.conversion = await observe(() => conversionProbe(reduced.page, brief.conversion, files, destinationFiles));
              // Verify cross-page fragment targets using served bytes, rather than trusting a filename alone.
              if (fact.conversion.status === 'complete') {
                for (const match of fact.conversion.value.matches.filter(match => match.reason === 'Destination fragment needs verification')) {
                  const url = new URL(match.target!, `${server.url}/${name}`);
                  const target = decodeURIComponent(url.hash.slice(1));
                  const html = await readFile(join(out, 'cases', item.caseId, 'files', ...safePath(decodeURIComponent(url.pathname.slice(1)))), 'utf8');
                  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
                  match.resolves = new RegExp(`\\bid\\s*=\\s*["']${escaped}["']`, 'u').test(html);
                  if (match.resolves) delete match.reason; else match.reason = 'Destination fragment missing in served HTML';
                }
                fact.conversion.value.resolves = fact.conversion.value.exists && fact.conversion.value.matches.every(match => match.resolves);
              }
              await Promise.all(reduced.pending);
              fact.resources = await observe(() => resourceProbe(reduced.page, reduced.requests));
              reduced.interact();
              fact.keyboard = await observe(() => keyboardProbe(reduced.page, fact.conversion.status === 'complete' ? fact.conversion.value.matches.map(match => match.selector) : []));
              fact.forms = await observe(() => formProbe(reduced.page, reduced.attempts));
            } finally { await reduced.context.close(); }
            const normalSample = await observe(async () => {
              const normal = await openPage(browser, server.url, name, { ...viewport }, 'no-preference', fact);
              try { return await motionProbe(normal.page); }
              finally { await Promise.all(normal.pending); await normal.context.close(); }
            });
            fact.motion = reducedSample.status === 'complete' && normalSample.status === 'complete'
              ? { status: 'complete', value: { reduced: reducedSample.value, normal: normalSample.value } }
              : { status: 'failed', reason: `Motion comparison incomplete: ${reducedSample.status === 'complete' ? '' : reducedSample.reason} ${normalSample.status === 'complete' ? '' : normalSample.reason}`.trim() };
          } catch (error) { fact.error = error instanceof Error ? error.message : 'Capture failed'; }
          fact.evidenceFile = `screenshots/${id}-evidence.json`;
          const { evidenceFile: _path, evidenceSha256: _hash, ...evidence } = fact;
          const bytes = JSON.stringify(evidence, null, 2);
          await writeFile(join(out, fact.evidenceFile), bytes, { flag: 'wx' }); fact.evidenceSha256 = digest(bytes);
          captures.facts.push(fact); await save();
        }
      } finally { await server.close(); }
    }
  } finally { await browser.close(); }
  await save(); return captures;
}
