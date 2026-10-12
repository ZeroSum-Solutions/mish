/**
 * Deterministic local catalog thumbnail capture. Never starts a runtime or edits a source kit.
 * From the repository root:
 *   mise exec -- pnpm --filter @mish/e2e catalog:thumbnails --inventory
 *   ... --baseline --only=cult:marketing-hero-apple,21st:hero-ui-card --capture
 *   ... --baseline --capture --write
 * --capture without --write saves review candidates, not product assets. --baseline uses the
 * pre-cleanup 333-row inventory; --inventory requires no browser and records every file owner.
 * Static assets go to the existing Cult previews/thumbnails dirs and a separate 21st live dir;
 * saved upstream 21st CDN images and their provenance manifest are never overwritten.
 * A 21st.dev row tagged `rights: "reference-only"` (generated/21st-items.json) is a community
 * component this product has no rights to redistribute any screenshot of — neither a locally
 * captured demo render NOR the committed `generated/21st-thumbnails/` copy of 21st.dev's own CDN
 * preview (packages/21st-catalog/scripts/twenty-first-thumbnails.ts serves that one; it is
 * gated by the same rule, not a remote URL this product merely links to). This script never
 * captures or writes a `generated/21st-live-thumbnails/<slug>.webp` for one, even with
 * --capture --write and even when a private implementation exists to render it from — see
 * `twenty1stMayShipLocalImage` below. That row's card falls back to the neutral placeholder.
 */
import { chromium, type Frame, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { twenty1stMayShipLocalImage, type Twenty1stRights } from '@mish/contracts';
import { T } from '../lib/timeouts.ts';

interface Item {
  id: string; slug: string; displayTitle?: string; name?: string; assetKind?: string;
  privateImplementation?: Implementation; ownedAlternative?: Implementation;
  /** `/api/21st` only; a non-21st Cult row carries no `rights` field. */
  rights?: Twenty1stRights;
}
interface Implementation { previewUrl: string; sourceSha256: string; provenance: 'upstream-private' | 'independently-authored'; refinement?: { originalSourceSha256: string; note: string }; }
interface ThumbEntry { file?: string; source?: string; bytes?: number; via?: string; }
interface LiveEntry { file: string; bytes: number; revision: string; sourceSha256: string; provenance: Implementation['provenance']; framePath: string; }
interface Box { x: number; y: number; width: number; height: number; }
interface SharpPipeline {
  resize(width: number, height: number, options: Record<string, unknown>): SharpPipeline;
  webp(options: Record<string, unknown>): SharpPipeline;
  png(): SharpPipeline;
  stats(): Promise<{ channels: Array<{ stdev: number }> }>;
  toBuffer(): Promise<Buffer>;
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const generated = resolve(root, 'packages/cult-ui-catalog/generated');
/** The 21st.dev images and live-thumbnail manifest moved to their own package in P1-4a. */
const generated21st = resolve(root, 'packages/21st-catalog/generated');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const origin = new URL(option('origin', 'http://127.0.0.1:3000'));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Capture requires a loopback runtime');
if (args.some(arg => !/^(--(baseline|inventory|capture|write)|--(origin|only|out|theme|workers)=.+)$/.test(arg))) throw new Error('Unknown or malformed argument');
if (args.includes('--write') && !args.includes('--capture')) throw new Error('--write requires --capture');
const workers = Number(option('workers', '4'));
if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('--workers must be 1 to 4');
const theme = option('theme', 'light');
if (theme !== 'light' && theme !== 'dark') throw new Error('--theme must be light or dark');
const out = resolve(root, option('out', '.tmp/catalog-thumbnails'));
if (relative(root, out).startsWith('..')) throw new Error('--out must stay in the project');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async <V>(path: string): Promise<V> => JSON.parse(await readFile(path, 'utf8')) as V;
const load = async (path: string): Promise<Item[]> => {
  const response = await fetch(new URL(path, origin));
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  return ((await response.json()) as { catalog: { items: Item[] } }).catalog.items;
};
const saved = async (name: string) => (await json<{ catalog: { items: Item[] } }>(resolve(root, '.tmp/catalog-audit', name))).catalog.items;
const discovered = args.includes('--baseline') ? [...await saved('cult.json'), ...await saved('21st.json')] : [...await load('/api/cult/catalog'), ...await load('/api/21st')];
// Fresh implementation hashes remain authoritative when an original inventory is reused.
const fresh21st = new Map((await load('/api/21st')).map(item => [item.id, item]));
const items = discovered.map(item => fresh21st.get(item.id) ?? item).sort((a, b) => a.id.localeCompare(b.id));
const catalog = await json<{ rows: Array<{ id: string; name: string; previewId: string | null; source?: { registrySha256: string } }> }>(resolve(root, 'packages/cult-ui-catalog/catalog.json'));
const slugs = await json<{ items: Record<string, string> }>(resolve(generated, 'slugs.json'));
const publicId = (id: string) => slugs.items[id] ? `cult:${slugs.items[id]}` : id;
const rows = new Map(catalog.rows.map(row => [publicId(row.id), row]));
const thumbnails = await json<{ items: Record<string, ThumbEntry> }>(resolve(generated, 'thumbnails.json'));
const only = args.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
if (only?.some(id => !items.some(item => item.id === id))) throw new Error('--only names an unknown catalog row');
const selected = only ? items.filter(item => only.includes(item.id)) : items;
const plans = await Promise.all(selected.map(async item => {
  const implementation = item.privateImplementation ?? item.ownedAlternative;
  const row = rows.get(item.id), existing = thumbnails.items[row?.id ?? item.id];
  const file = item.id.startsWith('21st:') ? `${item.slug}.webp` : row?.previewId ? row.previewId : existing?.file;
  const dir = item.id.startsWith('21st:') ? '21st-live-thumbnails' : row?.previewId ? 'previews' : 'thumbnails';
  const target = file ? resolve(item.id.startsWith('21st:') ? generated21st : generated, dir, file) : undefined;
  if (file && !/^[a-z0-9][a-z0-9-]*\.webp$/.test(file)) throw new Error(`Unsafe mapped filename for ${item.id}`);
  // A reference-only (non-copyable) 21st.dev row never gets a locally captured screenshot of the
  // other creator's component, even when a private implementation exists to render it from —
  // `twenty1stMayShipLocalImage` (the same rule twenty-first-thumbnails.ts uses for its own CDN
  // fetch) is the one source of truth for this. Leaving framePath undefined routes it straight to
  // the "preserved" outcome below with no browser capture and no generated/21st-live-thumbnails.json write.
  const framePath = item.id.startsWith('21st:')
    ? (item.rights !== undefined && !twenty1stMayShipLocalImage(item.rights) ? undefined : implementation?.previewUrl)
    : `/api/cult/preview/${encodeURIComponent(item.id)}/frame`;
  let before: { bytes: number; sha256: string } | null = null;
  if (target) { try { const bytes = await readFile(target); before = { bytes: bytes.length, sha256: hash(bytes) }; } catch { /* absent first-generation local image */ } }
  const reference = item.id.startsWith('21st:') ? resolve(generated21st, '21st-thumbnails', `${item.slug}.webp`) : target;
  let referenceHash: string | null = null;
  if (reference) { try { referenceHash = hash(await readFile(reference)); } catch { /* truthful missing baseline */ } }
  return { id: item.id, title: item.displayTitle ?? item.name, item, sourceSha256: implementation?.sourceSha256 ?? row?.source?.registrySha256, provenance: implementation?.provenance ?? 'licensed-cult-source', framePath, target, file, dir, owner: existing?.via ? publicId(existing.via) : item.id, before, referenceHash };
}));
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'inventory.json'), `${JSON.stringify({ schema: 'catalog-thumbnail-inventory/1', origin: origin.origin, baseline: args.includes('--baseline'), rows: plans }, null, 2)}\n`);
if (!args.includes('--capture')) { console.log(JSON.stringify({ rows: plans.length, inventory: resolve(out, 'inventory.json') })); process.exit(0); }
// Image generation reuses the catalog package's declared dev-only sharp dependency.
const sharp = createRequire(resolve(root, 'packages/cult-ui-catalog/package.json'))('sharp') as (bytes: Buffer) => SharpPipeline;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let liveManifest: { schema: '21st-live-thumbnails/1'; items: Record<string, LiveEntry> };
try { liveManifest = await json(resolve(generated21st, '21st-live-thumbnails.json')); }
catch { liveManifest = { schema: '21st-live-thumbnails/1', items: {} }; }
const results: Array<Record<string, unknown>> = [];
const pendingWrites: Array<{ target: string; bytes: Buffer }> = [];
const captured = new Map<string, Record<string, unknown>>();
const primitiveTargets = new Set(plans.filter(plan => plan.item.assetKind === 'primitive').map(plan => plan.target));
const ordered = [...plans].sort((a, b) => Number(a.owner !== a.id) - Number(b.owner !== b.id) || a.id.localeCompare(b.id));
const owners = new Map<string, (typeof ordered)[number]>();
for (const plan of ordered) if (plan.target && !owners.has(plan.target)) owners.set(plan.target, plan);
const aliases = ordered.filter(plan => plan.target && owners.get(plan.target)?.id !== plan.id);
const queue = ordered.filter(plan => !plan.target || owners.get(plan.target)?.id === plan.id);
let checkpoint = Promise.resolve();
const saveReport = () => {
  const content = `${JSON.stringify({ schema: 'catalog-thumbnail-capture/1', origin: origin.origin, baseline: args.includes('--baseline'), rows: [...results].sort((a,b) => String(a.id).localeCompare(String(b.id))) }, null, 2)}\n`;
  checkpoint = checkpoint.then(() => writeFile(resolve(out, 'report.json'), content));
  return checkpoint;
};
try {
  await Promise.all(Array.from({ length: workers }, async () => {
  while (queue.length) {
    const plan = queue.shift()!;
    if (!plan.framePath || !plan.target || !plan.file) {
      results.push({ id: plan.id, outcome: 'preserved', reason: !plan.framePath ? (plan.item.rights !== undefined && !twenty1stMayShipLocalImage(plan.item.rights) ? 'reference-only row; never captures a local screenshot, neutral placeholder shown instead' : 'no local implementation; upstream reference image retained') : 'no mapped thumbnail target' });
      continue;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', colorScheme: theme });
    const page = await context.newPage();
    let content: Frame | Page = page;
    const errors: string[] = [];
    let brokenMedia: Array<{ src: string; x: number; y: number; width: number; height: number }> = [];
    page.on('pageerror', error => errors.push(error.message));
    // tsx preserves function names with an injected helper; serialized Playwright callbacks
    // need that same identity helper in the isolated capture browser.
    await page.addInitScript('window.__name = value => value;');
    await page.addInitScript(() => {
      Object.assign(window, { __thumbnailMessages: [] });
      addEventListener('message', event => {
        if (event.data && typeof event.data === 'object' && /preview/.test(String(event.data.source)))
          (window as unknown as { __thumbnailMessages: unknown[] }).__thumbnailMessages.push(event.data);
      });
      // Repeatable pose for animation-heavy demos without altering their source.
      let seed = 17;
      Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    });
    try {
      const url = new URL(plan.framePath, origin);
      url.searchParams.set('theme', theme); url.searchParams.set('motion', 'reduced');
      let response;
      if (plan.item.privateImplementation) {
        const frameResponse = page.waitForResponse(response => response.url() === url.href, { timeout: T.long });
        // A loopback-origin host permits the sandboxed iframe's local asset requests.
        // about:blank carries an opaque origin and Chromium blocks these frames.
        const hostUrl = new URL('/__catalog-thumbnail-host', origin).href;
        await page.route(hostUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
        await page.goto(hostUrl);
        await page.setContent(`<style>html,body{margin:0;overflow:hidden}iframe{display:block;width:1280px;height:800px;border:0}</style><script>window.__thumbnailMessages=[];addEventListener("message",event=>{if(event.data&&typeof event.data==="object"&&/preview/.test(String(event.data.source)))window.__thumbnailMessages.push(event.data)});</script><iframe id="capture-preview" sandbox="allow-scripts" allow="encrypted-media *" src="${url.href.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"></iframe>`);
        response = await frameResponse;
        await page.waitForFunction(id => (window as unknown as { __thumbnailMessages: Array<{ source?: string; id?: string; status?: string }> }).__thumbnailMessages.some(message => message.source === 'twentyfirst-private-preview' && message.id === id && ['ready','error'].includes(message.status ?? '')), plan.id, { timeout: T.long });
        const failed = await page.evaluate(id => (window as unknown as { __thumbnailMessages: Array<{ id?: string; status?: string }> }).__thumbnailMessages.some(message => message.id === id && message.status === 'error'), plan.id);
        if (failed) throw new Error('Private demo signalled an error');
        const frame = await (await page.locator('#capture-preview').elementHandle())?.contentFrame();
        if (!frame) throw new Error('Private demo frame unavailable');
        content = frame;
      } else response = await page.goto(url.href, { waitUntil: 'load', timeout: T.long });
      if (!response?.ok()) throw new Error(`Frame HTTP ${response?.status()}`);
      const live = ['primitive', 'app'].includes(plan.item.assetKind ?? '');
      if (live) await content.waitForFunction(() => (window as unknown as { __thumbnailMessages: Array<{ type?: string; status?: string }> }).__thumbnailMessages.some(message => ['ready','error'].includes(message.type ?? message.status ?? '')), undefined, { timeout: T.long });
      if (plan.item.privateImplementation) await content.waitForFunction(() => { const root = document.getElementById('root'); return !!root?.children.length && [...root.querySelectorAll('*')].some(element => { const box = element.getBoundingClientRect(); return box.width > 1 && box.height > 1; }); }, undefined, { timeout: T.long });
      if (plan.id === '21st:serafimcloud-spline-scene') {
        await content.waitForFunction(() => !!document.querySelector('canvas'), undefined, { timeout: T.long });
        await content.waitForLoadState('networkidle', { timeout: T.long });
      }
      await content.evaluate(() => document.querySelectorAll('img').forEach(image => image.loading = 'eager'));
      await content.waitForFunction(() => [...document.images].every(image => image.complete), undefined, { timeout: T.long });
      await content.evaluate(() => document.fonts.ready.then(() => true));
      const observed = await content.evaluate(() => ({
        messages: (window as unknown as { __thumbnailMessages: Array<{ type?: string; status?: string; reason?: string }> }).__thumbnailMessages,
        brokenImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).map(image => { const box = image.getBoundingClientRect(); return { src: image.currentSrc.slice(0, 200), x: box.x, y: box.y, width: box.width, height: box.height }; }),
        text: (document.getElementById('root') ?? document.body).innerText.slice(0, 1400),
        canvases: document.querySelectorAll('canvas').length,
      }));
      if (errors.length || observed.messages.some(message => message.type === 'error' || message.status === 'error')) throw new Error(errors[0] ?? 'Demo signalled an error');
      if (plan.id === '21st:serafimcloud-spline-scene' && !observed.canvases) throw new Error('3D scene has no rendered canvas; upstream reference image retained');
      brokenMedia = observed.brokenImages;
      if (plan.item.assetKind === 'primitive' || primitiveTargets.has(plan.target)) await content.evaluate(() => {
        // Remove only the demo's outer explanatory header. Component-owned headings and labels
        // inside the showcase remain. This changes the capture DOM, never the source files.
        const stage = document.querySelector('[data-cult-stage]');
        const heading = stage?.querySelector('h1');
        const header = heading?.parentElement;
        if (header && header.children.length <= 3 && [...header.children].every(child => child.matches('h1,h2,p')) && !header.querySelector('button,input,img,svg,canvas')) header.remove();
      });
      let clip = await content.evaluate((pageAsset): Box => {
        const root = document.querySelector<HTMLElement>('[data-cult-stage]') ?? document.getElementById('od-live-preview') ?? document.getElementById('root') ?? document.body;
        if (pageAsset) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
        const boxes: Box[] = [];
        const visibleBox = (rect: DOMRect, element: Element): Box | null => {
          let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
          for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .1) return null;
            if (ancestor !== element) {
              const bounds = ancestor.getBoundingClientRect();
              if (['hidden','clip','auto','scroll'].includes(style.overflowX)) { left = Math.max(left,bounds.left); right = Math.min(right,bounds.right); }
              if (['hidden','clip','auto','scroll'].includes(style.overflowY)) { top = Math.max(top,bounds.top); bottom = Math.min(bottom,bounds.bottom); }
            }
          }
          return right - left > 1 && bottom - top > 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
        };
        for (const element of root.querySelectorAll<HTMLElement>('*')) {
          if (element.matches('style,script,template')) continue;
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.right <= 0 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .1) continue;
          if (element.closest('[data-sonner-toaster]')) continue;
          const paintedBox = (parseFloat(style.borderRadius) >= 6 && style.backgroundColor !== 'rgba(0, 0, 0, 0)') || style.boxShadow !== 'none';
          if (element.matches('button,input,textarea,select,img,video,canvas,svg') || (paintedBox && rect.height < innerHeight * .9)) { const box = visibleBox(rect, element); if (box) boxes.push(box); }
          for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            const range = document.createRange(); range.selectNode(node); for (const rect of range.getClientRects()) { const box = visibleBox(rect, element); if (box) boxes.push(box); }
          }
        }
        if (!boxes.length) throw new Error('No visible demo content');
        const pad = 24, x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)) - pad)), y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)) - pad));
        const right = Math.min(document.documentElement.scrollWidth, Math.ceil(Math.max(...boxes.map(box => box.x + box.width)) + pad));
        const bottom = Math.min(document.documentElement.scrollHeight, Math.ceil(Math.max(...boxes.map(box => box.y + box.height)) + pad));
        return { x, y, width: Math.max(1, right - x), height: Math.max(1, Math.min(1280, bottom - y)) };
      }, plan.item.assetKind === 'page');
      const brokenInCapture = brokenMedia.filter(image => image.width > 1 && image.height > 1 && image.x < clip.x + clip.width && image.x + image.width > clip.x && image.y < clip.y + clip.height && image.y + image.height > clip.y);
      if (brokenInCapture.length) throw new Error(`Broken media in capture (${brokenInCapture.length}); existing thumbnail preserved`);
      if (plan.item.privateImplementation && clip.y + clip.height > 800) clip = { ...clip, height: Math.max(1, 800 - clip.y) };
      if (plan.id === '21st:serafimcloud-spline-scene') {
        const canvas = content.locator('canvas').first();
        const canvasImage = await canvas.screenshot();
        const canvasStats = await sharp(canvasImage).stats();
        if (canvasStats.channels.slice(0,3).every(channel => channel.stdev < 5)) throw new Error('3D canvas is not painted; upstream reference retained');
      }
      const png = await page.screenshot({ clip, animations: 'disabled' });
      const stats = await sharp(png).stats();
      if (stats.channels.slice(0, 3).every(channel => channel.stdev < 3)) throw new Error('Blank capture; existing thumbnail preserved');
      let encoded: Buffer | undefined;
      for (const quality of [82, 72, 62, 52, 42, 32]) {
        const candidate = await sharp(png).resize(480, 300, { fit: 'contain', withoutEnlargement: true, background: theme === 'light' ? '#ffffff' : '#101214' }).webp({ quality, effort: 6 }).toBuffer();
        if (candidate.length <= 20480) { encoded = candidate; break; }
      }
      if (!encoded) throw new Error('No image fits the existing 20 KiB thumbnail budget');
      const after = { bytes: encoded.length, sha256: hash(encoded) };
      const candidatePath = resolve(out, `${plan.id.replace(':','-')}.webp`);
      await writeFile(candidatePath, encoded);
      const result = { id: plan.id, sourceSha256: plan.sourceSha256, refinement: plan.item.privateImplementation?.refinement, provenance: plan.provenance, outcome: args.includes('--write') ? 'written' : 'candidate', framePath: url.pathname + url.search, target: relative(root, plan.target), candidate: relative(root, candidatePath), clip, before: plan.before, beforeReferenceSha256: plan.referenceHash, after, text: observed.text, errors };
      if (args.includes('--write')) {
        // Stage all bytes until the capture sweep completes. An interrupted browser run must
        // leave the product images and their provenance manifests consistent.
        pendingWrites.push({ target: plan.target, bytes: encoded });
        const implementation = plan.item.privateImplementation ?? plan.item.ownedAlternative;
        if (implementation && plan.dir === '21st-live-thumbnails') liveManifest.items[plan.id] = { file: plan.file, bytes: encoded.length, revision: after.sha256, sourceSha256: implementation.sourceSha256, provenance: implementation.provenance, framePath: result.framePath };
        else for (const entry of Object.values(thumbnails.items)) if (entry.file === plan.file && entry.source !== 'demo') entry.bytes = encoded.length;
      }
      captured.set(plan.target, result); results.push(result);
    } catch (error) { results.push({ id: plan.id, outcome: 'preserved', target: relative(root, plan.target), before: plan.before, reason: error instanceof Error ? error.message : String(error), errors, brokenMedia }); }
    finally { await context.close(); }
    await saveReport();
    if (results.length % 20 === 0) console.log(`${results.length}/${plans.length}`);
  }
  }));
  for (const plan of aliases) {
    const owner = owners.get(plan.target!)!, shared = captured.get(plan.target!);
    results.push(shared ? { ...shared, id: plan.id, outcome: 'shared', owner: owner.id } : { id: plan.id, outcome: 'preserved', owner: owner.id, reason: 'Shared owner capture failed; existing thumbnail preserved', before: plan.before });
  }
  results.sort((a,b) => String(a.id).localeCompare(String(b.id)));
  await saveReport();
} finally { await browser.close(); }
if (args.includes('--write')) {
  for (const output of pendingWrites) { await mkdir(dirname(output.target), { recursive: true }); await writeFile(output.target, output.bytes); }
  liveManifest.items = Object.fromEntries(Object.entries(liveManifest.items).sort(([a],[b]) => a.localeCompare(b)));
  await writeFile(resolve(generated21st, '21st-live-thumbnails.json'), `${JSON.stringify(liveManifest, null, 2)}\n`);
  await writeFile(resolve(generated, 'thumbnails.json'), `${JSON.stringify(thumbnails, null, 2)}\n`);
  let previousRows: Array<Record<string, unknown>> = [];
  let previousMetadata: Record<string, unknown> = {};
  if (only) {
    try { const { rows: savedRows, ...metadata } = await json<{ rows: Array<Record<string, unknown>> }>(resolve(generated, 'thumbnail-capture-report.json')); previousRows = savedRows; previousMetadata = metadata; } catch { /* first selected capture */ }
  }
  const merged = new Map(previousRows.map(row => [String(row.id), row]));
  for (const row of results) {
    const previous = merged.get(String(row.id));
    const { candidate: _candidate, ...artifactRow } = row;
    // Review candidate paths stay in the scratch report; product reports refer to final assets.
    // A selected repair keeps the original before/after mapping for the full sweep.
    merged.set(String(row.id), previous ? { ...artifactRow, before: previous.before, beforeReferenceSha256: previous.beforeReferenceSha256 } : artifactRow);
  }
  await writeFile(resolve(generated, 'thumbnail-capture-report.json'), `${JSON.stringify({ ...previousMetadata, schema: 'catalog-thumbnail-capture/1', rows: [...merged.values()].sort((a,b) => String(a.id).localeCompare(String(b.id))) }, null, 2)}\n`);
}
console.log(JSON.stringify({ rows: plans.length, updated: results.filter(row => ['written','candidate','shared'].includes(String(row.outcome))).length, preserved: results.filter(row => row.outcome === 'preserved').length, report: resolve(out,'report.json') }));
