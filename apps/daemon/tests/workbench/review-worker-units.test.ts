import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { CdpPipe } from '../../src/workbench/review/cdp-pipe.js';
import { contrastRatio, isLargeText } from '../../src/workbench/review/color.js';
import { REVIEW_PREVIEW_ORIGIN, isMockedSubmission } from '../../src/workbench/review/cdp-worker.js';
import { MAX_TEXT_SAMPLES, PAGE_PROBE } from '../../src/workbench/review/page-scripts.js';
import { readPreviewFile } from '../../src/workbench/review/preview-files.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('preview file resolution (evidence origin is the project root only)', () => {
  async function project() {
    const base = await mkdtemp(path.join(tmpdir(), 'od-review-files-')); dirs.push(base);
    const root = path.join(base, 'project'); await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<!doctype html>');
    await writeFile(path.join(root, 'assets', 'my font.woff2'), 'font');
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    await writeFile(path.join(base, 'outside.txt'), 'outside');
    await symlink(path.join(base, 'outside.txt'), path.join(root, 'escape.txt'));
    return root;
  }

  it('serves files and directory indexes with their SHA-256', async () => {
    const root = await project();
    const index = await readPreviewFile(root, '/');
    expect(index).toMatchObject({ status: 200, relPath: 'index.html', contentType: 'text/html; charset=utf-8', sha256: createHash('sha256').update('<!doctype html>').digest('hex') });
    expect(await readPreviewFile(root, '/assets/my%20font.woff2')).toMatchObject({ status: 200, relPath: 'assets/my font.woff2', contentType: 'font/woff2' });
  });

  it('refuses traversal, dotfiles and symlinks that leave the project', async () => {
    const root = await project();
    expect((await readPreviewFile(root, '/../outside.txt')).status).toBe(403);
    expect((await readPreviewFile(root, '/assets/%2e%2e/%2e%2e/outside.txt')).status).toBe(403);
    expect((await readPreviewFile(root, '/a%2F..%2F..%2Foutside.txt')).status).toBe(403);
    expect((await readPreviewFile(root, '/.env')).status).toBe(403);
    expect((await readPreviewFile(root, '/escape.txt')).status).toBe(403);
    expect((await readPreviewFile(root, '/%E0%A4%A')).status).toBe(403);
    expect((await readPreviewFile(root, '/missing.html')).status).toBe(404);
  });

  it('refuses an in-project symlink whose target is a hidden file or directory', async () => {
    const root = await project();
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), '[remote "origin"] url = secret');
    await symlink(path.join(root, '.env'), path.join(root, 'public.txt'));
    await symlink(path.join(root, '.git', 'config'), path.join(root, 'config.txt'));
    await symlink(path.join(root, '.git'), path.join(root, 'meta'));
    for (const url of ['/public.txt', '/config.txt', '/meta/config']) {
      const file = await readPreviewFile(root, url);
      expect(file.status, url).toBe(403);
      expect('body' in file, url).toBe(false);
    }
  });

  it('still serves an in-project symlink to a visible file', async () => {
    const root = await project();
    await symlink(path.join(root, 'index.html'), path.join(root, 'home.html'));
    expect(await readPreviewFile(root, '/home.html')).toMatchObject({ status: 200, relPath: 'home.html' });
  });
});

describe('CDP pipe transport', () => {
  it('matches responses to requests across split NUL-delimited frames and routes events by session', async () => {
    const toBrowser = new PassThrough(); const fromBrowser = new PassThrough();
    const cdp = new CdpPipe(toBrowser, fromBrowser);
    const sent: string[] = []; toBrowser.on('data', chunk => sent.push(String(chunk)));
    const events: [unknown, string | undefined][] = [];
    cdp.on('Page.loadEventFired', (params, sessionId) => events.push([params, sessionId]));
    const reply = cdp.send('Browser.getVersion');
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.parse(sent[0]!.replace(/\0$/u, ''))).toEqual({ id: 1, method: 'Browser.getVersion', params: {} });
    const frame = `${JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's1' })}\0${JSON.stringify({ id: 1, result: { product: 'HeadlessChrome/140' } })}\0`;
    fromBrowser.write(frame.slice(0, 17)); fromBrowser.write(frame.slice(17));
    expect(await reply).toEqual({ product: 'HeadlessChrome/140' });
    expect(events).toEqual([[{ timestamp: 1 }, 's1']]);
  });

  it('rejects pending calls with protocol errors and when the pipe closes', async () => {
    const fromBrowser = new PassThrough();
    const cdp = new CdpPipe(new PassThrough(), fromBrowser);
    const failing = cdp.send('Page.navigate');
    fromBrowser.write(`${JSON.stringify({ id: 1, error: { message: 'Invalid parameters' } })}\0`);
    await expect(failing).rejects.toThrow('Invalid parameters');
    const pending = cdp.send('Runtime.evaluate');
    fromBrowser.destroy();
    await expect(pending).rejects.toThrow('closed');
  });
});

describe('in-page probe script', () => {
  it('parses, interpolates the text sample cap and reports truncation', () => {
    expect(() => new Function(`return (${PAGE_PROBE});`)).not.toThrow();
    expect(PAGE_PROBE).toContain(`texts.length < ${MAX_TEXT_SAMPLES}`);
    expect(PAGE_PROBE).toMatch(/texts, textsTruncated,/);
  });
});

describe('WCAG contrast math', () => {
  it('matches known reference ratios and the large-text rule', () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrastRatio([119, 119, 119, 1], [255, 255, 255, 1])).toBeCloseTo(4.48, 2);
    expect(contrastRatio([170, 170, 170, 1], [255, 255, 255, 1])).toBeCloseTo(2.32, 2);
    expect(contrastRatio([0, 0, 0, 0.5], [255, 255, 255, 1])).toBeCloseTo(3.95, 1);
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(18.67, 700)).toBe(true);
    expect(isLargeText(18.67, 400)).toBe(false);
  });
});

describe('form submissions go to the mock destination, never the project root', () => {
  const page = `${REVIEW_PREVIEW_ORIGIN}/index.html`;
  const getForms = new Set([`${REVIEW_PREVIEW_ORIGIN}/subscribe`, page]);

  it('mocks every non-GET request, whatever its destination', () => {
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/subscribe`, method: 'POST', resourceType: 'Document' }, new Set())).toBe(true);
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/api`, method: 'PUT', resourceType: 'XHR' }, new Set())).toBe(true);
  });

  it('mocks a GET form navigation to a declared form action, query and fragment ignored', () => {
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/subscribe?email=review-probe%40example.invalid`, method: 'GET', resourceType: 'Document' }, getForms)).toBe(true);
    expect(isMockedSubmission({ url: `${page}?q=Review+probe#results`, method: 'GET', resourceType: 'Document' }, getForms)).toBe(true);
  });

  it('serves ordinary GET requests from the project root, so missing pages and resources stay visible', () => {
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/missing.html`, method: 'GET', resourceType: 'Document' }, getForms)).toBe(false);
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/subscribe?x=1`, method: 'GET', resourceType: 'Image' }, getForms)).toBe(false);
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/subscribe?x=1`, method: 'GET', resourceType: 'Document' }, new Set())).toBe(false);
    expect(isMockedSubmission({ url: `${REVIEW_PREVIEW_ORIGIN}/subscribe`, method: 'HEAD', resourceType: 'Document' }, getForms)).toBe(false);
  });
});
