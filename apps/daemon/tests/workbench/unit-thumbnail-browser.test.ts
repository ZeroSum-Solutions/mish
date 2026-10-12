import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findBrowserExecutable } from '../../src/browser-sessions.js';
import { sniffRaster } from '../../src/workbench/capture/image.js';
import { createUnitThumbnailRenderer } from '../../src/workbench/units/thumbnail.js';

// AC-R14.3 thumbnail in a real headless browser. Unit code renders under the
// isolated review origin: it cannot reach the daemon /api or any network.
//   OD_REVIEW_BROWSER_TESTS=1 pnpm exec vitest run tests/workbench/unit-thumbnail-browser.test.ts
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';

describe.skipIf(!optedIn)('unit thumbnail in a real browser', () => {
  const dirs: string[] = []; let api: Server | undefined;
  afterAll(async () => {
    if (api) await new Promise<void>(resolve => api!.close(() => resolve()));
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('renders a PNG of the staged unit while every request to the daemon is refused', async () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
    const hits: string[] = [];
    api = createServer((req, res) => { hits.push(req.url ?? ''); res.end('{}'); });
    await new Promise<void>(resolve => api!.listen(0, '127.0.0.1', resolve));
    const port = (api.address() as AddressInfo).port;
    const staged = await mkdtemp(path.join(tmpdir(), 'od-unit-thumb-')); dirs.push(staged);
    const data = await mkdtemp(path.join(tmpdir(), 'od-unit-thumb-data-')); dirs.push(data);
    await writeFile(path.join(staged, 'index.html'), `<!doctype html><html><body style="margin:0;background:#2a6"><main id="root"><h1>Unit</h1></main>
<img src="http://127.0.0.1:${port}/api/projects/leak.png"><script>fetch('http://127.0.0.1:${port}/api/projects').catch(() => {}); fetch('/api/projects').catch(() => {});</script></body></html>`);
    const result = await createUnitThumbnailRenderer(data)(staged, 'index.html');
    expect('png' in result, 'unavailable' in result ? result.unavailable : '').toBe(true);
    if (!('png' in result)) return;
    expect(sniffRaster(result.png)).toMatchObject({ mediaType: 'image/png' });
    expect(hits).toEqual([]);
  }, 120_000);
});
