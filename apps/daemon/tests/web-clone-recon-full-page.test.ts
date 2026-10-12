import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const reconPath = path.join(repoRoot, 'skills/web-clone/scripts/recon-site.mjs');
const loaderPath = path.join(repoRoot, 'skills/web-clone/scripts/lib/playwright-loader.mjs');
const pngStitchPath = path.join(repoRoot, 'skills/web-clone/scripts/lib/png-stitch.mjs');

const { findSystemChromiumExecutable } = (await import(pathToFileURL(loaderPath).href)) as {
  findSystemChromiumExecutable: () => string | null;
};
const systemBrowserPath = path.join(repoRoot, 'skills/web-clone/scripts/lib/system-browser.mjs');
const { systemChromium } = (await import(pathToFileURL(systemBrowserPath).href)) as {
  systemChromium: {
    launch: (options: { executablePath: string }) => Promise<{
      close: () => Promise<void>;
      newPage: (options: { viewport: { width: number; height: number } }) => Promise<{
        goto: (url: string) => Promise<unknown>;
        evaluate: (fn: () => unknown) => Promise<unknown>;
        screenshot: (options: { fullPage: boolean }) => Promise<Buffer>;
      }>;
    }>;
  };
};

// The skill never downloads a browser, so these specs need a local Chrome,
// Edge or Chromium that can actually start here (a sandbox-restricted CI host
// may have the binary but refuse to launch it).
async function usableBrowserExecutable(): Promise<string | null> {
  let executable: string | null = null;
  try {
    executable = findSystemChromiumExecutable();
  } catch {
    return null;
  }
  if (!executable) return null;
  try {
    const browser = await systemChromium.launch({ executablePath: executable });
    await browser.close();
    return executable;
  } catch {
    return null;
  }
}
const browserExecutable = await usableBrowserExecutable();

const VIEWPORT_WIDTH = 1024;
const TALL_PAGE_HEIGHT = 15_000;

// A real reference site is 12k-18k px tall and full of photographs, so its
// full-page PNG is far larger than the colour blocks a toy page produces. The
// noise canvas makes the capture incompressible: one screenshot message of a
// tall photographic page exceeds 4 MiB, which is what killed the CDP socket.
function tallPage(height: number): string {
  const blocks = Math.ceil((height - 1800) / 500);
  const sections = Array.from(
    { length: blocks },
    (_, i) => `<section style="height:500px;background:hsl(${(i * 37) % 360},55%,65%)"><h2>Section ${i}</h2></section>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><title>Tall recon fixture</title></head>
<body style="margin:0"><main>
<canvas id="noise" width="${VIEWPORT_WIDTH}" height="1800" style="display:block;width:${VIEWPORT_WIDTH}px;height:1800px"></canvas>
${sections}
</main><script>
const canvas = document.getElementById('noise');
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(canvas.width, canvas.height);
for (let offset = 0; offset < image.data.length; offset += 65536) {
  crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65536, image.data.length)));
}
for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
ctx.putImageData(image, 0, 0);
</script></body></html>`;
}

// Deterministic, static content (no animation, no randomness) with a fixed
// header, so a stitched capture can be compared pixel for pixel with one
// single full-page capture of the same page.
const SEAM_PAGE_HEIGHT = 9_000;
const seamPage = `<!doctype html><html lang="en"><head><title>Seam fixture</title>
<style>body{margin:0;font:16px/1.4 sans-serif}header{position:fixed;top:0;left:0;right:0;height:60px;background:#123456;color:#fff}
section{box-sizing:border-box;height:300px;border-top:1px solid #000;background:linear-gradient(90deg,#f00,#00f)}section:nth-child(odd){background:repeating-linear-gradient(180deg,#0a0 0 7px,#ff0 7px 13px)}
*{animation:none!important;transition:none!important;caret-color:transparent}</style></head>
<body><header>Fixed header</header><main>${Array.from({ length: SEAM_PAGE_HEIGHT / 300 }, (_, i) => `<section>Row ${i}</section>`).join('')}</main></body></html>`;

// Horizontal overflow far wider than the viewport.
const widePage = `<!doctype html><html lang="en"><head><title>Wide fixture</title></head>
<body style="margin:0"><main><div style="width:5000px;height:6000px;background:linear-gradient(90deg,#fafafa,#333)">Wide</div></main></body></html>`;

const shortPage = `<!doctype html><html lang="en"><head><title>Short recon fixture</title></head>
<body style="margin:0;background:#fafafa"><main><h1>Example</h1><p>Short page.</p></main></body></html>`;

let server: http.Server;
let baseUrl = '';
const tempDirs: string[] = [];

beforeAll(async () => {
  const tall = tallPage(TALL_PAGE_HEIGHT);
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const pages: Record<string, string> = { '/tall': tall, '/seam': seamPage, '/wide': widePage };
    response.end(pages[request.url ?? ''] ?? shortPage);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runRecon(url: string, extraArgs: string[] = []) {
  const outDir = mkdtempSync(path.join(tmpdir(), 'od-web-clone-recon-'));
  tempDirs.push(outDir);
  return new Promise<{ code: number | null; stderr: string; outDir: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [reconPath, '--url', url, '--out', outDir, '--label', 'fixture', '--widths', String(VIEWPORT_WIDTH), '--wait', '0', ...extraArgs],
      {
        cwd: outDir,
        env: {
          ...process.env,
          OD_DAEMON_URL: '',
          OD_PROJECT_ID: '',
          OD_PLAYWRIGHT_PACKAGE: '',
          OD_PLAYWRIGHT_PATH: '',
          // Vitest exports a NODE_PATH that reaches the pnpm store, where a
          // Playwright package would silently replace the zero-dependency CDP
          // layer that staged skills actually run with.
          NODE_PATH: '',
          ...(browserExecutable ? { OD_BROWSER_EXECUTABLE_PATH: browserExecutable } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr, outDir }));
  });
}

function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

type Capture = {
  screenshot: string;
  screenshotCapture: {
    mode: string;
    fullPage: boolean;
    pageHeight: number;
    capturedHeight: number;
    tileCount: number;
    tileHeight: number;
    maxHeight: number;
    truncated: boolean;
    captureWidth: number;
    contentWidth: number;
    horizontalOverflow: boolean;
  };
};

function readCapture(outDir: string): Capture {
  const recon = JSON.parse(readFileSync(path.join(outDir, 'fixture-recon.json'), 'utf8')) as { captures: Capture[] };
  expect(recon.captures).toHaveLength(1);
  return recon.captures[0]!;
}

describe.skipIf(!browserExecutable)('Website Clone recon-site full-page capture', () => {
  it('captures a 15,000 px photographic page without losing the CDP connection', async () => {
    const { code, stderr, outDir } = await runRecon(`${baseUrl}/tall`);

    expect(stderr).not.toContain('CDP connection closed');
    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({ mode: 'tiled', fullPage: true, truncated: false });
    expect(capture.screenshotCapture.pageHeight).toBeGreaterThanOrEqual(TALL_PAGE_HEIGHT);
    expect(capture.screenshotCapture.tileCount).toBeGreaterThan(1);
    expect(pngSize(path.join(outDir, capture.screenshot))).toEqual({
      width: VIEWPORT_WIDTH,
      height: capture.screenshotCapture.pageHeight,
    });
  }, 180_000);

  it('records the cap when the page is taller than --full-page-max-height', async () => {
    const { code, stderr, outDir } = await runRecon(`${baseUrl}/tall`, ['--full-page-max-height', '6000']);

    expect(stderr).toContain('full-page screenshot truncated at 6000px');
    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({ mode: 'tiled', truncated: true, capturedHeight: 6000, maxHeight: 6000 });
    expect(pngSize(path.join(outDir, capture.screenshot))).toEqual({ width: VIEWPORT_WIDTH, height: 6000 });
  }, 180_000);

  it('clips a horizontally overflowing page to the viewport width and records the overflow', async () => {
    const { code, outDir } = await runRecon(`${baseUrl}/wide`);

    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({
      mode: 'tiled',
      captureWidth: VIEWPORT_WIDTH,
      horizontalOverflow: true,
      truncated: false,
    });
    expect(capture.screenshotCapture.contentWidth).toBeGreaterThanOrEqual(5000);
    // The pixel budget applies to the captured width, never the content width.
    expect(capture.screenshotCapture.maxHeight * capture.screenshotCapture.captureWidth).toBeLessThanOrEqual(1440 * 20000);
    expect(pngSize(path.join(outDir, capture.screenshot))).toEqual({ width: VIEWPORT_WIDTH, height: 6000 });
  }, 180_000);

  it('stitches segments that match one single full-page capture at every seam', async () => {
    const { code, outDir } = await runRecon(`${baseUrl}/seam`);
    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({ mode: 'tiled', tileCount: 3, capturedHeight: SEAM_PAGE_HEIGHT });

    const browser = await systemChromium.launch({ executablePath: browserExecutable! });
    let single: Buffer;
    try {
      const page = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: 900 } });
      await page.goto(`${baseUrl}/seam`);
      single = await page.screenshot({ fullPage: true });
    } finally {
      await browser.close();
    }
    const { decodePngToRgba } = (await import(pathToFileURL(pngStitchPath).href)) as {
      decodePngToRgba: (png: Buffer) => { width: number; height: number; pixels: Buffer };
    };
    const stitched = decodePngToRgba(readFileSync(path.join(outDir, capture.screenshot)));
    const reference = decodePngToRgba(single);
    expect([stitched.width, stitched.height]).toEqual([reference.width, reference.height]);
    // Chrome dithers gradients, so two single captures of the same page already
    // differ by 1 per channel. A misplaced seam, a dropped or repeated row or a
    // fixed header painted again inside a segment shows up as a large difference.
    const rowBytes = stitched.width * 4;
    const maxRowDifference = (y: number) => {
      let max = 0;
      for (let i = y * rowBytes; i < (y + 1) * rowBytes; i += 1) {
        max = Math.max(max, Math.abs(stitched.pixels[i]! - reference.pixels[i]!));
      }
      return max;
    };
    for (const seam of [4000, 8000]) {
      for (let y = seam - 70; y <= seam + 70; y += 1) {
        expect(maxRowDifference(y), `row ${y} differs from the single capture`).toBeLessThanOrEqual(2);
      }
    }
    let worst = 0;
    for (let y = 0; y < stitched.height; y += 1) worst = Math.max(worst, maxRowDifference(y));
    expect(worst).toBeLessThanOrEqual(2);
  }, 180_000);

  it('keeps a short page as one full-page capture', async () => {
    const { code, stderr, outDir } = await runRecon(`${baseUrl}/short`);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({ mode: 'single', fullPage: true, tileCount: 1, truncated: false });
    expect(pngSize(path.join(outDir, capture.screenshot))).toEqual({ width: VIEWPORT_WIDTH, height: 900 });
  }, 120_000);

  it('writes a viewport screenshot with --no-full-page', async () => {
    const { code, outDir } = await runRecon(`${baseUrl}/tall`, ['--no-full-page']);

    expect(code).toBe(0);
    const capture = readCapture(outDir);
    expect(capture.screenshotCapture).toMatchObject({ mode: 'viewport', fullPage: false, capturedHeight: 900 });
    expect(capture.screenshotCapture.pageHeight).toBeGreaterThanOrEqual(TALL_PAGE_HEIGHT);
    expect(pngSize(path.join(outDir, capture.screenshot))).toEqual({ width: VIEWPORT_WIDTH, height: 900 });
  }, 120_000);
});

// Builds an RGB PNG whose every row uses one filter type, so stitching must
// rewrite the first row of each later segment (Up/Paeth read the row above).
function filteredPng(rows: number[][][], filter: number): Buffer {
  const width = rows[0]!.length;
  const raw: number[] = [];
  rows.forEach((row, y) => {
    raw.push(filter);
    row.forEach((pixel, x) => {
      pixel.forEach((value, channel) => {
        const left = x > 0 ? row[x - 1]![channel]! : 0;
        const up = y > 0 ? rows[y - 1]![x]![channel]! : 0;
        raw.push((value - (filter === 1 ? left : filter === 2 ? up : 0) + 256) & 255);
      });
    });
  });
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('Website Clone full-page PNG stitching', () => {
  it('stitches Up-filtered segments without corrupting the seam rows, and crops to the cap', async () => {
    const { stitchPngsVertically, decodePng } = (await import(pathToFileURL(pngStitchPath).href)) as {
      stitchPngsVertically: (segments: Buffer[], options?: { maxHeight?: number }) => { png: Buffer; width: number; height: number };
      decodePng: (png: Buffer) => { width: number; height: number; stride: number; data: Buffer };
    };
    const top = [[[10, 20, 30], [40, 50, 60]], [[70, 80, 90], [100, 110, 120]]];
    const bottom = [[[200, 0, 5], [1, 2, 3]], [[9, 8, 7], [250, 251, 252]]];
    const stitched = stitchPngsVertically([filteredPng(top, 1), filteredPng(bottom, 2)], { maxHeight: 3 });

    expect(stitched).toMatchObject({ width: 2, height: 3 });
    const decoded = decodePng(stitched.png);
    const pixels: number[][][] = [];
    let previous = Buffer.alloc(decoded.stride - 1);
    for (let y = 0; y < decoded.height; y += 1) {
      const row = decoded.data.subarray(y * decoded.stride, (y + 1) * decoded.stride);
      const filter = row[0]!;
      const values = Buffer.from(row.subarray(1));
      for (let i = 0; i < values.length; i += 1) {
        const left = i >= 3 ? values[i - 3]! : 0;
        values[i] = (values[i]! + (filter === 1 ? left : filter === 2 ? previous[i]! : 0)) & 255;
      }
      pixels.push([[...values.subarray(0, 3)], [...values.subarray(3, 6)]]);
      previous = values;
    }
    expect(pixels).toEqual([...top, bottom[0]]);
  });
});
