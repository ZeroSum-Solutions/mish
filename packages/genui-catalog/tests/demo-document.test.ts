// The demo documents the catalog view runs in its sandboxed iframes, executed in jsdom rather than
// checked as strings: dist/data.js is what the web view imports (built by `pnpm build`, which the
// workspace postinstall also runs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- jsdom ships no type declarations and @types/jsdom is not a dependency.
import { JSDOM as JSDOMCtor, VirtualConsole as VirtualConsoleCtor } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { FORCED_REDUCED_MOTION_CLASS, forcedReducedMotionCss, splitSelectors } from '../scripts/reduced-motion-css.ts';
import { DEMO_CSP, demoDocument, genuiCatalog } from '../dist/data.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
/** The slice of jsdom's API these tests use. */
interface JSDOM { window: Window & typeof globalThis }
const JSDOM = JSDOMCtor as new (html: string, options: Record<string, unknown>) => JSDOM;
const VirtualConsole = VirtualConsoleCtor as new () => { on(event: 'jsdomError', listener: (error: Error) => void): void };
type Assets = Record<string, { js: string; css: string; reducedCss: string; demo: string }>;
const assets = genuiCatalog.assets as unknown as Assets;
const ported = Object.keys(assets).sort();

/** Run a demo document with its inline scripts, as the iframe would. */
async function run(id: string, reducedMotion = false): Promise<JSDOM> {
  const html = demoDocument(id, { reducedMotion }) as string;
  const virtualConsole = new VirtualConsole();
  const errors: unknown[] = [];
  virtualConsole.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error.message))) errors.push(error); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
  // The auto-mount script waits for DOMContentLoaded, which jsdom fires after parsing.
  if (dom.window.document.readyState !== 'complete') await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  expect(errors, `${id} ran its scripts without an error`).toEqual([]);
  return dom;
}

describe('demo fragments', () => {
  it('every ported demo.html is a body fragment with no document, script or style markup', () => {
    expect(ported.length).toBeGreaterThanOrEqual(22);
    for (const id of ported) {
      const source = readFileSync(path.join(packageRoot, 'components', id, 'demo.html'), 'utf8');
      expect(source, id).not.toMatch(/<!doctype|<\/?(html|head|body|script|style)\b/i);
      expect(assets[id]!.demo, id).toBe(source);
    }
  });

  it('scroll-locked-video-hero previews through the built component, in one document', async () => {
    const dom = await run('scroll-locked-video-hero');
    const { document } = dom.window;
    expect(document.querySelectorAll('html')).toHaveLength(1);
    expect(document.querySelectorAll('script')).toHaveLength(1);
    const hosts = document.querySelectorAll('[data-genui="scroll-locked-video-hero"]');
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(host.hasAttribute('data-genui-mounted')).toBe(true);
    expect(host.classList.contains('genui-scroll-locked-video-hero')).toBe(true);
    expect(host.querySelector('.genui-scroll-locked-video-hero__stage')).not.toBeNull();
    expect(host.querySelector('canvas.genui-scroll-locked-video-hero__canvas')).not.toBeNull();
    expect(host.style.height).toBe('260vh');
    dom.window.close();
  });
});

describe('reduced-motion preview', () => {
  it('the executed shim answers the reduced-motion query and marks <html>', async () => {
    const dom = await run('shiny-text', true);
    const { window } = dom;
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    expect(window.matchMedia('(prefers-reduced-motion:reduce)').matches).toBe(true);
    expect(window.matchMedia('(min-width: 1px)').matches).toBe(false);
    expect(window.document.documentElement.classList.contains(FORCED_REDUCED_MOTION_CLASS)).toBe(true);
    // The component script saw reduced motion at mount.
    expect(window.document.querySelector('.genui-shiny-text')!.classList.contains('genui-shiny-text--reduced')).toBe(true);
    dom.window.close();
  });

  it('without the toggle, nothing is forced', async () => {
    const dom = await run('shiny-text', false);
    expect(dom.window.document.documentElement.classList.contains(FORCED_REDUCED_MOTION_CLASS)).toBe(false);
    expect(dom.window.document.querySelector('style[data-genui-forced-reduced-motion]')).toBeNull();
    expect(dom.window.document.querySelector('.genui-shiny-text')!.classList.contains('genui-shiny-text--reduced')).toBe(false);
    dom.window.close();
  });

  it('applies the component\'s own reduced-motion CSS under the forced class', async () => {
    for (const id of ported) {
      if (!/prefers-reduced-motion/.test(assets[id]!.css)) continue;
      expect(assets[id]!.reducedCss, id).not.toBe('');
    }
    const dom = await run('glare-hover', true);
    const { document } = dom.window;
    const forced = document.querySelector('style[data-genui-forced-reduced-motion]')!.textContent!;
    expect(forced).toBe(assets['glare-hover']!.reducedCss);
    expect(forced.startsWith(`.${FORCED_REDUCED_MOTION_CLASS} .genui-glare-hover`)).toBe(true);
    // The forced rules key on the host the built component mounted.
    const host = document.querySelector('[data-genui="glare-hover"]')!;
    expect(host.matches(`.${FORCED_REDUCED_MOTION_CLASS} .genui-glare-hover`)).toBe(true);
    dom.window.close();
  });

  it('keeps the CSP that blocks every network fetch', () => {
    expect(DEMO_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    expect(demoDocument('shiny-text', { reducedMotion: true })).toContain(DEMO_CSP);
    expect(demoDocument('no-such-component')).toBeNull();
  });
});

describe('forcedReducedMotionCss', () => {
  it('re-keys every rule of each reduce block and leaves other rules out', () => {
    const css = '.a{color:red}@media(prefers-reduced-motion:reduce){.a,.b:is(.c,.d){animation:none}.e{opacity:1}}@media (min-width:1px){.f{x:y}}';
    expect(forcedReducedMotionCss(css)).toBe(
      `.${FORCED_REDUCED_MOTION_CLASS} .a,.${FORCED_REDUCED_MOTION_CLASS} .b:is(.c,.d){animation:none}.${FORCED_REDUCED_MOTION_CLASS} .e{opacity:1}`,
    );
    expect(forcedReducedMotionCss('.a{b:c}')).toBe('');
  });

  it('splits selector lists only on top-level commas', () => {
    expect(splitSelectors('.a, .b:where(.c, .d), [data-x=","]')).toEqual(['.a', '.b:where(.c, .d)', '[data-x=","]']);
  });
});
