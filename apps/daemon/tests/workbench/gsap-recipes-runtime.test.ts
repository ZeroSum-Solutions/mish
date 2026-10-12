import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM, requestInterceptor } from 'jsdom';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRecipeScroll } from './gsap-browser-fixture.js';
import { GSAP_RECIPES, GSAP_RECIPE_IDS, createGsapRecipeMaterials, type GsapRecipeId } from '../../src/workbench/recipes/gsap/index.js';
import { MARKETING_RECIPE_IDS } from '../../src/workbench/recipes/gsap/marketing.js';

/**
 * AC-R08.5 runtime receipts for the registered GSAP recipes, run
 * against the pinned workspace packages (react 18.3.1, react-dom 18.3.1,
 * gsap 3.15.0, @gsap/react 2.1.2) with no network install:
 * - G02 / react-source/v1: the editable TSX unit compiles with the pinned
 *   React build (esbuild), mounts under Strict Mode's double effect pass
 *   without doubling animations, cleans up every tween, trigger and inline
 *   style on unmount, and renders on the server (SSR) without touching window.
 * - Reduced motion: a reduce preference at mount gives the static state; a
 *   live change while mounted reverts running motion and back.
 * - Actions stay usable before and during animation.
 * - html-artifact/v1: the exported HTML unit runs from its local runtime files.
 */
const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const nodeModules = join(daemonRoot, 'node_modules');
/** The daemon test project has no DOM lib; jsdom objects are typed structurally here. */
type Doc = any;
const roots: string[] = [];
const doms: any[] = [];
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const materials = createGsapRecipeMaterials();
const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));

interface MediaControl { setReduce(value: boolean): Promise<void>; setFine(value: boolean): Promise<void>; setDesktop(value: boolean): Promise<void> }
/** jsdom has no matchMedia; this one answers the reduced-motion queries and fires change listeners like a browser. */
function installMatchMedia(window: any, initiallyReduced: boolean, options: { fine?: boolean; desktop?: boolean } = {}): MediaControl {
  installRecipeScroll(window);
  let reduce = initiallyReduced;
  let fine = options.fine ?? true;
  let desktop = options.desktop ?? true;
  const lists: { media: string; listeners: Set<(event: unknown) => void> }[] = [];
  const matches = (query: string) => /prefers-reduced-motion:\s*reduce/u.test(query) ? reduce : /prefers-reduced-motion:\s*no-preference/u.test(query) ? !reduce
    : query.includes('pointer: fine') ? fine : query.includes('min-width: 768px') ? desktop : true;
  window.matchMedia = (media: string) => {
    const list = {
      media, listeners: new Set<(event: unknown) => void>(), onchange: null,
      get matches() { return matches(media); },
      addListener(fn: (event: unknown) => void) { list.listeners.add(fn); }, removeListener(fn: (event: unknown) => void) { list.listeners.delete(fn); },
      addEventListener(_type: string, fn: (event: unknown) => void) { list.listeners.add(fn); }, removeEventListener(_type: string, fn: (event: unknown) => void) { list.listeners.delete(fn); },
      dispatchEvent: () => true,
    };
    lists.push(list);
    return list;
  };
  const change = async (update: () => void) => {
    await tick(); // GSAP coalesces media changes closer than 2 ms
    update();
    for (const list of [...lists]) for (const fn of [...list.listeners]) fn({ matches: matches(list.media), media: list.media });
    await tick();
  };
  return {
    setReduce: value => change(() => { reduce = value; }),
    setFine: value => change(() => { fine = value; }),
    setDesktop: value => change(() => { desktop = value; }),
  };
}

async function materialFiles(itemId: string, dir: string) {
  const material = (await materials.materialize(itemId))!;
  for (const file of material.files) writeFileSync(join(dir, file.path), file.bytes);
  return material;
}

/** Compiles the unit as the target project would: TSX through esbuild against the pinned packages. */
async function compileReact(id: GsapRecipeId, entry: string, platform: 'browser' | 'node') {
  const dir = mkdtempSync(join(tmpdir(), 'gsap-react-unit-')); roots.push(dir);
  const material = await materialFiles(`${id}-react`, dir);
  const unitFile = material.files.find(file => file.path.endsWith('.tsx'))!.path;
  const result = await build({
    stdin: { contents: entry.replace('__UNIT__', `./${unitFile.replace(/\.tsx$/u, '')}`), resolveDir: dir, loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true, write: false, platform, format: platform === 'node' ? 'cjs' : 'iife', jsx: 'automatic', nodePaths: [nodeModules],
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent', target: 'es2022',
  });
  return result.outputFiles[0]!.text;
}

const BROWSER_HARNESS = `
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Unit from '__UNIT__';
(window as any).__od = {
  gsap, ScrollTrigger,
  mount(container: HTMLElement, strict: boolean) {
    const root = createRoot(container);
    flushSync(() => root.render(strict ? createElement(StrictMode, null, createElement(Unit)) : createElement(Unit)));
    return { unmount: () => flushSync(() => root.unmount()) };
  },
};
`;
const SERVER_HARNESS = `
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import Unit from '__UNIT__';
module.exports = () => renderToString(createElement(Unit));
`;

async function reactDom(id: GsapRecipeId, reduced: boolean, options: { fine?: boolean; desktop?: boolean } = {}) {
  const code = await compileReact(id, BROWSER_HARNESS, 'browser');
  const dom = new JSDOM('<!doctype html><html><body><div id="a"></div><div id="b"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  doms.push(dom);
  const media = installMatchMedia(dom.window, reduced, options);
  dom.window.eval(code);
  const od = (dom.window as any).__od;
  return { dom, od, media, document: dom.window.document as Doc };
}
/** Unfinished tweens that animate DOM elements. Plugin bookkeeping (ScrollTrigger's own delayed calls target functions) is not recipe motion. */
const activeTweens = (gsap: any) => gsap.globalTimeline.getChildren(true, true, false)
  .filter((tween: any) => (tween.isActive() || tween.progress() < 1) && tween.targets().some((target: any) => target?.nodeType === 1)).length;
const styled = (root: Doc): unknown[] => [...root.querySelectorAll('[data-od-animate]')].filter((element: any) => (element.getAttribute('style') ?? '').trim() !== '');
const finishMotion = (gsap: any) => gsap.globalTimeline.getChildren(true, true, false)
  .filter((tween: any) => !tween.paused() && tween.targets().some((target: any) => target?.nodeType === 1)).forEach((tween: any) => tween.progress(1));
/** Synthetic coordinates exercise pointer behavior; they do not establish browser layout. */
function movePointer(window: any, target: any, pointerType = 'mouse') {
  target.getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 100 });
  const event = new window.MouseEvent('pointermove', { clientX: 260, clientY: 180, bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

function checkPointerRecipe(window: any, document: Doc, gsap: any, id: GsapRecipeId) {
  const target = document.querySelector(id === 'magnetic-button' ? '[data-od-action]' : id === 'hover-tilt' ? '.od-tilt-hit' : '.od-cursor-zone');
  const animated = document.querySelector('[data-od-animate]');
  movePointer(window, target, 'touch');
  finishMotion(gsap);
  expect(Number(gsap.getProperty(animated, id === 'hover-tilt' ? 'rotationY' : 'x'))).toBe(0);
  movePointer(window, target);
  finishMotion(gsap);
  if (id === 'magnetic-button') {
    expect(Number(gsap.getProperty(animated, 'x'))).toBeCloseTo(8);
    expect(Number(gsap.getProperty(animated, 'y'))).toBeCloseTo(8);
    expect(target.style.transform).toBe('');
    target.focus();
    finishMotion(gsap);
    expect(Number(gsap.getProperty(animated, 'x'))).toBe(0);
    movePointer(window, target);
    finishMotion(gsap);
    expect(Number(gsap.getProperty(animated, 'x'))).toBe(0);
  } else if (id === 'hover-tilt') {
    expect(Number(gsap.getProperty(animated, 'rotationX'))).toBeCloseTo(-5);
    expect(Number(gsap.getProperty(animated, 'rotationY'))).toBeCloseTo(5);
  } else {
    expect(Number(gsap.getProperty(animated, 'x'))).toBeCloseTo(228);
    expect(Number(gsap.getProperty(animated, 'opacity'))).toBe(1);
    expect(target.style.cursor).toBe('');
  }
  target.dispatchEvent(new window.Event('pointerleave'));
  finishMotion(gsap);
  expect(Number(gsap.getProperty(animated, id === 'cursor-follower' ? 'opacity' : id === 'hover-tilt' ? 'rotationY' : 'x'))).toBe(0);
}

function checkMarquee(window: any, document: Doc, gsap: any) {
  const scope = document.querySelector('[data-od-gsap="logo-marquee"]');
  const button = scope.querySelector('[data-od-action="pause"]');
  const loop = gsap.getTweensOf(scope.querySelector('.od-loop-track')).find((tween: any) => tween.vars.repeat === -1);
  expect(loop).toBeTruthy();
  expect(loop.paused()).toBe(false);
  scope.dispatchEvent(new window.Event('pointerenter'));
  expect(loop.paused()).toBe(true);
  scope.dispatchEvent(new window.Event('pointerleave'));
  expect(loop.paused()).toBe(false);
  button.click();
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.textContent).toBe('Resume logos');
  expect(loop.paused()).toBe(true);
  scope.dispatchEvent(new window.Event('pointerleave'));
  expect(loop.paused()).toBe(true); // Explicit pause wins over hover exit.
  button.click();
  expect(loop.paused()).toBe(false);
  button.focus();
  expect(loop.paused()).toBe(true);
  button.blur();
  expect(loop.paused()).toBe(false);
}

function checkCrossfade(window: any, document: Doc, gsap: any) {
  const link = document.querySelector('[data-od-action]');
  const image = document.querySelector('[data-od-alt]');
  link.dispatchEvent(new window.Event('pointerenter'));
  finishMotion(gsap);
  expect(Number(gsap.getProperty(image, 'opacity'))).toBe(1);
  link.focus();
  link.dispatchEvent(new window.Event('pointerleave'));
  finishMotion(gsap);
  expect(Number(gsap.getProperty(image, 'opacity'))).toBe(1); // Focus holds the alternate.
  link.blur();
  finishMotion(gsap);
  expect(Number(gsap.getProperty(image, 'opacity'))).toBe(0);
  expect(link.style.transform).toBe('');
}

describe('G02 react-source/v1: pinned React build of the editable TSX units', () => {
  it.each(GSAP_RECIPE_IDS)('%s compiles with react 18.3.1, gsap 3.15.0 and @gsap/react 2.1.2 and renders on the server without window', async id => {
    const code = await compileReact(id, SERVER_HARNESS, 'node');
    const module = { exports: {} as unknown };
    const require = createRequire(join(daemonRoot, 'package.json'));
    new Function('module', 'exports', 'require', code)(module, module.exports, require);
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const html = (module.exports as () => string)();
    expect(html).toContain('data-od-gsap');
    // Static content and actions are present in the server HTML, before any animation runs.
    expect(html).toMatch(/data-od-action/u);
    expect(html).not.toMatch(/style="[^"]*(opacity:\s*0|visibility:\s*hidden)/u);
  });
});

describe('AC-R08.5 React lifecycle: Strict Mode, scoped cleanup, reduced motion', () => {
  it.each(['magnetic-button', 'cursor-follower', 'hover-tilt'] as const)('%s responds within its bounds, ignores touch and removes event-driven motion live', async id => {
    const page = await reactDom(id, false);
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    checkPointerRecipe(page.dom.window, page.document, page.od.gsap, id);
    await page.media.setReduce(true);
    const target = page.document.querySelector(id === 'magnetic-button' ? '[data-od-action]' : id === 'hover-tilt' ? '.od-tilt-hit' : '.od-cursor-zone');
    movePointer(page.dom.window, target);
    expect(activeTweens(page.od.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
    mounted.unmount();
  });

  it.each(['magnetic-button', 'cursor-follower', 'hover-tilt', 'image-crossfade'] as const)('%s stays static on coarse pointers and cleans up when fine-pointer capability disappears', async id => {
    const page = await reactDom(id, false, { fine: false });
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    expect(activeTweens(page.od.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
    await page.media.setFine(true);
    expect(activeTweens(page.od.gsap)).toBeGreaterThan(0);
    await page.media.setFine(false);
    expect(activeTweens(page.od.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
    mounted.unmount();
  });

  it.each(['sticky-story', 'section-pin'] as const)('%s pins only in eligible viewports and removes spacers and transforms on live viewport change', async id => {
    const page = await reactDom(id, false, { desktop: false });
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    expect(page.od.ScrollTrigger.getAll()).toHaveLength(0);
    expect(styled(page.document)).toEqual([]);
    await page.media.setDesktop(true);
    expect(page.od.ScrollTrigger.getAll()).toHaveLength(1);
    expect(page.document.querySelectorAll('.pin-spacer')).toHaveLength(1);
    await page.media.setDesktop(false);
    expect(page.od.ScrollTrigger.getAll()).toHaveLength(0);
    expect(page.document.querySelectorAll('.pin-spacer')).toHaveLength(0);
    expect(styled(page.document)).toEqual([]);
    mounted.unmount();
  });

  it('logo-marquee has explicit and temporary pause controls and preserves the chosen pause through a preference cycle', async () => {
    const page = await reactDom('logo-marquee', false);
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    checkMarquee(page.dom.window, page.document, page.od.gsap);
    page.document.querySelector('[data-od-action="pause"]').click();
    await page.media.setReduce(true);
    expect(activeTweens(page.od.gsap)).toBe(0);
    await page.media.setReduce(false);
    const loop = page.od.gsap.getTweensOf(page.document.querySelector('.od-loop-track')).find((tween: any) => tween.vars.repeat === -1);
    expect(loop.paused()).toBe(true);
    mounted.unmount();
  });

  it('image-crossfade holds the alternate for keyboard focus and uses its static primary after live reduction', async () => {
    const page = await reactDom('image-crossfade', false);
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    checkCrossfade(page.dom.window, page.document, page.od.gsap);
    await page.media.setReduce(true);
    page.document.querySelector('[data-od-action]').focus();
    expect(activeTweens(page.od.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
    mounted.unmount();
  });

  it('number-counter reaches its authored integer and restores it with stable assistive text on live reduction', async () => {
    const page = await reactDom('number-counter', false);
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    finishMotion(page.od.gsap);
    expect(page.document.querySelector('[data-od-counter]').textContent).toBe('128');
    expect(page.document.querySelector('.od-counter-sr').textContent).toBe('128');
    await page.media.setReduce(true);
    expect(page.document.querySelector('[data-od-counter]').textContent).toBe('128');
    mounted.unmount();
  });

  it('image-mask React source supplies a sized artwork placeholder before any motion', async () => {
    const page = await reactDom('image-mask', true);
    const mounted = page.od.mount(page.document.getElementById('a'), true);
    expect(page.dom.window.getComputedStyle(page.document.querySelector('[data-od-art]')).minHeight).toBe('18rem');
    mounted.unmount();
  });

  it.each(GSAP_RECIPE_IDS)('%s: Strict Mode double-mount creates no duplicate animation and unmount leaves no tween, trigger or inline style', async id => {
    const { od, document } = await reactDom(id, false);
    const plain = od.mount(document.getElementById('a'), false);
    const plainTweens = activeTweens(od.gsap);
    const plainTriggers = od.ScrollTrigger.getAll().length;
    plain.unmount();
    expect(activeTweens(od.gsap)).toBe(0);
    expect(od.ScrollTrigger.getAll()).toHaveLength(0);

    const strict = od.mount(document.getElementById('b'), true);
    expect(activeTweens(od.gsap)).toBe(plainTweens);
    expect(od.ScrollTrigger.getAll()).toHaveLength(plainTriggers);
    if (id === 'scroll-story') expect(plainTriggers).toBeGreaterThan(0);
    if (id === 'section-entrance' || id === 'scroll-story') expect(plainTweens).toBeGreaterThan(0);
    const animated: any[] = [...document.querySelectorAll('#b [data-od-animate]')];
    // Actions are usable while the entrance runs: never hidden, disabled or click-blocked by the animation.
    for (const action of document.querySelectorAll('#b [data-od-action]') as any[]) {
      expect(action.hasAttribute('disabled')).toBe(false);
      expect(action.style.opacity === '' || Number(action.style.opacity) === 1).toBe(true);
      expect(action.style.visibility).not.toBe('hidden');
      expect(action.style.pointerEvents).not.toBe('none');
    }
    strict.unmount();
    expect(activeTweens(od.gsap)).toBe(0);
    expect(od.ScrollTrigger.getAll()).toHaveLength(0);
    expect(animated.filter(element => (element.getAttribute('style') ?? '').trim() !== '')).toEqual([]);
  });

  it.each(GSAP_RECIPE_IDS)('%s: a reduce preference at mount gives the static state, and a live change reverts and restores motion', async id => {
    const reduced = await reactDom(id, true);
    const unit = reduced.od.mount(reduced.document.getElementById('a'), true);
    expect(activeTweens(reduced.od.gsap)).toBe(0);
    expect(reduced.od.ScrollTrigger.getAll()).toHaveLength(0);
    expect(styled(reduced.document)).toEqual([]);
    expect(reduced.document.querySelector('[data-od-action]')).not.toBeNull();
    unit.unmount();

    const live = await reactDom(id, false);
    const mounted = live.od.mount(live.document.getElementById('a'), true);
    const moving = activeTweens(live.od.gsap);
    await live.media.setReduce(true);
    expect(activeTweens(live.od.gsap)).toBe(0);
    expect(live.od.ScrollTrigger.getAll()).toHaveLength(0);
    expect(styled(live.document)).toEqual([]);
    await live.media.setReduce(false);
    expect(activeTweens(live.od.gsap)).toBe(moving);
    mounted.unmount();
    // After unmount a preference change must not resurrect animation for a gone component.
    await live.media.setReduce(true);
    await live.media.setReduce(false);
    expect(activeTweens(live.od.gsap)).toBe(0);
  });

  it('flip-filter and svg-feedback actions work during motion and under reduced motion (contextSafe handlers)', async () => {
    for (const reduce of [false, true]) {
      const flip = await reactDom('flip-filter', reduce);
      const unit = flip.od.mount(flip.document.getElementById('a'), true);
      const items = () => [...flip.document.querySelectorAll('[data-od-item]')].filter((item: any) => !item.hidden).map((item: any) => item.dataset.odItem);
      const all = items();
      const filter = flip.document.querySelector('[data-od-action="filter"][data-od-filter="implant"]')!;
      filter.click();
      expect(items().length).toBeLessThan(all.length);
      expect(filter.getAttribute('aria-pressed')).toBe('true');
      expect(activeTweens(flip.od.gsap) > 0).toBe(!reduce);
      unit.unmount();
      expect(activeTweens(flip.od.gsap)).toBe(0);

      const svg = await reactDom('svg-feedback', reduce);
      const feedback = svg.od.mount(svg.document.getElementById('a'), true);
      svg.document.querySelector('[data-od-action="save"]')!.click();
      // Confirmation is stated in text, not colour alone.
      expect(svg.document.querySelector('[role="status"]')!.textContent).toMatch(/saved/iu);
      expect(activeTweens(svg.od.gsap) > 0).toBe(!reduce);
      feedback.unmount();
      expect(activeTweens(svg.od.gsap)).toBe(0);
    }
  });

  it('W6 svg-feedback shows no check before a save; after a save it shows the check (static under reduced motion)', async () => {
    for (const reduce of [false, true]) {
      const svg = await reactDom('svg-feedback', reduce);
      const unit = svg.od.mount(svg.document.getElementById('a'), true);
      const icon = () => svg.document.querySelector('svg')!;
      expect(icon().hasAttribute('hidden')).toBe(true);
      svg.document.querySelector('[data-od-action="save"]')!.click();
      expect(icon().hasAttribute('hidden')).toBe(false);
      expect(activeTweens(svg.od.gsap) > 0).toBe(!reduce);
      unit.unmount();
    }
  });

  it('switching to reduced motion while mounted, then acting, creates no tween', async () => {
    const flip = await reactDom('flip-filter', false);
    const unit = flip.od.mount(flip.document.getElementById('a'), true);
    await flip.media.setReduce(true);
    flip.document.querySelector('[data-od-action="filter"][data-od-filter="cleaning"]')!.click();
    expect(activeTweens(flip.od.gsap)).toBe(0);
    unit.unmount();
    const svg = await reactDom('svg-feedback', false);
    const feedback = svg.od.mount(svg.document.getElementById('a'), true);
    await svg.media.setReduce(true);
    svg.document.querySelector('[data-od-action="save"]')!.click();
    expect(activeTweens(svg.od.gsap)).toBe(0);
    expect(svg.document.querySelector('svg')!.hasAttribute('hidden')).toBe(false);
    feedback.unmount();
  });
});

describe('AC-R08.5 html-artifact/v1: the exported unit runs from its local runtime files', () => {
  async function htmlDom(id: GsapRecipeId, reduced: boolean, options: { fine?: boolean; desktop?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'gsap-html-unit-')); roots.push(dir);
    const material = await materialFiles(`${id}-html`, dir);
    const page = material.files.find(file => file.path.endsWith('.html'))!.path;
    const requested: string[] = [];
    let media: MediaControl | null = null;
    const dom = await JSDOM.fromFile(join(dir, page), {
      runScripts: 'dangerously', pretendToBeVisual: true,
      // Any non-file request is recorded and refused: the unit must not depend on the network.
      resources: { interceptors: [requestInterceptor((request: Request) => { if (!request.url.startsWith('file:')) { requested.push(request.url); return new Response('', { status: 451 }); } return undefined; })] },
      beforeParse(window: any) { media = installMatchMedia(window, reduced, options); },
    });
    doms.push(dom);
    await new Promise<void>(done => dom.window.document.readyState === 'complete' ? done() : dom.window.addEventListener('load', () => done()));
    return { dom, window: dom.window as any, document: dom.window.document as Doc, media: media!, requested };
  }

  const pageEvent = (window: any, type: 'pagehide' | 'pageshow', persisted: boolean) => {
    const event = new window.Event(type);
    Object.defineProperty(event, 'persisted', { value: persisted });
    window.dispatchEvent(event);
  };

  it.each(['magnetic-button', 'cursor-follower', 'hover-tilt'] as const)('%s HTML pointer behavior matches React and its listeners stop at explicit teardown', async id => {
    const page = await htmlDom(id, false);
    checkPointerRecipe(page.window, page.document, page.window.gsap, id);
    const target = page.document.querySelector(id === 'magnetic-button' ? '[data-od-action]' : id === 'hover-tilt' ? '.od-tilt-hit' : '.od-cursor-zone');
    page.window.odGsapRecipes[id].revert();
    movePointer(page.window, target);
    expect(activeTweens(page.window.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
  });

  it.each(['sticky-story', 'section-pin'] as const)('%s HTML pin lifecycle removes spacers on pagehide and keeps the small-viewport fallback', async id => {
    const page = await htmlDom(id, false);
    expect(page.window.ScrollTrigger.getAll()).toHaveLength(1);
    pageEvent(page.window, 'pagehide', false);
    expect(page.window.ScrollTrigger.getAll()).toHaveLength(0);
    expect(page.document.querySelectorAll('.pin-spacer')).toHaveLength(0);
    expect(styled(page.document)).toEqual([]);
    pageEvent(page.window, 'pageshow', true);
    expect(page.window.ScrollTrigger.getAll()).toHaveLength(1);
    await page.media.setDesktop(false);
    expect(page.window.ScrollTrigger.getAll()).toHaveLength(0);
    expect(page.document.querySelectorAll('.pin-spacer')).toHaveLength(0);
    expect(styled(page.document)).toEqual([]);
  });

  it('HTML marquee pause and crossfade focus behaviors match React', async () => {
    const marquee = await htmlDom('logo-marquee', false);
    checkMarquee(marquee.window, marquee.document, marquee.window.gsap);
    const crossfade = await htmlDom('image-crossfade', false);
    checkCrossfade(crossfade.window, crossfade.document, crossfade.window.gsap);
  });

  it.each(MARKETING_RECIPE_IDS)('%s keeps readable content and native links when GSAP is unavailable', id => {
    const recipe = GSAP_RECIPES[id];
    const dom = new JSDOM(`<html><head><style>${recipe.html.css}</style></head><body>${recipe.html.markup}</body></html>`, { runScripts: 'outside-only' });
    doms.push(dom);
    dom.window.eval(recipe.html.script);
    expect(dom.window.odGsapRecipes[id]).toBeTruthy();
    expect(dom.window.document.querySelector('h2').textContent.trim().length).toBeGreaterThan(0);
    for (const link of dom.window.document.querySelectorAll('a[data-od-action]')) expect(link.getAttribute('href')).toMatch(/^#/u);
    expect(styled(dom.window.document)).toEqual([]);
    if (id === 'number-counter') expect(dom.window.document.querySelector('[data-od-counter]').textContent).toBe('128');
    if (id === 'image-mask') expect(dom.window.getComputedStyle(dom.window.document.querySelector('[data-od-art]')).minHeight).toBe('18rem');
    dom.window.odGsapRecipes[id].revert();
  });

  it('W3 a back/forward-cache pagehide keeps motion and actions; a pageshow after a real pagehide re-inits motion; actions never drop', async () => {
    const entrance = await htmlDom('section-entrance', false);
    const before = activeTweens(entrance.window.gsap);
    expect(before).toBeGreaterThan(0);
    pageEvent(entrance.window, 'pagehide', true);
    expect(activeTweens(entrance.window.gsap)).toBe(before);
    pageEvent(entrance.window, 'pagehide', false);
    expect(activeTweens(entrance.window.gsap)).toBe(0);
    expect(styled(entrance.document)).toEqual([]);
    pageEvent(entrance.window, 'pageshow', true);
    expect(activeTweens(entrance.window.gsap)).toBe(before);

    const flip = await htmlDom('flip-filter', false);
    for (const persisted of [true, false]) {
      pageEvent(flip.window, 'pagehide', persisted);
      pageEvent(flip.window, 'pageshow', true);
      const kind = persisted ? 'implant' : 'cleaning';
      flip.document.querySelector(`[data-od-filter="${kind}"]`).click();
      const visible = [...flip.document.querySelectorAll('[data-od-item]')].filter((item: any) => !item.hidden).map((item: any) => item.getAttribute('data-od-kind'));
      expect(new Set(visible)).toEqual(new Set([kind]));
    }
  });

  it('W6 and reduced-then-click: the HTML save shows the check only after saving, and no tween once reduced motion is on', async () => {
    const svg = await htmlDom('svg-feedback', false);
    const icon = svg.document.querySelector('svg');
    expect(icon.hasAttribute('hidden')).toBe(true);
    await svg.media.setReduce(true);
    svg.document.querySelector('[data-od-action="save"]').click();
    expect(icon.hasAttribute('hidden')).toBe(false);
    expect(svg.document.querySelector('[role="status"]').textContent).toMatch(/saved/iu);
    expect(activeTweens(svg.window.gsap)).toBe(0);
    const flip = await htmlDom('flip-filter', false);
    await flip.media.setReduce(true);
    flip.document.querySelector('[data-od-filter="implant"]').click();
    expect(activeTweens(flip.window.gsap)).toBe(0);
  });

  it('the marquee without GSAP shows one wrapping logo group and no inactive pause control', () => {
    const recipe = GSAP_RECIPES['logo-marquee'];
    const dom = new JSDOM(`<style>${recipe.html.css}</style>${recipe.html.markup}`, { runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.eval(recipe.html.script);
    const style = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!);
    expect(style('[aria-hidden="true"]').display).toBe('none');
    expect(style('[data-od-action="pause"]').display).toBe('none');
    expect(style('[data-od-logos]').flexWrap).toBe('wrap');
    expect(dom.window.document.querySelector('.od-loop-active')).toBeNull();
    dom.window.close();
  });

  it('without the runtime the static unit still works: filters filter and save confirms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsap-html-noruntime-')); roots.push(dir);
    for (const id of ['flip-filter', 'svg-feedback'] as const) {
      const material = await materialFiles(`${id}-html`, dir);
      for (const file of material.files.filter(entry => entry.path.endsWith('.min.js'))) rmSync(join(dir, file.path));
      const dom = await JSDOM.fromFile(join(dir, `gsap-${id}.html`), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, beforeParse(window: any) { installMatchMedia(window, false); } });
      doms.push(dom);
      await new Promise<void>(done => dom.window.document.readyState === 'complete' ? done() : dom.window.addEventListener('load', () => done()));
      const document: Doc = dom.window.document;
      if (id === 'flip-filter') {
        document.querySelector('[data-od-filter="implant"]').click();
        expect([...document.querySelectorAll('[data-od-item]')].filter((item: any) => !item.hidden)).toHaveLength(2);
      } else {
        document.querySelector('[data-od-action="save"]').click();
        expect(document.querySelector('[role="status"]').textContent).toMatch(/saved/iu);
        expect(document.querySelector('svg').hasAttribute('hidden')).toBe(false);
      }
    }
  });

  it.each(GSAP_RECIPE_IDS)('%s loads only file:// local assets, animates, honours reduced motion live, and reverts on teardown', async id => {
    const page = await htmlDom(id, false);
    expect(page.requested).toEqual([]);
    expect(page.window.gsap?.version).toBe('3.15.0');
    const recipe = page.window.odGsapRecipes?.[id];
    expect(recipe).toBeTruthy();
    if (id === 'section-entrance' || id === 'scroll-story') expect(activeTweens(page.window.gsap)).toBeGreaterThan(0);
    await page.media.setReduce(true);
    expect(activeTweens(page.window.gsap)).toBe(0);
    expect(styled(page.document)).toEqual([]);
    await page.media.setReduce(false);
    recipe.revert();
    expect(activeTweens(page.window.gsap)).toBe(0);
    expect(page.window.ScrollTrigger?.getAll?.() ?? []).toHaveLength(0);
    expect(styled(page.document)).toEqual([]);

    const reduced = await htmlDom(id, true);
    expect(activeTweens(reduced.window.gsap)).toBe(0);
    expect(styled(reduced.document)).toEqual([]);
    expect(reduced.document.querySelector('[data-od-action]')).not.toBeNull();
  });
});
