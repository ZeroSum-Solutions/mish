import { test, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveArtifacts } from '../../benchmarks/quality/capture.ts';
test('artifact server serves inventory files only and rejects symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-server-'));
  await writeFile(join(root, 'index.html'), '<h1>fixture</h1>');
  await writeFile(join(root, 'private.txt'), 'not in inventory');
  await symlink('/etc/hosts', join(root, 'escape.txt'));
  const server = await serveArtifacts(root, ['index.html', 'escape.txt']);
  try {
    expect(await (await fetch(`${server.url}/index.html`)).text()).toBe('<h1>fixture</h1>');
    expect((await fetch(`${server.url}/private.txt`)).status).toBe(404);
    expect((await fetch(`${server.url}/escape.txt`)).status).toBe(404);
    expect((await fetch(`${server.url}/index.html`, { method: 'POST' })).status).toBe(404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

import { readFile } from 'node:fs/promises';
import { captureRun, VIEWPORTS } from '../../benchmarks/quality/capture.ts';
import { runBenchmark } from '../../benchmarks/quality/run.ts';
import { startStub } from '../../benchmarks/quality/stub.ts';
import { verifyFiles } from '../../benchmarks/quality/packet.ts';
import { T } from '../../lib/timeouts.ts';

// These faults coexist so one browser batch witnesses the probes at every width.
test('records five widths, section crops and failed interaction/resource evidence without judging', async () => {
  expect(VIEWPORTS).toEqual([{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]);
  const root = await mkdtemp(join(tmpdir(), 'quality-capture-'));
  const font = await readFile(new URL('../../../apps/web/public/fonts/IBMPlexMono-400-latin.woff2', import.meta.url));
  const stub = await startStub({ files: { 'assets/local.woff2': font }, htmlSuffix: `<style>
    @font-face{font-family:Local;src:url(assets/local.woff2)} .local{font-family:Local}
    @font-face{font-family:Missing;src:url(missing.woff2)} h1{font-family:Missing,serif}
    a:focus{outline:3px solid red} .wide{width:1800px} .move{animation:move 1s infinite}
    @keyframes move{to{transform:translateX(20px)}}
    @media(prefers-reduced-motion:reduce){.move{animation:none}}
    </style><main><section id="hero"><h2>Hero</h2><a id="trap" href="missing.html">Request an appointment</a></section>
    <section id="details"><p class="local">Loaded local font</p><a href="#details">Request an appointment locally</a><p class="wide">Overflow</p><div class="move">Animation</div></section>
    <form action="/submit" method="post"><label>Name<input name="name" required></label><button>Send</button></form></main>
    <script>fetch('https://example.invalid/remote');document.getElementById('trap').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();e.currentTarget.focus()}})</script>` });
  try {
    const out = join(root, 'run');
    const run = await runBenchmark({ daemon: stub.url, out, agent: 'stub', model: 'stub', timeoutMs: 1000, mode: 'stub', caseId: 'dental' });
    const captures = await captureRun(out, run);
    expect(captures.schema).toBe('quality-captures/2');
    expect(captures.facts).toHaveLength(20);
    const ids = captures.facts.flatMap(fact => [fact.id, ...fact.sections.map(section => section.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fact of captures.facts) {
      expect(fact.error).toBeUndefined();
      expect(fact.horizontalOverflowPx).toBeGreaterThan(0);
      expect(fact.sections.some(section => section.selector.includes('section'))).toBe(true);
      expect(fact.sections.every(section => section.screenshotSha256 && section.box.width > 0)).toBe(true);
      expect(fact.conversion.status).toBe('complete');
      if (fact.conversion.status === 'complete') {
        expect(fact.conversion.value.matches.some(match => !match.resolves)).toBe(true);
        expect(fact.conversion.value.matches.some(match => match.target === '#details' && match.resolves)).toBe(true);
      }
      expect(fact.keyboard.status).toBe('complete');
      if (fact.keyboard.status === 'complete') {
        expect(fact.keyboard.value.trapDetected).toBe(true);
        expect(fact.keyboard.value.steps.some(step => step.visibleFocus === true)).toBe(true);
        expect(fact.keyboard.value.steps.some(step => step.primary)).toBe(true);
        expect(fact.keyboard.value.primaryReachable).toBe(false);
      }
      if (fact.forms.status === 'complete') expect(fact.forms.value.some(form => form.requests.some(request => request.method === 'POST'))).toBe(true);
      else throw new Error('Form evidence missing');
      if (fact.motion.status === 'complete') {
        expect(fact.motion.value.normal.animationCount).toBeGreaterThan(fact.motion.value.reduced.animationCount);
        expect(fact.motion.value.normal.layoutShift).toBeGreaterThanOrEqual(0);
      } else throw new Error('Motion evidence missing');
      if (fact.resources.status === 'complete') {
        expect(fact.resources.value.fontFaces.some(face => face.family === 'Missing' && face.status === 'error')).toBe(true);
        expect(fact.resources.value.requests.some(request => request.url.includes('missing.woff2') && request.status === 404)).toBe(true);
        expect(fact.resources.value.imageBytes).toBeGreaterThan(0);
        expect(fact.resources.value.fontBytes).toBe(font.length);
        expect(fact.resources.value.fontFaces.some(face => face.family === 'Local' && face.status === 'loaded')).toBe(true);
        expect(fact.resources.value.images[0]!.natural.width).toBe(400);
      } else throw new Error('Resource evidence missing');
      expect(fact.blockedRequests.some(url => url.includes('example.invalid'))).toBe(true);
    }
    await expect(verifyFiles(out, run, captures)).resolves.toBeUndefined();
    const receipt = captures.facts[0]!.evidenceFile!;
    const receiptBytes = await readFile(join(out, receipt));
    await writeFile(join(out, receipt), '{}');
    await expect(verifyFiles(out, run, captures)).rejects.toThrow(/evidence changed/);
    await writeFile(join(out, receipt), receiptBytes);
    const crop = captures.facts[0]!.sections[0]!;
    await writeFile(join(out, crop.screenshot), 'tampered');
    await expect(verifyFiles(out, run, captures)).rejects.toThrow(/screenshot changed/);
    expect(JSON.parse(await readFile(join(out, 'captures.json'), 'utf8')).schema).toBe('quality-captures/2');
  } finally { await stub.close(); await rm(root, { recursive: true, force: true }); }
}, T.xlong);

import { chromium } from '@playwright/test';
import { conversionProbe } from '../../benchmarks/quality/probes.ts';
import { selectCases } from '../../benchmarks/quality/cases.ts';

test('ordinary contact navigation cannot stand in for the declared appointment action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-conversion-'));
  await writeFile(join(root, 'index.html'), '<a href="contact.html">Contact</a>');
  await writeFile(join(root, 'contact.html'), '<h1>Contact</h1>');
  const server = await serveArtifacts(root, ['index.html', 'contact.html']);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(`${server.url}/index.html`);
    const result = await conversionProbe(page, selectCases('dental')[0]!.conversion, ['index.html', 'contact.html'], ['contact.html']);
    expect(result.exists).toBe(false);
    expect(result.resolves).toBe(false);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}, T.long);
