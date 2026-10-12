import { test, expect } from 'vitest';
import { chromium, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveArtifacts } from '../../benchmarks/quality/capture.ts';
import { conversionProbe, keyboardProbe, formProbe, resourceProbe } from '../../benchmarks/quality/probes.ts';
import { selectCases } from '../../benchmarks/quality/cases.ts';
import { CAPTURE_SETTINGS } from '../../benchmarks/quality/settings.ts';

async function fixture(html: string, check: (page: Page) => Promise<void>, files: Record<string, Buffer> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'quality-probes-'));
  await writeFile(join(root, 'index.html'), html);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
  const server = await serveArtifacts(root, ['index.html', ...Object.keys(files)]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/index.html`);
    await check(page);
  } finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}

test('conversion excludes Facebook, hidden and disabled controls beside a valid Book CTA', async () => {
  await fixture(`<a href="https://facebook.example/">Facebook</a>
    <a hidden href="missing.html">Book hidden</a><a style="visibility:hidden" href="missing.html">Book invisible</a>
    <a style="opacity:0" href="missing.html">Book transparent</a><div style="opacity:0"><a href="missing.html">Book transparent ancestor</a></div>
    <button disabled>Book disabled</button><a aria-disabled="true" href="missing.html">Book disabled link</a>
    <div inert><a href="missing.html">Book inert</a></div><a href="#booking">Book a visit</a><section id="booking">Demo booking</section>`, async page => {
    const result = await conversionProbe(page, selectCases('dental')[0]!.conversion, ['index.html'], []);
    expect(result.matches.map(match => match.label)).toEqual(['Book a visit']);
    expect(result.exists).toBe(true);
    expect(result.resolves).toBe(true);
  });
});

test.each([true, false])('native Tab measures one stop per healthy radio group (checked=%s)', async checked => {
  await fixture(`<button>Before</button>
    <input type="radio" name="a"><input type="radio" name="a" ${checked ? 'checked' : ''}><input type="radio" name="a">
    <input type="radio" name="b"><input type="radio" name="b" ${checked ? 'checked' : ''}>
    <button id="primary">Book</button>`, async page => {
    const result = await keyboardProbe(page, ['html>body:nth-of-type(1)>button:nth-of-type(2)']);
    expect(result.tabStopCount).toBe(4);
    expect(result.trapDetected).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.primaryReachable).toBe(true);
  });
});

test('radio groups do not hide a real Tab trap', async () => {
  await fixture(`<button id="trap">Trap</button><input type="radio" name="a" checked><input type="radio" name="a"><button>After</button>
    <script>window.addEventListener('keydown',e=>{if(e.key==='Tab'&&document.activeElement.id==='trap')e.preventDefault()},true)</script>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.tabStopCount).toBe(3);
    expect(result.trapDetected).toBe(true);
  });
});

test('a trap on the final native stop still blocks leaving the document', async () => {
  await fixture(`<button>Before</button><input type="radio" name="a" checked><input type="radio" name="a"><button id="trap">Trap</button>
    <script>document.getElementById('trap').onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.tabStopCount).toBe(3);
    expect(result.trapDetected).toBe(true);
  });
});

test('unchanged decorative shadow is not visible focus while a new outline is', async () => {
  await fixture(`<style>button{outline:none;box-shadow:0 2px 4px black}#good:focus-visible{outline:3px solid red}</style>
    <button id="bad">Decorative</button><button id="good">Focus</button>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.steps.find(step => step.label === 'Decorative')?.visibleFocus).not.toBe(true);
    expect(result.steps.find(step => step.label === 'Focus')?.visibleFocus).toBe(true);
  });
});

test('DOM insertion does not turn an unchanged shadow into focus paint', async () => {
  await fixture(`<style>button{outline:none;box-shadow:0 2px 4px black}</style><button>Decorative</button>
    <script>document.querySelector('button').onfocus=()=>{document.body.prepend(document.createElement('div'))}</script>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.steps.find(step => step.label === 'Decorative')?.visibleFocus).not.toBe(true);
  });
});

test.each(['shadow', 'frame'])('internal %s tab stops remain explicitly unmeasured', async kind => {
  const content = kind === 'shadow'
    ? `<div id="host"></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button>One</button><button>Two</button>'</script>`
    : `<iframe srcdoc="<button>One</button><button>Two</button>"></iframe>`;
  await fixture(`<button>Before</button>${content}<button>After</button>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.tabStopCountComplete).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.reason).toMatch(/internal tab stops unmeasured/);
  });
});

test('native step limit reports inconclusive trap evidence with a reason', async () => {
  await fixture(`${'<button>Stop</button>'.repeat(CAPTURE_SETTINGS.keyboardStepLimit + 1)}
    <script>document.querySelector('button').onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`, async page => {
    const result = await keyboardProbe(page, []);
    expect(result.tabStopCountComplete).toBe(false);
    expect(result.trapDetected).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.reason).toMatch(/step limit/);
  });
});

test('form observes a delayed blocked POST for the complete bounded window', async () => {
  await fixture(`<form><input name="name" required><button>Send</button></form>
    <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();setTimeout(()=>fetch('/delayed',{method:'POST'}).catch(()=>{}),150)}</script>`, async page => {
    const attempts: Array<{ url: string; method: string; blocked: boolean }> = [];
    await page.route('**/*', async route => {
      attempts.push({ url: route.request().url(), method: route.request().method(), blocked: true });
      await route.abort();
    });
    const [result] = await formProbe(page, attempts);
    expect(result?.exercised).toBe(true);
    expect(result?.requests).toEqual([{ url: new URL('/delayed', page.url()).href, method: 'POST', blocked: true }]);
    expect(result?.settling.complete).toBe(true);
    expect(result?.settling.windowMs).toBe(CAPTURE_SETTINGS.formSettleWindowMs);
    expect(result?.settling.durationMs).toBeGreaterThanOrEqual(CAPTURE_SETTINGS.formSettleWindowMs);
  });
});

test('a valid form whose click is obstructed remains unexercised and incomplete', async () => {
  await fixture(`<form><button>Send</button></form><div style="position:fixed;inset:0;z-index:10">Overlay</div>`, async page => {
    const [result] = await formProbe(page, []);
    expect(result?.exercised).toBe(false);
    expect(result?.settling.complete).toBe(false);
    expect(result?.reason).toMatch(/Timeout/);
  });
});

test('loaded regular text remains available beside unused unloaded bold and italic faces', async () => {
  const font = await readFile(new URL('../../../apps/web/public/fonts/IBMPlexMono-400-latin.woff2', import.meta.url));
  await fixture(`<style>
    @font-face{font-family:Local;src:url(regular.woff2);font-weight:400;font-style:normal}
    @font-face{font-family:Local;src:url(unused-bold.woff2);font-weight:700;font-style:normal}
    @font-face{font-family:Local;src:url(unused-italic.woff2);font-weight:400;font-style:italic}
    p{font-family:Local;font-weight:400;font-style:normal}</style><p>Regular loaded text</p>`, async page => {
    await page.evaluate(() => document.fonts.ready);
    const result = await resourceProbe(page, []);
    expect(result.fontFaces.filter(face => face.status === 'unloaded')).toHaveLength(2);
    expect(result.fontFaces.find(face => face.weight === '400' && face.style === 'normal')?.status).toBe('loaded');
    expect(result.requestedFonts).toEqual([{ family: 'Local', weight: '400', style: 'normal', available: true }]);
  }, { 'regular.woff2': font });
});

test('a requested font face that fails to load is unavailable', async () => {
  await fixture(`<style>@font-face{font-family:Missing;src:url(missing.woff2);font-weight:700;font-style:italic}
    p{font-family:Missing;font-weight:700;font-style:italic}</style><p>Requested failed face</p>`, async page => {
    await page.evaluate(() => document.fonts.ready);
    const result = await resourceProbe(page, []);
    expect(result.fontFaces[0]?.status).toBe('error');
    expect(result.requestedFonts).toEqual([{ family: 'Missing', weight: '700', style: 'italic', available: false }]);
  });
});
