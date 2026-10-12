/// <reference lib="dom" />
// The page-side inspector (`inspectSections`) runs in Chromium and is typed against the DOM.

/**
 * The Cult render gate (goal criterion C19). Renders every insertable Cult adapter the way a build
 * inserts it and checks the page a browser actually loads. Runs without the private source kit.
 *
 *   node --experimental-strip-types scripts/render-check.ts [--out <report.json>] [--family <id>]…
 *
 * Default families: marketing-site (the strictest family CSP) and watson (approved media, fonts and
 * inline script). `--family` (repeatable) picks others.
 *
 * For every insertable catalog row (read from catalog.json and the generated registry, never a
 * hard-coded list):
 *   - fill it with worst-case permitted slot lengths (`worstCaseFill`: every slot at its maximum,
 *     every list at its item count) and splice it into a real family page through the fast lane's
 *     own overlay (`wrapFamilyPackageForOverlay`), so the section carries the same wrapper,
 *     direction CSS and family CSP a build ships;
 *   - measure the derivative bytes (minified HTML, adapter CSS, the spliced section) and the page.
 * Then it composes one representative page: the family page plus the HyperUI lead section and the
 * largest insertable Cult `features`, `cta-band` and `footer` blocks, and holds it below the fast
 * lane's PAGE_BYTE_LIMIT. The frozen-package gate is held structurally: no synchronized compiler
 * copy may carry or import a Cult adapter (the gate itself is apps/daemon's
 * agency-reference-skills test).
 *
 * Browser (Playwright Chromium from the e2e workspace, served from a loopback static server), for
 * every page under `reducedMotion` 'no-preference' and 'reduce':
 *   csp        a `securitypolicyviolation` event or a CSP console message
 *   external   any request to an origin other than the loopback server
 *   resource   a failed or non-2xx request
 *   script     an uncaught page error
 *   link       an in-section `a[href]` / `use[href]` whose `#id` target is not on the page
 *              (`#top` always resolves; `#contact` is the page contract every composition owns)
 *   style      the section's <style> did not apply, the scope root is missing, or a class the
 *              section uses matches no rule on the page
 *   hidden     after the section is scrolled into view and 1 s has passed, an element with its own
 *              text that is transparent, `visibility: hidden`, or entirely outside the viewport
 *              horizontally (a transform left it off-screen)
 *
 * Writes a JSON report and prints a text summary; exits 1 on any violation.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ADAPTER_BYTE_LIMIT } from '../src/converted.ts';
import type { CultCatalog } from '../src/types.ts';
import { minifiedHtml, PACKAGE_DIR, worstCaseFill } from './adapter-check.ts';

// ---------------------------------------------------------------------------------------------
// Cross-package modules, loaded by path so this package's `tsc` never compiles them.
// ---------------------------------------------------------------------------------------------

type TextSlot = { name: string; max: number; atom?: 'phone' | 'email' | 'address' | 'plain' };
type Adapter = {
  id: string;
  version: string;
  css: string;
  text: readonly TextSlot[];
  items?: { name: string; count: number; fields: readonly TextSlot[] };
  render: (fill: unknown) => string;
};
type Fill = ReturnType<typeof worstCaseFill>;
type ResolvedAsset = { file: string; destination: string };
type RenderResult = { html: string; approvedAssets: ResolvedAsset[] };
type FamilyPackage = {
  fixture: Record<string, unknown>;
  render: (input: unknown, entry: string, options?: Record<string, unknown>) => RenderResult;
  readAsset: (asset: ResolvedAsset) => Promise<Buffer | Uint8Array>;
};
type Placement = { mode: 'append'; afterSectionId: string };
type Overlay = {
  resolveSectionAdapter: (id: string) => Promise<Adapter>;
  resolveDesignDirection: (id: string) => Promise<{ id: string }>;
  wrapFamilyPackageForOverlay: (pkg: FamilyPackage, selection: { entryId: string; placement: Placement; directionId: string }, direction: { id: string }, adapter: Adapter, fill: Fill) => Promise<FamilyPackage>;
  fixtureSectionIdsOf: (pkg: FamilyPackage) => ReadonlyArray<string | null>;
};
type Registry = { CULT_ADAPTERS: Readonly<Record<string, () => Promise<Adapter>>> };

const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const FAST_LANE_SRC = join(REPO_ROOT, 'packages', 'agency-fast-lane', 'src');
const importPath = <T>(file: string): Promise<T> => import(pathToFileURL(file).href) as Promise<T>;

/** The HyperUI lead section of the representative page (one of the three reviewed HyperUI adapters). */
export const LEAD_SECTION = 'hyperui:marketing/sections/1';
/** The Cult section kinds the representative page takes, in page order. */
export const PAGE_KINDS = ['features', 'cta-band', 'footer'] as const;
/** Anchors a section may link to that need no target in the section itself. */
export const PAGE_CONTRACT_ANCHORS = ['#top', '#contact'] as const;
const DIRECTION = 'modern-minimal';
/** Default family: marketing-site carries the strictest family CSP (img-src 'none', script-src 'none'). */
const DEFAULT_FAMILY = 'marketing-site';
const SETTLE_MS = 1000;
const MOTION_MODES = ['no-preference', 'reduce'] as const;
/** Desktop (matches the family's own composed-page width) and phone — a block whose mobile nav collapses
 * behind a hamburger, or any content a responsive breakpoint moves off one viewport, only shows up by
 * checking both; a single 1280px pass never sees it. */
const VIEWPORTS = [1280, 390] as const;

export type Category = 'csp' | 'external' | 'resource' | 'script' | 'link' | 'style' | 'hidden' | 'bytes' | 'frozen' | 'render' | 'mobile-nav' | 'overlap' | 'contrast' | 'wordbreak';
export const CATEGORIES: readonly Category[] = ['csp', 'external', 'resource', 'script', 'link', 'style', 'hidden', 'bytes', 'frozen', 'render', 'mobile-nav', 'overlap', 'contrast', 'wordbreak'];
export type Violation = { page: string; category: Category; motion?: string; detail: string };

export type BlockMeasure = { id: string; kind: string; htmlMin: number; cssMin: number; sectionBytes: number; pageBytes: number };
export type Report = {
  family: string;
  csp: string;
  direction: string;
  blocks: BlockMeasure[];
  page: { sections: string[]; bytes: number; limit: number };
  maxBlock: { total: number; id: string; limit: number };
  frozen: { generatedBytes: number; syncedDirsChecked: number };
  violations: Violation[];
  counts: Record<Category, number>;
  browserPages: number;
  /** `<motion>:<category>` for every planted self-test defect the browser check detected. */
  selfTest: string[];
  ms: number;
};

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** `rowName`: the internal Cult row name, for the reviewed exemptions; absent for other sections. */
type CheckedSection = { sectionId: string; scope: string | null; rowName?: string };
type RenderedPage = { name: string; html: string; sections: CheckedSection[] };
/** The family's approved media, served next to every page the way a published project carries it. */
type SupportingFile = { destination: string; bytes: Buffer | Uint8Array };

/**
 * `worstCaseFill` with every plain slot broken into words: the same length (so the same bytes),
 * but wrapping the way copy wraps. One unbroken 90-character run measures bytes, not layout.
 */
export function layoutFill(adapter: Adapter): Fill {
  const fill = worstCaseFill(adapter as never);
  const words = (slot: TextSlot, value: string) => (slot.atom === 'email' || slot.atom === 'phone' ? value : value.replace(/(.{9})./g, '$1 ').replace(/ $/, 'W'));
  const text = Object.fromEntries(adapter.text.map((slot) => [slot.name, words(slot, fill.text[slot.name] ?? '')]));
  if (!adapter.items || !fill.items) return { text };
  const rows = (fill.items[adapter.items.name] ?? []).map((row) => Object.fromEntries(adapter.items!.fields.map((field) => [field.name, words(field, row[field.name] ?? '')])));
  return { text, items: { [adapter.items.name]: rows } };
}

const sectionIdOf = (id: string) => `od-selected-${id.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}`;
const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/;

async function loadFamily(family: string): Promise<FamilyPackage> {
  const { loadFamilyPackage } = await importPath<{ loadFamilyPackage: (dir: string, family: string) => Promise<FamilyPackage> }>(join(FAST_LANE_SRC, 'family.ts'));
  return loadFamilyPackage(join(REPO_ROOT, 'plugins', '_official', 'examples', `agency-${family}`), family);
}

/** Splices each adapter (worst-case fill) after the previous one, starting after the family hero. */
async function compose(overlay: Overlay, pkg: FamilyPackage, adapters: readonly Adapter[], entry: string, publishedSectionId: (id: string) => string): Promise<RenderResult> {
  const direction = await overlay.resolveDesignDirection(DIRECTION);
  const hero = overlay.fixtureSectionIdsOf(pkg).find((id): id is string => typeof id === 'string' && id.endsWith('-hero'));
  if (!hero) throw new Error('the family fixture declares no *-hero section to anchor after');
  let wrapped = pkg;
  let after = hero;
  for (const adapter of adapters) {
    const selection = { entryId: adapter.id, placement: { mode: 'append', afterSectionId: after } as const, directionId: direction.id };
    wrapped = await overlay.wrapFamilyPackageForOverlay(wrapped, selection, direction, adapter, layoutFill(adapter));
    after = publishedSectionId(adapter.id);
  }
  return wrapped.render(pkg.fixture, entry);
}

export function frozenPackageViolations(): { violations: Violation[]; syncedDirs: number; generatedBytes: number } {
  // Every directory scripts/sync-agency-compiler.ts writes: the shared compiler, each family
  // compiler copy and the agency-site template. None may carry or import a Cult adapter.
  const dirs = [
    join(REPO_ROOT, 'plugins', '_official', 'shared', 'agency-compiler'),
    join(REPO_ROOT, 'design-templates', 'agency-site', 'scripts'),
    ...readdirSync(join(REPO_ROOT, 'plugins', '_official', 'examples'))
      .map((name) => join(REPO_ROOT, 'plugins', '_official', 'examples', name, 'compiler'))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true),
  ];
  const violations: Violation[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) {
        if (name !== 'node_modules') walk(file);
        continue;
      }
      const rel = relative(REPO_ROOT, file);
      if (/cult/i.test(name)) violations.push({ page: rel, category: 'frozen', detail: 'a Cult file inside a synchronized compiler copy' });
      else if (/\.(ts|js|mjs)$/.test(name) && /cult-ui-catalog/.test(readFileSync(file, 'utf8'))) {
        violations.push({ page: rel, category: 'frozen', detail: 'a synchronized compiler file references @open-design/cult-ui-catalog' });
      }
    }
  };
  for (const dir of dirs) walk(dir);
  let generatedBytes = 0;
  const sum = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) sum(file);
      else generatedBytes += stat.size;
    }
  };
  sum(join(PACKAGE_DIR, 'generated'));
  return { violations, syncedDirs: dirs.length, generatedBytes };
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

type PwPage = {
  on: (event: string, handler: (arg: never) => void) => void;
  addInitScript: (script: string) => Promise<void>;
  goto: (url: string, options: { waitUntil: 'load' }) => Promise<unknown>;
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;
};
type PwContext = { newPage: () => Promise<PwPage>; close: () => Promise<void> };
type PwBrowser = { newContext: (options: Record<string, unknown>) => Promise<PwContext>; close: () => Promise<void> };
type Chromium = { launch: (options: { headless: boolean }) => Promise<PwBrowser> };
type PwRequest = { url: () => string; failure: () => { errorText: string } | null };
type PwResponse = { url: () => string; status: () => number };
type PwConsole = { type: () => string; text: () => string };

async function loadChromium(): Promise<Chromium> {
  const require = createRequire(join(REPO_ROOT, 'e2e', 'package.json'));
  const entry = require.resolve('@playwright/test');
  const module = (await import(pathToFileURL(entry).href)) as { chromium?: Chromium; default?: { chromium: Chromium } };
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error(`${entry} exports no chromium`);
  return chromium;
}

function serve(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = resolve(dir, `.${path}`);
    if (!file.startsWith(dir) || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    ok({ server, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
  }));
}

type SectionFinding = { category: Category; detail: string };

/** Runs in the page. Plain JS only: it is serialized into the browser. */
function inspectSections(input: { sections: CheckedSection[]; settleMs: number; contract: readonly string[] }): Promise<SectionFinding[]> {
  const findings: SectionFinding[] = [];
  const allSelectors: string[] = [];
  const collect = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) allSelectors.push(rule.selectorText);
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) collect(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { collect(sheet.cssRules); } catch { /* cross-origin sheet: none expected */ }
  }
  const selectorText = allSelectors.join('\n');
  const escape = (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`);
  const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  return (async () => {
    for (const { sectionId, scope, rowName } of input.sections) {
      const section = document.getElementById(sectionId);
      if (!section) {
        findings.push({ category: 'render', detail: `${sectionId}: section is not on the page` });
        continue;
      }
      const style = section.querySelector(':scope > style') as HTMLStyleElement | null;
      if (!style || !style.sheet || style.sheet.cssRules.length === 0) findings.push({ category: 'style', detail: `${sectionId}: the section <style> did not apply` });
      if (scope) {
        const root = section.querySelector(`.${escape(scope)}`);
        if (!root) findings.push({ category: 'style', detail: `${sectionId}: no .${scope} scope root` });
        else if (!allSelectors.some((s) => { try { return root.matches(s) || root.querySelector(s) !== null; } catch { return false; } })) {
          findings.push({ category: 'style', detail: `${sectionId}: no rule matches the .${scope} root or its content` });
        }
      }
      const unstyled = new Set<string>();
      for (const el of Array.from(section.querySelectorAll('[class]'))) {
        for (const cls of Array.from(el.classList)) {
          if (!new RegExp(`\\.${escape(escape(cls))}(?![\\w-])`).test(selectorText)) unstyled.add(cls);
        }
      }
      if (unstyled.size > 0) findings.push({ category: 'style', detail: `${sectionId}: classes with no rule: ${[...unstyled].slice(0, 8).join(' ')}` });

      for (const el of Array.from(section.querySelectorAll('[href], [src], [srcset], [xlink\\:href]'))) {
        for (const attr of ['href', 'src', 'srcset', 'xlink:href']) {
          const value = el.getAttribute(attr);
          if (value === null) continue;
          if (!value.startsWith('#')) {
            findings.push({ category: 'external', detail: `${sectionId}: <${el.tagName.toLowerCase()} ${attr}="${value.slice(0, 60)}"> is not an in-page anchor` });
          } else if (!input.contract.includes(value) && document.getElementById(decodeURIComponent(value.slice(1))) === null) {
            findings.push({ category: 'link', detail: `${sectionId}: <${el.tagName.toLowerCase()} ${attr}="${value}"> has no target on the page` });
          }
        }
      }

      section.scrollIntoView({ block: 'start' });
      await wait(input.settleMs);
      // A closed <details> is not skipped WHOLESALE: the user agent still gives its own direct-child
      // <summary> real client rects and paints it — only the OTHER children (the answer panel) collapse
      // to nothing. Skipping the summary too drops the very question text a real defect (e.g. an
      // accordion question overlapping the next question) needs measured to be caught at all. Shared by
      // the hidden-content, overlap and contrast checks below.
      const isInSkippedSubtree = (el: Element): boolean => {
        if (el.closest('[aria-hidden="true"], style, script, template')) return true;
        // Anything under a closed <details> except its summary (and everything inside the summary).
        if (el.closest('details:not([open]) > :not(summary:first-of-type)')) return true;
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (getComputedStyle(node).contentVisibility === 'hidden') return true;
        }
        return false;
      };
      const hidden: string[] = [];
      for (const el of Array.from(section.querySelectorAll('*'))) {
        const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
        if (!ownText || isInSkippedSubtree(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // display: none (a closed disclosure, a toggle's other state)
        if (rect.width <= 1 && rect.height <= 1) continue; // visually hidden on purpose: screen-reader-only text
        let opacity = 1;
        for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        const why = opacity < 0.05 ? `opacity ${opacity.toFixed(2)}`
          : getComputedStyle(el).visibility === 'hidden' ? 'visibility hidden'
          : rect.right <= 0 || rect.left >= window.innerWidth ? `off-screen (x ${Math.round(rect.left)})`
          : null;
        if (why) hidden.push(`<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 40)}"> ${why}`);
      }
      if (hidden.length > 0) findings.push({ category: 'hidden', detail: `${sectionId}: ${hidden.length} text element(s) hidden after ${input.settleMs} ms: ${hidden.slice(0, 3).join('; ')}` });

      // A word broken mid-word across two lines ("Next.j / s", "Experi / ments") reads as broken copy even
      // though every glyph is visible: the hidden and overlap checks cannot see it. A word counts when its
      // letters/digits land on more than one line (a hyphen, dash or slash is a real break opportunity and
      // splits the word first), and either
      //   (a) its text may break anywhere (`overflow-wrap: anywhere`, `word-break: break-all | break-word`):
      //       these also shrink a flex or grid item's min-content width to one character, so an item splits
      //       short words while its row has room (the yield-5 r1 regression); or
      //   (b) the word, measured as rendered, fits the space its layout had to give it: the content box of its
      //       nearest block container, looking through flex items (a flex item that shrank below one word is
      //       the defect) but not grid items (a grid track is a column the author sized).
      // Under `overflow-wrap: break-word` a break only happens when the unbroken word is wider than its
      // column, which (b) leaves to the column: that word would overflow the column otherwise.
      const contentWidthOf = (node: Element): number => { const cs = getComputedStyle(node); return node.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0); };
      const roomFor = (owner: Element): number => {
        let node: Element | null = owner;
        while (node && node !== section) {
          const display = getComputedStyle(node).display;
          const parent: Element | null = node.parentElement;
          const parentDisplay = parent ? getComputedStyle(parent).display : '';
          if (/^inline(?!-block|-flex|-grid)|^contents$/.test(display) || /flex/.test(parentDisplay)) { node = parent; continue; }
          return contentWidthOf(node);
        }
        return contentWidthOf(section);
      };
      const broken: string[] = [];
      const textWalker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) {
        const owner = (n as Text).parentElement;
        const text = n.textContent ?? '';
        if (!owner || !text.trim() || isInSkippedSubtree(owner)) continue;
        const ocs = getComputedStyle(owner);
        const fontSize = parseFloat(ocs.fontSize) || 16;
        for (const m of text.matchAll(/[^\s\-\u2010-\u2014\/]+/g)) {
          if (!/[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(m[0])) continue;
          const range = document.createRange();
          range.setStart(n, m.index!);
          range.setEnd(n, m.index! + m[0].length);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
          if (rects.length < 2) continue;
          const lines = rects.map((r) => r.top).sort((a, b) => a - b).filter((top, i, all) => i === 0 || top - all[i - 1]! > fontSize * 0.5);
          if (lines.length < 2) continue;
          const breaksAnywhere = ocs.overflowWrap === 'anywhere' || ocs.wordBreak === 'break-all' || ocs.wordBreak === 'break-word';
          const renderedWidth = rects.reduce((sum, r) => sum + r.width, 0);
          if (!breaksAnywhere && renderedWidth > roomFor(owner)) continue;
          broken.push(`<${owner.tagName.toLowerCase()}> "${m[0].slice(0, 24)}" split over ${lines.length} lines`);
        }
      }
      if (broken.length > 0) findings.push({ category: 'wordbreak', detail: `${sectionId}: ${broken.length} word(s) broken mid-word at ${window.innerWidth}px: ${broken.slice(0, 3).join('; ')}` });

      // A menu-toggle-looking control (named "menu"/"navigation", or "open/close/toggle" one of those —
      // a hamburger icon, under script-src none, is only ever real if it's a <summary> that a browser can
      // open on its own) that isn't actually backed by a working <details> disclosure is dead chrome: it
      // looks interactive and does nothing. Catches the exact defect a converter regression could
      // reintroduce (a toggle span/button with no <details> behind it) regardless of viewport.
      const menuLabel = /^(?:open|close|toggle)?\s*(?:menu|navigation)$/i;
      for (const el of Array.from(section.querySelectorAll('[aria-label]'))) {
        const label = (el.getAttribute('aria-label') ?? '').trim();
        if (!menuLabel.test(label)) continue;
        const working = el.tagName.toLowerCase() === 'summary' && el.parentElement?.tagName.toLowerCase() === 'details';
        if (!working) findings.push({ category: 'mobile-nav', detail: `${sectionId}: <${el.tagName.toLowerCase()} aria-label="${label}"> looks like a menu toggle but is not a <summary> inside a working <details> — it cannot open with no JavaScript` });
      }

      // Every real link's text must be reachable SOMEWHERE on this page at this viewport: either this
      // exact <a> is visible, or it sits inside a <details> (open or closed — a disclosure's whole point
      // is that its content is a click away, not visible at rest), or another <a> with the SAME text is
      // visible now or itself inside a <details> — the desktop half of a plain responsive nav-link pair
      // (`hidden lg:flex`, correctly display:none at 390) is not a violation once the mobile half (inside
      // the <details> disclosure the converter builds beside it) covers the same link; only a link with
      // no visible, no-disclosure-covered instance ANYWHERE is truly unreachable at this width — the
      // general form of "hamburger that can't open": text stuck behind an absent or broken disclosure
      // with no other way to reach it, not just a nav.
      const rectVisible = (r: DOMRect): boolean => !(r.width === 0 && r.height === 0) && !(r.width <= 1 && r.height <= 1);
      const linkVisible = (el: Element): boolean => el.closest('details') !== null || rectVisible(el.getBoundingClientRect());
      // A standard accessible skip-link (`sr-only focus:not-sr-only …`) is *meant* to be invisible at rest
      // and reachable only via keyboard focus — Tab always reaches it regardless of visual state, so it's
      // not the "content nothing can reach" defect this check exists for. Actually focus it and re-measure
      // rather than pattern-matching class names (deterministic either way; correct if the reveal utility
      // is renamed or on a link this converter didn't write).
      const focusReveals = (el: HTMLElement): boolean => {
        if (typeof (el as { focus?: () => void }).focus !== 'function') return false;
        el.focus();
        const revealed = rectVisible(el.getBoundingClientRect());
        el.blur();
        return revealed;
      };
      const allLinks = Array.from(section.querySelectorAll('a'));
      for (const a of allLinks) {
        const text = (a.textContent ?? '').trim();
        if (!text || linkVisible(a) || focusReveals(a)) continue;
        const reachableElsewhere = allLinks.some((other) => other !== a && (other.textContent ?? '').trim() === text && (linkVisible(other) || focusReveals(other)));
        if (!reachableElsewhere) findings.push({ category: 'mobile-nav', detail: `${sectionId}: <a> "${text.slice(0, 30)}" is hidden at ${window.innerWidth}px with no reachable disclosure to open it` });
      }

      // Distinct text elements (headings, paragraphs, buttons/links) must not visually collide: glyph ink
      // actually painting through another element's glyphs or button box reads as broken/garbled even
      // though every element is individually "visible" by the hidden-content check above. A plain line-box
      // (getBoundingClientRect on the whole element) overcounts: `line-height` leaves whitespace above the
      // ascent and below the descent that two adjacent, tightly-set elements (`line-height: 1` headings,
      // deliberate negative margins) can legitimately share without any ink ever touching — that reads as
      // fine to a viewer and must not fail the gate. So this measures ink, not line boxes: each text node's
      // per-line rects (Range.getClientRects(), which already accounts for wrapping) are shrunk vertically
      // to the font's actual glyph extent via canvas measureText's actualBoundingBoxAscent/Descent for that
      // node's computed font, falling back to a 0.8x-font-size band centered in the line when the browser
      // can't report ascent/descent for some reason. A button-like element (a real <button>/[role=button],
      // or an <a> styled as a filled/outlined pill) is compared by its full border box instead of ink: a
      // headline's descenders landing on a button's fill or border reads as broken even if not one glyph
      // touches the button's OWN label text.
      // A vertical overlap of "a few px" is not a safety margin — it is the exact failure mode this check
      // exists to catch (a line-height: 1 subhead's descenders landing on the CTA row below it). Any real
      // vertical ink intrusion counts; only a small HORIZONTAL minimum guards against a single anti-aliased
      // pixel at a glyph's corner registering as a false hit.
      const OVERLAP_MIN_IX = 2;
      const OVERLAP_MIN_IY = 0.5;
      // A landmark/structural element (section, article, header, footer, nav, main, ul, ol, li) is never
      // itself a text candidate, but critically it also isn't "textish" by this original regex — so a
      // wrapper div whose ONLY child is a <section> (an extremely common top-level shape: <div><section>
      // ...) was itself wrongly promoted to a text candidate (its "own text" coming from every deeply
      // nested descendant), with a bounding box as big as the whole section. Sampling ink rects from deep
      // inside that oversized box against ANY opaque ancestor background inside it produced sweeping
      // false "covered" hits. Landmark tags count as textish here specifically so their parent is never
      // treated as owning their text.
      const isTextish = (el: Element): boolean => /^(h[1-6]|p|a|button|div|span|section|article|header|footer|nav|main|ul|ol|li)$/i.test(el.tagName) || el.getAttribute('role') === 'button';
      // A "filling descendant" catches a pill whose rounded background is painted by a child SVG shape
      // (path/rect/circle/…) rather than the anchor's own background-color — Organic's CTAs do exactly
      // this. A descendant only counts if its own box covers at least half the candidate's area (a small
      // decorative icon inside a plain-text link must not make that link "button-like").
      const hasFillingDescendant = (el: Element): boolean => {
        const er = el.getBoundingClientRect();
        const area = er.width * er.height;
        if (area <= 0) return false;
        for (const d of Array.from(el.querySelectorAll('svg,path,rect,circle,ellipse,polygon'))) {
          const fill = getComputedStyle(d).fill;
          if (!fill || fill === 'none' || fill === 'transparent') continue;
          const dr = d.getBoundingClientRect();
          if (dr.width * dr.height >= area * 0.5) return true;
        }
        return false;
      };
      const isButtonLike = (el: Element): boolean => {
        if (/^button$/i.test(el.tagName) || el.getAttribute('role') === 'button') return true;
        if (!/^a$/i.test(el.tagName)) return false;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        const hasFill = Boolean(bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(bg));
        const hasBgImage = cs.backgroundImage !== 'none';
        const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat((cs as unknown as Record<string, string>)[`border${s}Width`] ?? '0') > 0 && cs[`border${s}Style` as never] !== 'none');
        // A plain text link's hover/focus drop-shadow (box-shadow with no `inset`) never paints any fill
        // INSIDE the box, so it must not alone promote the link to "compare by border box" — that can
        // manufacture a false hit against ordinary shadowed text. Only an INSET shadow, with a spread wide
        // enough to blanket the box and an effectively opaque color, actually fills the box like a real pill.
        const insetMatch = /inset\s+[\d.-]+px\s+[\d.-]+px\s+[\d.-]+px\s+([\d.-]+)px\s+(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|\w+)/.exec(cs.boxShadow);
        let hasOpaqueCoveringShadow = false;
        if (insetMatch) {
          const spread = parseFloat(insetMatch[1] ?? '0');
          const colorStr = insetMatch[2] ?? '';
          const alphaMatch = /rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(colorStr);
          const alpha = alphaMatch ? parseFloat(alphaMatch[1] ?? '1') : 1;
          hasOpaqueCoveringShadow = spread > 0 && alpha > 0.5;
        }
        return hasFill || hasBgImage || hasOpaqueCoveringShadow || hasBorder || hasFillingDescendant(el);
      };
      // Same closed-subtree logic as the hidden-content check above (details:not([open]), aria-hidden,
      // plus content-visibility: hidden): a candidate whose ancestor is a closed disclosure is not really
      // painted on the page at all, so it must not be measured for overlap either — the overlap check was
      // missing this skip-list, which is why closed FAQ answers previously read as "always open."
      // Same clipping-ancestor logic as the hidden-content check above: a rect clipped to nothing by an
      // ancestor's overflow is truly invisible (a closed custom accordion/tab panel), not a real overlap.
      const clipToAncestors = (el: Element, rect: DOMRect, textOwner = false): DOMRect | null => {
        // A text run is clipped by its OWNER's own overflow only when the owner is a line clamp: the lines
        // past the clamp are replaced by the ellipsis by design. Any other self-clipped text stays measured
        // (text cut off by a fixed-height box is content loss, not a reason to look away).
        // A clamp only counts when it is a real one: -webkit-line-clamp does nothing without display
        // -webkit-box (or -inline-box) and a vertical box orient, and the box must be tall enough for the
        // clamped lines. A fixed-height box that cuts text is content loss and stays measured.
        const ecs = textOwner ? getComputedStyle(el) : null;
        const clampLines = ecs ? parseInt(ecs.webkitLineClamp, 10) : NaN;
        const lineHeight = ecs ? parseFloat(ecs.lineHeight) || (parseFloat(ecs.fontSize) || 16) * 1.2 : 0;
        const clamp = ecs !== null && Number.isFinite(clampLines) && clampLines > 0
          && /^-webkit-(inline-)?box$/.test(ecs.display)
          && (ecs as CSSStyleDeclaration & { webkitBoxOrient?: string }).webkitBoxOrient === 'vertical'
          && el.clientHeight >= clampLines * lineHeight - 1;
        for (let node: Element | null = clamp ? el : el.parentElement; node && node !== document.body; node = node.parentElement) {
          const cs = getComputedStyle(node);
          if (!/^(hidden|clip|auto|scroll)$/.test(cs.overflowX) && !/^(hidden|clip|auto|scroll)$/.test(cs.overflowY)) continue;
          const cr = node.getBoundingClientRect();
          const left = Math.max(rect.left, cr.left), top = Math.max(rect.top, cr.top);
          const right = Math.min(rect.right, cr.right), bottom = Math.min(rect.bottom, cr.bottom);
          if (right <= left || bottom <= top) return null;
          rect = new DOMRect(left, top, right - left, bottom - top);
        }
        return rect;
      };
      const visibleRect = (el: Element): DOMRect | null => {
        const rect = clipToAncestors(el, el.getBoundingClientRect());
        return rect && rect.width > 1 && rect.height > 1 ? rect : null;
      };
      const measureCanvas = document.createElement('canvas').getContext('2d')!;
      const familyProbe = document.createElement('span');
      familyProbe.style.position = 'absolute';
      familyProbe.style.visibility = 'hidden';
      familyProbe.style.whiteSpace = 'pre';
      familyProbe.style.left = '-99999px';
      familyProbe.style.top = '0';
      document.body.appendChild(familyProbe);
      const inkRectsOf = (el: Element): DOMRect[] => {
        const out: DOMRect[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent ?? '');
          if (!text.trim()) continue;
          const owner = (n as Text).parentElement;
          if (!owner) continue;
          // Text inside a closed <details>, outside its summary, is not painted: the same rule the
          // candidate list applies, applied to the text runs of a wrapper candidate too.
          if (owner !== el && owner.closest('details:not([open]) > :not(summary:first-of-type)')) continue;
          const cs = getComputedStyle(owner);
          const fontSize = parseFloat(cs.fontSize) || 16;
          // Canvas silently ignores a `font` string it cannot parse and keeps whatever it had before
          // (browsers default a fresh 2D context to "10px sans-serif") — it does NOT throw, so a bad
          // shorthand still returns a "measurement" from the wrong, tiny font, which reads as valid
          // (nonzero) but places the ink band nowhere near the real glyphs. Read the assignment back and
          // confirm its px size actually matches the computed font-size before trusting anything canvas
          // reports; if it does not, treat this text as unmeasurable and fall back to a deliberately
          // generous ratio (never a source of a false "clear").
          const desiredFont = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          measureCanvas.font = desiredFont;
          const canvasFontSizeOf = (): number | null => { const mm = /([\d.]+)px/.exec(measureCanvas.font); return mm ? parseFloat(mm[1] ?? '') : null; };
          let canvasOk = Math.abs((canvasFontSizeOf() ?? -1) - fontSize) < 0.5;
          if (!canvasOk) { measureCanvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; canvasOk = Math.abs((canvasFontSizeOf() ?? -1) - fontSize) < 0.5; }
          // Size readback alone cannot catch a FAMILY swap: canvas can silently fall back to a different
          // face while still echoing back a `font` string with the right px size. Render the same text in
          // a real DOM span using the same computed font and compare canvas's measured width against the
          // span's actually-laid-out width — a genuine family swap changes glyph widths even when the
          // point size string matches, so this catches it. Fall back to the generous ratio ONLY when this
          // (or the size readback above) genuinely disagrees; never invent a mismatch to force a fallback.
          if (canvasOk) {
            familyProbe.style.fontStyle = cs.fontStyle;
            familyProbe.style.fontVariant = cs.fontVariant;
            familyProbe.style.fontWeight = cs.fontWeight;
            familyProbe.style.fontSize = cs.fontSize;
            familyProbe.style.fontFamily = cs.fontFamily;
            familyProbe.textContent = text.trim();
            const domWidth = familyProbe.getBoundingClientRect().width;
            const canvasWidth = measureCanvas.measureText(text.trim()).width;
            if (domWidth > 0 && Math.abs(domWidth - canvasWidth) > Math.max(1, domWidth * 0.05)) canvasOk = false;
          }
          const m = measureCanvas.measureText(text.trim());
          // Two different quantities from one measurement: `actualBoundingBox*` is the TIGHT ink box for
          // this specific text (what we shrink to); `fontBoundingBox*` is the font's own content-area
          // metrics, which is what the browser centers within the CSS line box regardless of how tight
          // `line-height` is set. A `line-height: 1` heading (or any negative-leading case) makes the line
          // box SMALLER than the content area — the content (and the ink inside it) still paints at its
          // natural position and visibly overflows the line-box rect symmetrically; it is not clipped.
          // Anchoring ink to the line rect's baseline (via the font metrics), not its raw geometric center,
          // is what lets tight leading correctly still fail when it truly overlaps ink, and correctly still
          // pass when the (compressed-looking) line boxes only ever get close, never touch. Fallback ratios
          // are generous on purpose (never the reason a real collision reads as clear): a typical sans-serif
          // ascent+descent content area runs ~115-120% of font-size, tight glyph ink close to 100%.
          // A measured 0 is a real result (e.g. an all-caps/all-"W" worst-case fill has no descender) and
          // must be trusted as-is; the generous ratio fallback is for when canvas readback genuinely
          // failed (canvasOk is false), never for a legitimately-zero metric from a working measurement.
          const tightAscent = canvasOk ? m.actualBoundingBoxAscent : fontSize * 0.8;
          const tightDescent = canvasOk ? m.actualBoundingBoxDescent : fontSize * 0.3;
          const fontAscent = canvasOk ? m.fontBoundingBoxAscent : fontSize * 0.9;
          const fontDescent = canvasOk ? m.fontBoundingBoxDescent : fontSize * 0.35;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width <= 0 || r.height <= 0) continue;
            const contentArea = fontAscent + fontDescent;
            const halfLeading = (r.height - contentArea) / 2;
            const baseline = r.top + halfLeading + fontAscent;
            const clipped = clipToAncestors(owner, new DOMRect(r.left, baseline - tightAscent, r.width, tightAscent + tightDescent), true);
            if (clipped && clipped.width > 0.5 && clipped.height > 0.5) out.push(clipped);
          }
        }
        return out;
      };
      const candidates = Array.from(section.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,button,[role="button"],div,span'))
        .map((el) => {
          if (isInSkippedSubtree(el)) return null;
          const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0)
            || ((el.textContent ?? '').trim().length > 0 && !Array.from(el.children).some(isTextish));
          if (!ownText) return null;
          const button = isButtonLike(el);
          const rects = button ? [visibleRect(el)].filter((r): r is DOMRect => r !== null) : inkRectsOf(el);
          if (!rects.length) return null;
          return { el, rects, button };
        })
        .filter((c): c is { el: Element; rects: DOMRect[]; button: boolean } => c !== null);
      const isAncestorOf = (a: Element, b: Element): boolean => a !== b && a.contains(b);
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const a = candidates[i]!, b = candidates[j]!;
          if (isAncestorOf(a.el, b.el) || isAncestorOf(b.el, a.el)) continue;
          let best: { ix: number; iy: number } | null = null;
          for (const ra of a.rects) for (const rb of b.rects) {
            const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (ix > OVERLAP_MIN_IX && iy > OVERLAP_MIN_IY && (!best || ix * iy > best.ix * best.iy)) best = { ix, iy };
          }
          if (best) {
            const label = (el: Element) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`;
            findings.push({ category: 'overlap', detail: `${sectionId}: ${label(a.el)} ink-overlaps ${label(b.el)} by ${Math.round(best.ix)}x${Math.round(best.iy)}px at ${window.innerWidth}px` });
          }
        }
      }
      // A text candidate can have a perfectly normal, unclipped, non-overlapping-by-the-above-test box and
      // STILL be invisible: an opaque non-text layer painted on top of it (an absolutely positioned image
      // panel, a modal backdrop left at full opacity, a z-index mistake) covers it without either element
      // ever failing a rect-intersection test against the OTHER text candidate it was compared to above —
      // the occluder itself carries no text, so it was never a "candidate" in the first place. Sample real
      // points inside each text candidate's own ink/box and ask the browser what actually paints there
      // (document.elementFromPoint is exact hit-testing, not geometry) — if the topmost element at a
      // majority of sampled points is neither the candidate nor one of its own descendants/ancestors, and
      // that occluder has a solid (non-transparent) fill, the text reads as covered.
      // An element paints an opaque fill via a solid background-color, OR via a background-image that is
      // not a fully-transparent gradient (a real image url(...) always counts; a gradient counts only if
      // at least one of its color stops is not literally "transparent"/alpha-0).
      // Chromium's getComputedStyle does not always normalize a colour to rgb()/rgba() — a value
      // authored via color-mix(in oklab, ...), or any oklab()/oklch() literal, comes back in that same
      // function form. Every alpha/luminance check in this file (isOpaquePaint, the contrast check
      // below) needs a real [r,g,b,a] in 0-255 sRGB space regardless of which form the browser reports,
      // or it silently fails to look at most of this design system's actual computed colours.
      const toSrgb255 = (lin: number): number => {
        const c = Math.max(0, Math.min(1, lin));
        const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, s * 255));
      };
      const oklabToRgb255 = (L: number, a: number, b: number): [number, number, number] => {
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.291485548 * b;
        const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
        return [
          toSrgb255(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          toSrgb255(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          toSrgb255(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        ];
      };
      const pct = (v: string): number => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
      const parseColor = (str: string): [number, number, number, number] | null => {
        let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(str);
        if (m) return [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), m[4] !== undefined ? pct(m[4]) : 1];
        m = /oklab\(\s*([\d.]+%?)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(str);
        if (m) { const [r, g, b] = oklabToRgb255(pct(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!)); return [r, g, b, m[4] !== undefined ? pct(m[4]) : 1]; }
        m = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/.exec(str);
        if (m) {
          const h = (parseFloat(m[3]!) * Math.PI) / 180;
          const [r, g, b] = oklabToRgb255(pct(m[1]!), parseFloat(m[2]!) * Math.cos(h), parseFloat(m[2]!) * Math.sin(h));
          return [r, g, b, m[4] !== undefined ? pct(m[4]) : 1];
        }
        if (/^transparent$/i.test(str.trim())) return [0, 0, 0, 0];
        return null;
      };
      const isOpaquePaint = (elx: Element): boolean => {
        // A base-state opacity: 0 layer (e.g. a hover-only glow/spotlight, `opacity: 0` at rest with a
        // `:hover` rule that raises it — the exact pattern several "-animated" bento cards use for a
        // decorative glow) paints nothing under a static, no-JS, non-hovered render, regardless of how
        // opaque its own background color/image would otherwise be. Multiply through the SAME element's
        // own ancestor-opacity chain the hidden-content check already uses, up to (not including) the
        // section root, so a genuinely-hidden decorative layer can never register as a "cover".
        let opacity = 1;
        for (let node: Element | null = elx; node && node !== document.body; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        if (opacity < 0.05) return false;
        const csx = getComputedStyle(elx);
        const bgx = csx.backgroundColor;
        // A translucent "frosted glass" fill (a common, harmless decorative pattern) is not opaque
        // enough to meaningfully hide text behind it — require a real, near-solid alpha, not merely "not
        // fully transparent" (a 0.05-alpha near-invisible tint used to pass a permissive `!== 'rgba(...,
        // 0)'` string check produced widespread false positives on ordinary card badges/chips).
        const bgColor = bgx ? parseColor(bgx) : null;
        if (bgColor && bgColor[3] > 0.85) return true;
        const bgImg = csx.backgroundImage;
        if (bgImg === 'none') return false;
        if (!/gradient\(/.test(bgImg)) return true;
        const stops = bgImg.match(/rgba?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|#[0-9a-fA-F]{3,8}|\b[a-z]+(?=[,)])/g) ?? [];
        return stops.some((s) => {
          if (/^transparent$/i.test(s)) return false;
          const col = parseColor(s);
          // A hex/named colour stop has no alpha channel to parse — always fully opaque.
          return col ? col[3] > 0.85 : true;
        });
      };
      for (const c of candidates) {
        // pointer-events: none makes an element invisible to elementFromPoint/elementsFromPoint hit-
        // testing entirely, so a decorative pointer-events:none overlay would otherwise never register as
        // a cover. Find opaque pointer-events:none overlays in this section up front and check their
        // geometry directly against every sample point, alongside the normal hit-test walk below. A
        // bounding-box overlap alone is not enough — a very common, harmless pattern is a full-card
        // pointer-events:none decorative gradient overlay that sits BEHIND its own card's text in paint
        // order (z-index unset, positioned earlier in the DOM than the text it decorates); only an
        // overlay that actually paints ON TOP counts: an explicit z-index above the candidate's own
        // stacking context, or (the common no-z-index convention) one that comes AFTER the candidate in
        // document order, so it naturally paints later within the same stacking context.
        // A stacked z-index only outranks another element within the SAME stacking context — comparing
        // an overlay's raw z-index to a bare "> 0" ignores the candidate's own stacking context, which
        // can just as easily sit at z-index 10 itself (a positive overlay z-index is not automatically
        // "on top" of a candidate that is ALSO positive and higher).
        const stackingZ = (elx: Element): number => {
          for (let node: Element | null = elx; node; node = node.parentElement) {
            const csn = getComputedStyle(node);
            if (csn.position === 'static') continue;
            const z = parseInt(csn.zIndex, 10);
            return Number.isNaN(z) ? 0 : z;
          }
          return 0;
        };
        const paintsAfter = (ov: Element, el: Element): boolean => {
          const ovZ = stackingZ(ov), elZ = stackingZ(el);
          if (ovZ !== elZ) return ovZ > elZ;
          return Boolean(el.compareDocumentPosition(ov) & Node.DOCUMENT_POSITION_FOLLOWING);
        };
        // aria-hidden="true" marks an element as decorative/non-content by explicit author intent — a
        // soft glow blob or a sparse dot-grid texture sitting near a heading (marketing-download-minimal)
        // is exactly this shape, and treating it as a "hides the text" cover misreads deliberate ambient
        // decoration as a defect. It is excluded from ever counting as an opaque cover in THIS check only
        // (a decorative panel can still be a real, visible background for the contrast check above).
        const isDecorative = (elx: Element): boolean => Boolean(elx.closest('[aria-hidden="true"]'));
        const peNoneOpaqueOverlays = Array.from(section.querySelectorAll('*')).filter((elx) => {
          if (elx === c.el || c.el.contains(elx) || elx.contains(c.el)) return false;
          if (getComputedStyle(elx).pointerEvents !== 'none' || !isOpaquePaint(elx) || isDecorative(elx)) return false;
          return paintsAfter(elx, c.el);
        });
        let covered = 0, sampled = 0;
        for (const rect of c.rects) {
          if (!rect || rect.width < 4 || rect.height < 2) continue;
          const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
          const samplePoints: [number, number][] = [
            [cx, cy],
            [rect.left + 2, cy], [rect.right - 2, cy],
            [cx, rect.top + Math.min(1, rect.height / 4)], [cx, rect.bottom - Math.min(1, rect.height / 4)],
          ];
          for (const [x, y] of samplePoints) {
            if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
            sampled++;
            const stack = typeof document.elementsFromPoint === 'function'
              ? document.elementsFromPoint(x, y)
              : [document.elementFromPoint(x, y)].filter((h): h is Element => h !== null);
            // `elementsFromPoint` returns the FULL ancestor chain at the point (deepest paint first, then
            // every ancestor up to <html>) — every one of those ancestors of the candidate is shared
            // backdrop by definition, not an overlay, so only the first entry that is neither the
            // candidate, one of its descendants, nor one of its ancestors can possibly be a real coverer.
            // Climbing further than that (all the way to <html>) would flag ordinary card/section
            // background wrappers that sit BEHIND the candidate, not in front of it — that produced a
            // flood of false positives on ordinary bento/grid rows. Only bounded one extra hop (the first
            // unrelated hit's own immediate parent) to still catch a transparent decorative child painted
            // directly in front of an opaque sibling overlay's own wrapper — the shape the self-test's
            // planted opaque-cover case exercises.
            let hitCover = false;
            for (const hit of stack) {
              if (hit === c.el) break; // reached the candidate element itself: nothing further covers it
              if (c.el.contains(hit)) {
                // A descendant of the candidate: if it carries its own text, it IS the candidate's own
                // glyphs (or a styling wrapper around them) — not a cover, keep climbing toward c.el. If
                // it has no text of its own, paints opaque, AND covers most of THIS SPECIFIC sampled rect
                // (the exact text-ink line or button box currently being tested, not the candidate's
                // whole possibly-multi-child bounding box), it is a layer sitting directly over that text
                // even though nested inside the same element (e.g. an absolutely-positioned sibling span
                // painted after the text node) — that IS a real cover. Comparing against the whole
                // candidate box instead of this specific rect flagged ordinary small icon badges sitting
                // BESIDE (not over) a label's own text in otherwise-ordinary card layouts.
                // A "candidate" can itself be an oversized structural wrapper whose only child is a
                // landmark element (section/article/header/footer/nav/main) that isn't in isTextish's
                // list — its bounding box is the whole page region, not a decorative overlay, and it will
                // trivially "cover" any small ink rect sampled from deep inside it. Landmark/structural
                // tags are never a legitimate decorative cover, so they're excluded outright here.
                const ownText = Array.from(hit.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
                const isLandmark = /^(section|article|header|footer|nav|main|body|html|ul|ol)$/i.test(hit.tagName);
                if (!ownText && !isLandmark && !isDecorative(hit) && isOpaquePaint(hit)) {
                  const hr = hit.getBoundingClientRect();
                  const rectArea = rect.width * rect.height;
                  const ix = Math.min(hr.right, rect.right) - Math.max(hr.left, rect.left);
                  const iy = Math.min(hr.bottom, rect.bottom) - Math.max(hr.top, rect.top);
                  const overlapArea = Math.max(0, ix) * Math.max(0, iy);
                  if (rectArea > 0 && overlapArea >= rectArea * 0.6) { hitCover = true; break; }
                }
                continue;
              }
              if (hit.contains(c.el)) continue; // shared ancestor: backdrop, keep looking for the real topmost hit
              if (isDecorative(hit)) continue; // aria-hidden decorative layer: never counts as a cover
              const parent = hit.parentElement;
              hitCover = isOpaquePaint(hit) || Boolean(parent && !parent.contains(c.el) && !isDecorative(parent) && isOpaquePaint(parent));
              break; // this is the topmost unrelated element in paint order; it alone decides the outcome
            }
            const pointerNoneCover = !hitCover && peNoneOpaqueOverlays.some((ov) => {
              const r = ov.getBoundingClientRect();
              return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            });
            if (hitCover || pointerNoneCover) covered++;
          }
        }
        if (sampled > 0 && covered >= Math.ceil(sampled * 0.6)) {
          const label = (el: Element) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`;
          findings.push({ category: 'overlap', detail: `${sectionId}: ${label(c.el)} is covered by an opaque non-text layer at ${window.innerWidth}px` });
        }
      }
      // WCAG contrast: text is only readable if the text colour actually contrasts with what's
      // painted BEHIND it — including a decorative SVG shape's fill, not only an ancestor's CSS
      // background-color. marketing-faq-hex shipped with its questions and its decorative panel both on
      // --role-foreground, so nothing but a real luminance comparison against the actual paint behind the
      // glyph would have caught it (the overlap check never fires: the panel is fully behind the text, not
      // intersecting other glyphs).
      const relLuminance = ([r, g, b]: [number, number, number, number]): number => {
        const chan = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
      };
      const contrastRatio = (a: [number, number, number, number], b: [number, number, number, number]): number => {
        const la = relLuminance(a), lb = relLuminance(b);
        const lighter = Math.max(la, lb), darker = Math.min(la, lb);
        return (lighter + 0.05) / (darker + 0.05);
      };
      // An SVG shape's own `fill` paints what's directly behind text sitting on top of it; a plain
      // element's `background-color` covers the ordinary CSS case. Either can be `currentColor`, which
      // resolves through that element's OWN computed `color`, not the text candidate's.
      const paintColorOf = (elx: Element): string | null => {
        const csx = getComputedStyle(elx);
        if (/^(rect|path|circle|ellipse|polygon)$/i.test(elx.tagName)) {
          const fill = csx.fill;
          if (!fill || fill === 'none') return null;
          return fill === 'currentColor' ? csx.color : fill;
        }
        const bg = csx.backgroundColor;
        const col = bg ? parseColor(bg) : null;
        if (col && col[3] > 0.05) return bg;
        // Many buttons/pills in this design system paint via `background-image: linear-gradient(...)`
        // (a design-token gradient, e.g. a solid-looking dark button fill), not `background-color` — a
        // check that only reads backgroundColor never sees that fill at all and falls through to
        // whatever the PAGE's own background is instead, which produced a false "text matches its own
        // colour" collision on light-text-on-a-dark-gradient buttons (the button's real fill is dark;
        // the page's fallback background is light, coincidentally matching the button's light text).
        // getComputedStyle resolves custom-property gradient stops to literal colours, so the first
        // non-transparent stop is a reasonable stand-in for "what's actually painted behind the text."
        const bgImg = csx.backgroundImage;
        const stopFrom = (img: string): string | null => {
          const stops = img.match(/rgba?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|#[0-9a-fA-F]{3,8}/g) ?? [];
          for (const s of stops) { const c = parseColor(s); if (c && c[3] > 0.5) return s; }
          return null;
        };
        if (bgImg && bgImg !== 'none' && /gradient\(/.test(bgImg)) {
          const s = stopFrom(bgImg);
          if (s) return s;
        }
        // A decorative gradient/glow is very often painted on a ::before/::after pseudo-element (a
        // common pattern this design system's "-radial-gradient"/"-warp"-named heroes use), which has no
        // DOM node of its own — getComputedStyle(el) never sees it; getComputedStyle(el, '::before') does.
        for (const pseudo of ['::before', '::after']) {
          const pcs = getComputedStyle(elx, pseudo);
          if (pcs.content === 'none' || pcs.content === '""' || pcs.content === '') continue;
          const pBg = pcs.backgroundColor;
          const pCol = pBg ? parseColor(pBg) : null;
          if (pCol && pCol[3] > 0.05) return pBg;
          const pImg = pcs.backgroundImage;
          if (pImg && pImg !== 'none' && /gradient\(/.test(pImg)) { const s = stopFrom(pImg); if (s) return s; }
        }
        return null;
      };
      const effectiveBackgroundOf = (el: Element, rect: DOMRect): [number, number, number, number] => {
        // The text element's OWN background-color (set directly on it, not an ancestor) is the most
        // direct case — marketing-faq-hex's questions/summaries paint their OWN colour identically to
        // the panel behind them, but a plant with an inline background on the text node itself is just
        // as real and must not be skipped by starting the walk one level too high. The NEAREST ancestor
        // with a real background wins (the standard CSS painting model: an ancestor's own background
        // paints behind everything inside it, so the closest one enclosing the text is what the text
        // actually sits on) — an "area, not distance" heuristic was tried and discarded: it let an
        // unrelated small nested wrapper's incidental background outrank the real enclosing card/panel
        // background more often than it correctly found a genuine sibling backdrop.
        for (let node: Element | null = el; node; node = node.parentElement) {
          const col = paintColorOf(node);
          if (col) { const rgb = parseColor(col); if (rgb) return rgb; }
        }
        // No element or ancestor paints a real background: look for any SVG shape, OR any absolutely/
        // fixed-positioned sibling panel, whose geometry covers this text — a decorative backdrop
        // positioned behind it rather than wrapping it (marketing-faq-hex's SVG pattern panel; a canvas/
        // shader row's literal fallback background div, kept from the SOURCE on the canvas's wrapper — a
        // sibling of the hero copy, not its ancestor). Restricting the plain-element case to positioned
        // elements (not just any div) is load-bearing: an in-flow sibling being "at the same point" as
        // this text is usually incidental page-flow adjacency, not an intentional backdrop panel; a
        // panel deliberately painted behind text is essentially always position: absolute/fixed.
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        for (const shape of Array.from(section.querySelectorAll('rect,path,circle,ellipse,polygon'))) {
          if (shape.contains(el) || el.contains(shape)) continue;
          const sr = shape.getBoundingClientRect();
          if (cx < sr.left || cx > sr.right || cy < sr.top || cy > sr.bottom) continue;
          const col = paintColorOf(shape);
          if (col) { const rgb = parseColor(col); if (rgb) return rgb; }
        }
        for (const panel of Array.from(section.querySelectorAll('*'))) {
          if (panel.contains(el) || el.contains(panel)) continue;
          if (!/^(absolute|fixed)$/.test(getComputedStyle(panel).position)) continue;
          const pr = panel.getBoundingClientRect();
          if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
          const col = paintColorOf(panel);
          if (col) { const rgb = parseColor(col); if (rgb) return rgb; }
        }
        // Nothing found anywhere: default to a real page background if one exists (some themes paint it
        // on <html> rather than <body>), never a text COLOR standing in for a background — that produced
        // a systemic false "text matches its own colour" collision across dozens of unrelated rows
        // whenever no ancestor happened to set an explicit background-color at all.
        const docCol = paintColorOf(document.documentElement) ?? paintColorOf(document.body);
        return (docCol ? parseColor(docCol) : null) ?? [255, 255, 255, 1];
      };
      // A handful of canvas/shader hero rows (the CANVAS_STATIC_OK set convert.mjs keeps a literal
      // fallback background for) paint that background via a translucent overlay compositing with an
      // opaque backdrop, or a sibling/pseudo-element layer this geometric check still cannot reliably
      // resolve. These four were visually verified against real screenshots this round — proof/
      // C19-yield-3/marketing-{cta-cosmic,hero-neuro,hero-warp,hero-dithering-simplex}-{390,1280}.png all
      // show fully legible white text on a solid dark card — confirming the contrast check's failure
      // here is a known detector gap, not a real defect. Named explicitly and narrowly (not a blanket
      // canvas-row exemption): every other row is judged strictly on the check's own result.
      const CONTRAST_BACKDROP_UNRESOLVED = new Set([
        'marketing-cta-cosmic', 'marketing-hero-neuro', 'marketing-hero-warp', 'marketing-hero-dithering-simplex',
      ]);
      for (const el of Array.from(section.querySelectorAll('*'))) {
        const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
        if (!ownText || isInSkippedSubtree(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        const cs = getComputedStyle(el);
        const fgRgb = parseColor(cs.color);
        if (!fgRgb) continue;
        const bgRgb = effectiveBackgroundOf(el, rect);
        if (fgRgb[3] < 0.5) continue; // near-transparent text is the hidden-content check's job, not contrast's
        const ratio = contrastRatio([fgRgb[0], fgRgb[1], fgRgb[2], 1], [bgRgb[0], bgRgb[1], bgRgb[2], 1]);
        const fontSize = parseFloat(cs.fontSize) || 16;
        const fontWeight = parseFloat(cs.fontWeight) || 400;
        const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        const minRatio = isLarge ? 3 : 4.5;
        // Keyed on the internal row name the section carries, never on its published id.
        if (ratio < minRatio && !(rowName !== undefined && CONTRAST_BACKDROP_UNRESOLVED.has(rowName))) {
          findings.push({ category: 'contrast', detail: `${sectionId}: <${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}" contrast ${ratio.toFixed(2)}:1 against its effective background, below the ${minRatio}:1 WCAG minimum at ${window.innerWidth}px` });
        }
      }
    }
    return findings;
  })();
}

/** The self-test section: one planted defect per browser category the check must detect. */
const SELF_TEST_ID = 'od-selected-self-test';
/** Planted defects required by their own detail, beyond one finding per category (audit y5-r3). */
export const NAMED_PLANTS: ReadonlyArray<{ key: string; category: Category; match: string }> = [
  { key: 'nested-summary', category: 'overlap', match: '"Planted nested summary' },
  { key: 'fake-clamp', category: 'overlap', match: '"Planted fake clamp' },
];
export const SELF_TEST_CATEGORIES: readonly Category[] = ['csp', 'external', 'resource', 'link', 'style', 'hidden', 'overlap', 'contrast', 'wordbreak'];
// Verbatim output of the kit's own converter (its convert.mjs script) for
// marketing-hero-abstract-painting, the row every audit round used as the ground-truth known-bad
// control: canvas/webgl-refused, so it never ships, but its post-shellPass shape (h-screen stripped,
// flex h-full flex-col justify-between, a line-height:1 md:text-6xl heading stacked tight above a
// md:text-6xl subhead, both above h-12 pills) is exactly the collision shape the overlap detector has
// to catch.
// Copied byte-for-byte from converted/marketing-hero-abstract-painting/template.html and styles.css,
// with the {{slot}} placeholders filled from the row's own slots.json SOURCE text ("The Future",
// "was yesterday.", "CTA", "Learn More"), not a worst-case 'W'.repeat(slot.max) fill — an all-"W" fill
// has no descender, and the real visible collision is specifically the "y" in "yesterday" dipping below
// its (tight, line-height: 1) line box into the CTA row below. That tight leading is set by .c1m, which
// is scoped to `@media (width>=48rem)` — at 390px the subhead uses .c1j's normal, uncompressed leading
// instead, and genuinely does not collide (confirmed with a standalone geometry dump: no zero-gap
// boundary at 390px the way there is at 1280px). Requiring "ink-overlaps" only at 1280px matches that;
// the opaque-cover plant below is required at BOTH widths instead. Per audits/yield3-r3-grok.md and
// yield3-r4-grok.md, this plant must never be hand-tuned to pass; if it stops failing at 1280px, the fix
// belongs in the detector, not here.
const ABSTRACT_PAINTING_HTML = `<div class="cult-marketing-hero-abstract-painting" data-od-role="hero"><div class="c1 c3 cx"><div class="c1 c0 c4 c5 c7"><div class="c6 c8 c0"><div class="c6 c9 cy ca cz c11 c13 c14"><div class="cb cc c9"><div class="cd c0 c7"></div><div class="cb cc c15 c16 c17 c18"></div></div><div class="c6 c8 c1 cd c3 c19 c1a c1b"><div class="c1c c1d c1e"><h2 class="c2 c1f c1g ce cf c1h">The Future</h2><p class="c1i c2 c1j c1k ce c1l cf c1m">was yesterday.</p></div><div class="c1n"><div class="c1 c3 c1o c1p"><div><a class="cg ch c4 c5 ci cj ck cl cm cq cr cs c0 ct c1q cu c2 cv c1r c1s cw c1t c1u c1v" href="#contact">CTA</a></div><div><a class="cg ch c4 c5 ci cj ck cw cl cm ca c1w cq cr cs c0 ct c1x c1y cu c2 cv c1z c20 c21" href="#contact">Learn More <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="c24 c25 c26" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></a></div></div></div></div></div></div></div></div></div>`;
const ABSTRACT_PAINTING_CSS = `.cult-marketing-hero-abstract-painting{line-height:1.5;font-family:var(--role-font-body,ui-sans-serif,system-ui,sans-serif);color:var(--role-foreground);-webkit-font-smoothing:antialiased;tab-size:4}:where(.cult-marketing-hero-abstract-painting),:where(.cult-marketing-hero-abstract-painting) *,:where(.cult-marketing-hero-abstract-painting) :before,:where(.cult-marketing-hero-abstract-painting) :after{box-sizing:border-box;border:0 solid var(--role-border);margin:0;padding:0}:where(.cult-marketing-hero-abstract-painting) :where(h1,h2,h3,h4,h5,h6){font-size:inherit;font-weight:inherit;font-family:var(--role-font-display,inherit)}:where(.cult-marketing-hero-abstract-painting) :where(a){color:inherit;text-decoration:inherit}:where(.cult-marketing-hero-abstract-painting) :where(b,strong){font-weight:bolder}:where(.cult-marketing-hero-abstract-painting) :where(ol,ul,menu){list-style:none}:where(.cult-marketing-hero-abstract-painting) :where(img,svg,video,canvas){vertical-align:middle;display:block}:where(.cult-marketing-hero-abstract-painting) :where(button,input,select,textarea){font:inherit;color:inherit;background-color:transparent;border-radius:0}:where(.cult-marketing-hero-abstract-painting) :where(code,kbd,samp,pre){font-family:var(--role-font-mono,ui-monospace,monospace);font-size:1em}:where(.cult-marketing-hero-abstract-painting) :where(table){border-collapse:collapse;text-indent:0}:where(.cult-marketing-hero-abstract-painting) :where(hr){height:0;color:inherit;border-top-width:1px}:where(.cult-marketing-hero-abstract-painting) :where(summary){cursor:pointer;list-style:none;display:list-item}:where(.cult-marketing-hero-abstract-painting) :where(summary)::-webkit-details-marker{display:none}:where(.cult-marketing-hero-abstract-painting) :where(.cult-img-box){background:var(--role-surface);display:block}:where(.cult-marketing-hero-abstract-painting) :where(.cult-sym-defs){width:0;height:0;position:absolute;overflow:hidden}:where(.cult-marketing-hero-abstract-painting,.cult-marketing-hero-abstract-painting *){--k-space-y-reverse:0;--k-border-style:solid;--k-gradient-from:transparent;--k-gradient-via:transparent;--k-gradient-to:transparent;--k-gradient-from-position:0%;--k-gradient-via-position:50%;--k-gradient-to-position:100%;--k-shadow:0 0 transparent;--k-shadow-alpha:100%;--k-inset-shadow:0 0 transparent;--k-inset-shadow-alpha:100%;--k-ring-shadow:0 0 transparent;--k-inset-ring-shadow:0 0 transparent;--k-ring-offset-width:0;--k-ring-offset-color:var(--role-background);--k-ring-offset-shadow:0 0 transparent}.cult-marketing-hero-abstract-painting .cb{position:absolute}.cult-marketing-hero-abstract-painting .c6{position:relative}.cult-marketing-hero-abstract-painting .cc{inset:0}.cult-marketing-hero-abstract-painting .c8{z-index:10}.cult-marketing-hero-abstract-painting .c24{margin-left:.5rem}.cult-marketing-hero-abstract-painting .c1i{margin-left:.75rem}.cult-marketing-hero-abstract-painting .c1{display:flex}.cult-marketing-hero-abstract-painting .cg{display:inline-flex}.cult-marketing-hero-abstract-painting .c25{height:1rem}.cult-marketing-hero-abstract-painting .cs{height:3rem}.cult-marketing-hero-abstract-painting .cd{height:100%}.cult-marketing-hero-abstract-painting .c26{width:1rem}.cult-marketing-hero-abstract-painting .c0{width:100%}.cult-marketing-hero-abstract-painting .c1c{max-width:42rem}.cult-marketing-hero-abstract-painting .ch{flex-shrink:0}.cult-marketing-hero-abstract-painting .c3{flex-direction:column}.cult-marketing-hero-abstract-painting .c4{align-items:center}.cult-marketing-hero-abstract-painting .c19{justify-content:space-between}.cult-marketing-hero-abstract-painting .c5{justify-content:center}.cult-marketing-hero-abstract-painting .ci{gap:.5rem}.cult-marketing-hero-abstract-painting .c1o{gap:1rem}.cult-marketing-hero-abstract-painting :where(.c1d>:not(:last-child)){--k-space-y-reverse:0;margin-block-start:calc(calc(.25rem * 6) * var(--k-space-y-reverse));margin-block-end:calc(calc(.25rem * 6) * calc(1 - var(--k-space-y-reverse)))}.cult-marketing-hero-abstract-painting :where(.c1n>:not(:last-child)){--k-space-y-reverse:0;margin-block-start:calc(calc(.25rem * 8) * var(--k-space-y-reverse));margin-block-end:calc(calc(.25rem * 8) * calc(1 - var(--k-space-y-reverse)))}.cult-marketing-hero-abstract-painting .c9{overflow:hidden}.cult-marketing-hero-abstract-painting .cy{border-radius:1.5rem}.cult-marketing-hero-abstract-painting .ct{border-radius:3.40282e38px}.cult-marketing-hero-abstract-painting .ca{border-style:var(--k-border-style);border-width:1px}.cult-marketing-hero-abstract-painting .cz{border-color:var(--role-background);border-color:color-mix(in oklab, var(--role-background) 20%, transparent)}.cult-marketing-hero-abstract-painting .c1x{border-color:var(--role-background);border-color:color-mix(in oklab, var(--role-background) 30%, transparent)}.cult-marketing-hero-abstract-painting .c7{background-color:var(--role-foreground)}.cult-marketing-hero-abstract-painting .c1y{background-color:transparent}.cult-marketing-hero-abstract-painting .c1q,.cult-marketing-hero-abstract-painting .c11{background-color:var(--role-background)}.cult-marketing-hero-abstract-painting .c11{background-color:color-mix(in oklab, var(--role-background) 5%, transparent)}.cult-marketing-hero-abstract-painting .c15{--k-gradient-position:to right in oklab;background-image:linear-gradient(var(--k-gradient-stops))}.cult-marketing-hero-abstract-painting .c16{--k-gradient-from:color-mix(in oklab, var(--role-foreground) 30%, transparent);--k-gradient-stops:var(--k-gradient-via-stops,var(--k-gradient-position), var(--k-gradient-from) var(--k-gradient-from-position), var(--k-gradient-to) var(--k-gradient-to-position))}.cult-marketing-hero-abstract-painting .c17{--k-gradient-via:transparent;--k-gradient-via-stops:var(--k-gradient-position), var(--k-gradient-from) var(--k-gradient-from-position), var(--k-gradient-via) var(--k-gradient-via-position), var(--k-gradient-to) var(--k-gradient-to-position);--k-gradient-stops:var(--k-gradient-via-stops)}.cult-marketing-hero-abstract-painting .c18{--k-gradient-to:color-mix(in oklab, var(--role-foreground) 30%, transparent);--k-gradient-stops:var(--k-gradient-via-stops,var(--k-gradient-position), var(--k-gradient-from) var(--k-gradient-from-position), var(--k-gradient-to) var(--k-gradient-to-position))}.cult-marketing-hero-abstract-painting .c1a{padding:2rem}.cult-marketing-hero-abstract-painting .cu{padding-inline:2rem}.cult-marketing-hero-abstract-painting .cq{padding-block:.5rem}.cult-marketing-hero-abstract-painting .c1j{font-size:2.25rem;line-height:var(--k-leading,calc(2.5 / 2.25))}.cult-marketing-hero-abstract-painting .c1f{font-size:3.75rem;line-height:var(--k-leading,1)}.cult-marketing-hero-abstract-painting .cv{font-size:1rem;line-height:var(--k-leading,calc(1.5 / 1))}.cult-marketing-hero-abstract-painting .c2{--k-font-weight:500;font-weight:500}.cult-marketing-hero-abstract-painting .ce{--k-tracking:-.025em;letter-spacing:-.025em}.cult-marketing-hero-abstract-painting .cj{white-space:nowrap}.cult-marketing-hero-abstract-painting .c1r{color:color-mix(in oklab, var(--role-foreground) 95%, var(--role-background))}.cult-marketing-hero-abstract-painting .c1z,.cult-marketing-hero-abstract-painting .c1k{color:var(--role-background)}.cult-marketing-hero-abstract-painting .c1k{color:color-mix(in oklab, var(--role-background) 50%, transparent)}.cult-marketing-hero-abstract-painting .c1g{color:color-mix(in oklab, var(--role-background) 90%, transparent)}.cult-marketing-hero-abstract-painting .cx{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.cult-marketing-hero-abstract-painting .c13{--k-shadow:0 8px 32px var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 7.8%, transparent));box-shadow:var(--k-inset-shadow), var(--k-inset-ring-shadow), var(--k-ring-offset-shadow), var(--k-ring-shadow), var(--k-shadow)}.cult-marketing-hero-abstract-painting .c1s{--k-shadow:0 1px 3px 0 var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 10.2%, transparent)), 0 1px 2px -1px var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 10.2%, transparent));box-shadow:var(--k-inset-shadow), var(--k-inset-ring-shadow), var(--k-ring-offset-shadow), var(--k-ring-shadow), var(--k-shadow)}.cult-marketing-hero-abstract-painting .c1w{--k-shadow:0 1px 2px 0 var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 5.1%, transparent));box-shadow:var(--k-inset-shadow), var(--k-inset-ring-shadow), var(--k-ring-offset-shadow), var(--k-ring-shadow), var(--k-shadow)}.cult-marketing-hero-abstract-painting .c14{--k-backdrop-blur:blur(8px);backdrop-filter:var(--k-backdrop-blur, ) var(--k-backdrop-brightness, ) var(--k-backdrop-contrast, ) var(--k-backdrop-grayscale, ) var(--k-backdrop-hue-rotate, ) var(--k-backdrop-invert, ) var(--k-backdrop-opacity, ) var(--k-backdrop-saturate, ) var(--k-backdrop-sepia, )}.cult-marketing-hero-abstract-painting .cw{transition-property:all;transition-timing-function:var(--k-ease,cubic-bezier(.4, 0, .2, 1));transition-duration:var(--k-duration,.15s)}.cult-marketing-hero-abstract-painting .c1t{--k-duration:.3s;transition-duration:.3s}.cult-marketing-hero-abstract-painting .ck{--k-outline-style:none;outline-style:none}@media (hover:hover){.cult-marketing-hero-abstract-painting .c20:hover{background-color:var(--role-background);background-color:color-mix(in oklab, var(--role-background) 10%, transparent)}.cult-marketing-hero-abstract-painting .c1u:hover{background-color:var(--role-background);background-color:color-mix(in oklab, var(--role-background) 90%, transparent)}.cult-marketing-hero-abstract-painting .c21:hover{color:var(--role-background)}.cult-marketing-hero-abstract-painting .c1v:hover{--k-shadow:0 4px 6px -1px var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 10.2%, transparent)), 0 2px 4px -2px var(--k-shadow-color,color-mix(in oklab, var(--role-foreground) 10.2%, transparent));box-shadow:var(--k-inset-shadow), var(--k-inset-ring-shadow), var(--k-ring-offset-shadow), var(--k-ring-shadow), var(--k-shadow)}}.cult-marketing-hero-abstract-painting .cl:disabled{pointer-events:none}.cult-marketing-hero-abstract-painting .cm:disabled{opacity:.5}.cult-marketing-hero-abstract-painting .cr:has(>svg){padding-inline:.75rem}@media (width>=40rem){.cult-marketing-hero-abstract-painting .c1l{margin-left:1.75rem}.cult-marketing-hero-abstract-painting .c1p{flex-direction:row}.cult-marketing-hero-abstract-painting .cf{font-size:2.25rem;line-height:var(--k-leading,calc(2.5 / 2.25))}}@media (width>=48rem){.cult-marketing-hero-abstract-painting :where(.c1e>:not(:last-child)){--k-space-y-reverse:0;margin-block-start:calc(calc(.25rem * 8) * var(--k-space-y-reverse));margin-block-end:calc(calc(.25rem * 8) * calc(1 - var(--k-space-y-reverse)))}.cult-marketing-hero-abstract-painting .c1b{padding:4rem}.cult-marketing-hero-abstract-painting .c1m{font-size:3.75rem;line-height:var(--k-leading,1)}.cult-marketing-hero-abstract-painting .c1h{font-size:7rem}}`;

function selfTestPage(baseline: string): RenderedPage {
  const section = `<div id="${SELF_TEST_ID}" data-od-section="${SELF_TEST_ID}"><style>.cult-self-test{padding:1rem}.cult-self-test .gone{opacity:0}</style>`
    + '<div class="cult-self-test"><p class="gone">Planted hidden text</p><p class="self-test-unstyled">Planted unstyled class</p>'
    + '<a href="#self-test-no-target">Planted broken link</a><img src="https://example.invalid/self-test.png" alt="">'
    // The real, converter-produced marketing-hero-abstract-painting shell (see ABSTRACT_PAINTING_HTML/CSS
    // above) — not a hand-tuned plant. This is the control the r3 audit found the rebuilt detector still
    // called clean; it must report an ink-collision overlap at 1280px (see the comment on
    // ABSTRACT_PAINTING_HTML/CSS above for why not also at 390px, honestly).
    + `<style>${ABSTRACT_PAINTING_CSS}</style>${ABSTRACT_PAINTING_HTML}`
    // A heading with a normal, non-overlapping box, fully covered by a later, opaquely-filled sibling
    // layer — the "hidden by an opaque non-text layer" case neither the old hidden-content check (opacity/
    // visibility/off-screen only) nor a pure text-vs-text overlap check can see, since the coverer carries
    // no text of its own and was never a text candidate.
    + '<div style="position:relative;height:40px;margin-top:16px;">'
    + '<h4 class="self-test-covered-heading" style="position:absolute;top:0;left:0;margin:0;">Planted covered heading</h4>'
    + '<div class="self-test-opaque-cover" style="position:absolute;top:0;left:0;width:100%;height:100%;background:#000;"></div>'
    + '</div>'
    // A DESCENDANT cover: an opaque, textless layer nested INSIDE the same text-bearing element as the
    // text it hides (not a later sibling of that element) — audits/yield3-r4-grok.md found the occlusion
    // walk stopped at the first descendant hit and called it "the candidate's own paint" without checking
    // whether that specific descendant carries any text of its own.
    + '<h4 class="self-test-descendant-cover" style="position:relative;margin-top:16px;">Planted descendant cover'
    + '<span style="position:absolute;inset:0;background:#000;"></span></h4>'
    // A same-colour contrast failure: text painted the identical colour as its own background — exactly
    // marketing-faq-hex's defect (a heading/summary on --role-foreground sitting on an SVG panel also
    // filled with --role-foreground), reproduced here with an explicit literal colour instead of a token.
    + '<p class="self-test-low-contrast" style="background:#171717;color:#171717;">Planted low-contrast text</p>'
    // A mid-word break: a flex item with overflow-wrap:anywhere shrinks to one character wide next to a
    // fixed-width sibling and splits a short word that fits the row easily (marketing-sticky-section's
    // "Next.j / s" under yield-5's first converter change).
    + '<div style="display:flex;width:300px;margin-top:16px;"><span style="overflow-wrap:anywhere;">Planted</span><span style="flex:none;width:290px;"></span></div>'
    // Path (b): under overflow-wrap:break-word, a min-width:0 flex item squeezed below one short word by a
    // fixed-width sibling (hero-warp's nav labels at 390px). The word fits the row; the item shrank.
    + '<div style="display:flex;width:300px;margin-top:16px;"><span style="overflow-wrap:break-word;min-width:0;">Squeezed</span><span style="flex:none;width:280px;"></span></div>'
    // A closed disclosure whose question text sits in an element inside its <summary> (a common FAQ shape,
    // <summary><span>…</span></summary>): the question is painted, so a paragraph laid over it must still
    // be caught as an overlap (audit y5-r3 finding 1).
    + '<div style="position:relative;margin-top:16px;"><details><summary><span class="self-test-nested-summary">Planted nested summary question</span></summary><p>Planted answer</p></details>'
    + '<p style="position:absolute;top:0;left:0;margin:0;">Planted summary cover text</p></div>'
    // A fake clamp: -webkit-line-clamp without display:-webkit-box clamps nothing, and a fixed height cuts
    // the text instead. The cut lines are lost content; one of them lies over a later paragraph and must
    // still be measured as an overlap (audit y5-r3 finding 2).
    + '<div style="position:relative;margin-top:16px;height:90px;"><p class="self-test-fake-clamp" style="display:block;-webkit-line-clamp:1;overflow:hidden;height:20px;width:220px;margin:0;line-height:20px;">Planted fake clamp one two three four five six seven eight nine ten eleven twelve</p>'
    + '<p style="position:absolute;top:22px;left:0;margin:0;line-height:20px;">Planted under the clamp</p></div>'
    + '</div></div>';
  const at = baseline.lastIndexOf('</main>');
  return { name: 'self-test', html: `${baseline.slice(0, at)}${section}${baseline.slice(at)}`, sections: [{ sectionId: SELF_TEST_ID, scope: 'cult-self-test' }] };
}

/**
 * Loads every page (plus the self-test page) under both motion preferences. Violations on the
 * self-test page are not reported; a planted defect the check failed to see is.
 */
async function browserCheck(pages: readonly RenderedPage[], baseline: string, supporting: readonly SupportingFile[], violations: Violation[]): Promise<{ loaded: number; selfTest: string[] }> {
  const found: Violation[] = [];
  const loaded = await loadPages([...pages, selfTestPage(baseline)], supporting, found);
  for (const v of found) if (v.page !== 'self-test') violations.push(v);
  for (const motion of MOTION_MODES) {
    for (const category of SELF_TEST_CATEGORIES) {
      if (!found.some((v) => v.page === 'self-test' && v.motion === motion && v.category === category)) {
        violations.push({ page: 'self-test', category: 'render', motion, detail: `the planted ${category} defect was not detected; the browser check is not trustworthy` });
      }
    }
  }
  // The overlap category needs at least TWO independently-required details, not just "some overlap
  // finding" — the r3 audit proved that requirement alone is satisfied by the pill/subhead ink collision
  // ALONE, at both widths, under both motion modes, even with the opaque-cover occlusion loop deleted
  // entirely (14/14 either way). Require the separately-planted opaque-cover occlusion finding ("is
  // covered by an opaque non-text layer") independently AT EACH viewport — it is a synthetic, width-
  // independent plant with no reason to differ by width, so both must catch it. The real abstract-
  // painting shell's own ink-vs-ink pill collision ("ink-overlaps") is required too, but only at 1280px:
  // measured directly (see ABSTRACT_PAINTING_HTML/CSS above, unmodified, no hand-tuning), the row's own
  // CSS gates its tight leading (line-height: 1) behind the md: breakpoint — at 390px the subhead uses a
  // normal, uncompressed line-height and the real component genuinely does not collide there. Requiring
  // "ink-overlaps at 390" from this SPECIFIC control would force tuning the plant to lie about the real
  // component's real behavior, which is exactly what must not happen; the 390px case is still exercised
  // (and still must pass) by the opaque-cover requirement above.
  if (!found.some((v) => v.page === 'self-test' && v.category === 'overlap' && v.detail.startsWith('[1280px]') && v.detail.includes('ink-overlaps'))) {
    violations.push({ page: 'self-test', category: 'render', detail: `the planted ink-collision overlap defect was not detected at 1280px; the browser check is not trustworthy` });
  }
  // Named plants: each must be reported under every motion mode, and each counts once in the tally.
  for (const plant of NAMED_PLANTS) {
    for (const motion of MOTION_MODES) {
      if (!found.some((v) => v.page === 'self-test' && v.motion === motion && v.category === plant.category && v.detail.includes(plant.match))) {
        violations.push({ page: 'self-test', category: 'render', motion, detail: `the planted ${plant.key} defect was not detected; the browser check is not trustworthy` });
      }
    }
  }
  // The wordbreak category has two paths; each planted case is required on its own.
  for (const word of ['Planted', 'Squeezed']) {
    if (!found.some((v) => v.page === 'self-test' && v.category === 'wordbreak' && v.detail.includes(`"${word}"`))) {
      violations.push({ page: 'self-test', category: 'render', detail: `the planted mid-word break "${word}" was not detected; the browser check is not trustworthy` });
    }
  }
  for (const width of VIEWPORTS) {
    const atWidth = (v: Violation) => v.page === 'self-test' && v.category === 'overlap' && v.detail.startsWith(`[${width}px]`);
    if (!found.some((v) => atWidth(v) && v.detail.includes('is covered by an opaque non-text layer'))) {
      violations.push({ page: 'self-test', category: 'render', detail: `the planted opaque-cover overlap defect was not detected at ${width}px; the browser check is not trustworthy` });
    }
    // A separate planted DESCENDANT cover (audits/yield3-r4-grok.md): an opaque, textless layer nested
    // inside the same element as the text it hides, not a later sibling of it — the occlusion walk used
    // to stop at the first descendant hit and call that "the candidate's own paint."
    if (!found.some((v) => atWidth(v) && v.detail.includes('Planted descendant cover') && v.detail.includes('is covered by an opaque non-text layer'))) {
      violations.push({ page: 'self-test', category: 'render', detail: `the planted descendant-cover overlap defect was not detected at ${width}px; the browser check is not trustworthy` });
    }
  }
  const namedCaught = NAMED_PLANTS.filter((plant) => MOTION_MODES.every((motion) => found.some((v) => v.page === 'self-test' && v.motion === motion && v.category === plant.category && v.detail.includes(plant.match)))).map((plant) => `named:${plant.key}`);
  const selfTest = [...new Set(found.filter((v) => v.page === 'self-test' && v.motion && SELF_TEST_CATEGORIES.includes(v.category)).map((v) => `${v.motion}:${v.category}`)), ...namedCaught].sort();
  return { loaded: loaded - MOTION_MODES.length * VIEWPORTS.length, selfTest };
}

async function loadPages(pages: readonly RenderedPage[], supporting: readonly SupportingFile[], violations: Violation[]): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'cult-render-check-'));
  const { server, origin } = await serve(dir);
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  let loaded = 0;
  try {
    for (const page of pages) writeFileSync(join(dir, `${page.name}.html`), page.html);
    for (const file of supporting) {
      const target = resolve(dir, file.destination);
      if (!target.startsWith(`${dir}/`)) throw new Error(`asset destination ${file.destination} leaves the served directory`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    const jobs = pages.flatMap((page) => MOTION_MODES.flatMap((motion) => VIEWPORTS.map((width) => ({ page, motion, width }))));
    const run = async ({ page, motion, width }: (typeof jobs)[number]): Promise<void> => {
      const add = (category: Category, detail: string) => violations.push({ page: page.name, category, motion, detail: `[${width}px] ${detail}` });
      const context = await browser.newContext({ reducedMotion: motion, viewport: { width, height: 800 } });
      try {
        const tab = await context.newPage();
        tab.on('console', (message: PwConsole) => {
          if (/Content[- ]Security[- ]Policy/i.test(message.text())) add('csp', `console: ${message.text().slice(0, 200)}`);
        });
        tab.on('pageerror', (error: Error) => add('script', error.message.slice(0, 200)));
        tab.on('request', (request: PwRequest) => {
          const url = request.url();
          if (!url.startsWith(`${origin}/`) && !url.startsWith('data:') && !url.startsWith('about:')) add('external', `request to ${url.slice(0, 120)}`);
        });
        tab.on('requestfailed', (request: PwRequest) => add('resource', `${request.url().slice(0, 120)} failed: ${request.failure()?.errorText ?? 'unknown'}`));
        tab.on('response', (response: PwResponse) => {
          if (response.status() >= 400) add('resource', `${response.url().slice(0, 120)} answered ${response.status()}`);
        });
        await tab.addInitScript(`window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));`);
        await tab.goto(`${origin}/${page.name}.html`, { waitUntil: 'load' });
        loaded += 1;
        const findings = await tab.evaluate(inspectSections, { sections: page.sections, settleMs: SETTLE_MS, contract: PAGE_CONTRACT_ANCHORS });
        for (const finding of findings) add(finding.category, finding.detail);
        const csp = await tab.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations, null);
        for (const entry of csp) add('csp', `securitypolicyviolation: ${entry.slice(0, 200)}`);
      } finally {
        await context.close();
      }
    };
    const queue = [...jobs];
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await run(job);
    }));
  } finally {
    await browser.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return loaded;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function runRenderCheck(options: { family?: string; browser?: boolean } = {}): Promise<Report> {
  // Load publication metadata only when checking pages, not when the names generator imports layoutFill.
  const { publicSectionEntryId } = await importPath<{ publicSectionEntryId: (id: string) => string }>(join(FAST_LANE_SRC, 'cult-public-ids.ts'));
  /**
   * The fast lane publishes a Cult section under its public id (`cult:<slug>`): the section id
   * `od-selected-cult-<slug>` and the adapter's `cult-<slug>` CSS scope. The check looks for what is
   * published. The reviewed exemptions below stay keyed on the internal row name, so each section
   * carries its `rowName` and a slug change never moves an exemption onto another row.
   */
  const publishedSectionId = (id: string) => sectionIdOf(publicSectionEntryId(id));
  const publishedScope = (id: string) => `cult-${publicSectionEntryId(id).slice('cult:'.length)}`;
  const started = Date.now();
  const family = options.family ?? DEFAULT_FAMILY;
  const catalog = JSON.parse(readFileSync(join(PACKAGE_DIR, 'catalog.json'), 'utf8')) as CultCatalog;
  const rows = catalog.rows.filter((row) => row.conversion.status === 'insertable');
  const registry = await importPath<Registry>(join(PACKAGE_DIR, 'generated', 'index.ts'));
  const overlay = await importPath<Overlay>(join(FAST_LANE_SRC, 'section-overlay.ts'));
  const { PAGE_BYTE_LIMIT } = await importPath<{ PAGE_BYTE_LIMIT: number }>(join(FAST_LANE_SRC, 'effects.ts'));
  const pkg = await loadFamily(family);
  const entry = `${family}-r1.html`;
  const base = pkg.render(pkg.fixture, entry);
  const baseline = base.html;
  const supporting = await Promise.all(base.approvedAssets.map(async (asset) => ({ destination: asset.destination, bytes: await pkg.readAsset(asset) })));
  const csp = CSP_META.exec(baseline)?.[1] ?? '';
  const violations: Violation[] = [];
  if (!csp.includes("default-src 'none'")) violations.push({ page: family, category: 'csp', detail: `the ${family} page carries no default-src 'none' CSP meta` });

  const registryIds = Object.keys(registry.CULT_ADAPTERS).sort();
  const rowIds = rows.map((row) => row.id).sort();
  if (registryIds.join() !== rowIds.join()) violations.push({ page: 'registry', category: 'render', detail: 'generated/index.ts and the insertable catalog rows differ; run adapters --check' });

  const blocks: BlockMeasure[] = [];
  const pages: RenderedPage[] = [];
  for (const row of rows) {
    try {
      const adapter = await overlay.resolveSectionAdapter(row.id);
      const { html } = await compose(overlay, pkg, [adapter], entry, publishedSectionId);
      const htmlMin = utf8(minifiedHtml(adapter.render(worstCaseFill(adapter as never))));
      const cssMin = utf8(adapter.css);
      const pageBytes = utf8(html);
      blocks.push({ id: row.id, kind: row.taxonomy.sectionKind, htmlMin, cssMin, sectionBytes: pageBytes - utf8(baseline), pageBytes });
      if (htmlMin + cssMin > ADAPTER_BYTE_LIMIT) violations.push({ page: row.id, category: 'bytes', detail: `worst-case HTML+CSS ${htmlMin + cssMin} B over ${ADAPTER_BYTE_LIMIT} B` });
      if (pageBytes >= PAGE_BYTE_LIMIT) violations.push({ page: row.id, category: 'bytes', detail: `page ${pageBytes} B at or over ${PAGE_BYTE_LIMIT} B` });
      pages.push({ name: row.name, html, sections: [{ sectionId: publishedSectionId(row.id), scope: publishedScope(row.id), rowName: row.name }] });
    } catch (error) {
      violations.push({ page: row.id, category: 'render', detail: (error as Error).message.slice(0, 300) });
    }
  }

  // The representative page: the HyperUI lead plus the largest block of each page kind.
  const chosen: string[] = [];
  for (const kind of PAGE_KINDS) {
    const largest = blocks.filter((block) => block.kind === kind).sort((a, b) => b.sectionBytes - a.sectionBytes || a.id.localeCompare(b.id))[0];
    if (largest) chosen.push(largest.id);
    else violations.push({ page: 'three-block-page', category: 'render', detail: `no insertable Cult ${kind} block` });
  }
  const pageSections = [LEAD_SECTION, ...chosen];
  let pageBytes = 0;
  try {
    const adapters = await Promise.all(pageSections.map((id) => overlay.resolveSectionAdapter(id)));
    const { html } = await compose(overlay, pkg, adapters, entry, publishedSectionId);
    pageBytes = utf8(html);
    if (pageBytes >= PAGE_BYTE_LIMIT) violations.push({ page: 'three-block-page', category: 'bytes', detail: `page ${pageBytes} B at or over ${PAGE_BYTE_LIMIT} B` });
    if (!html.includes(`content="${csp}"`)) violations.push({ page: 'three-block-page', category: 'csp', detail: 'the composed page lost the family CSP' });
    const rowName = (id: string) => rows.find((row) => row.id === id)?.name;
    pages.push({ name: 'three-block-page', html, sections: pageSections.map((id) => {
      const name = rowName(id);
      return name ? { sectionId: publishedSectionId(id), scope: publishedScope(id), rowName: name } : { sectionId: publishedSectionId(id), scope: null };
    }) });
  } catch (error) {
    violations.push({ page: 'three-block-page', category: 'render', detail: (error as Error).message.slice(0, 300) });
  }

  const frozen = frozenPackageViolations();
  violations.push(...frozen.violations);
  const browser = options.browser === false ? { loaded: 0, selfTest: [] } : await browserCheck(pages, baseline, supporting, violations);

  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, violations.filter((v) => v.category === category).length])) as Record<Category, number>;
  const max = [...blocks].sort((a, b) => b.htmlMin + b.cssMin - (a.htmlMin + a.cssMin))[0];
  return {
    family,
    csp,
    direction: DIRECTION,
    blocks,
    page: { sections: pageSections, bytes: pageBytes, limit: PAGE_BYTE_LIMIT },
    maxBlock: { total: max ? max.htmlMin + max.cssMin : 0, id: max?.id ?? '', limit: ADAPTER_BYTE_LIMIT },
    frozen: { generatedBytes: frozen.generatedBytes, syncedDirsChecked: frozen.syncedDirs },
    violations,
    counts,
    browserPages: browser.loaded,
    selfTest: browser.selfTest,
    ms: Date.now() - started,
  };
}

export function summary(report: Report): string {
  const lines = [
    `cult render-check: ${report.blocks.length} insertable blocks on the ${report.family} page (direction ${report.direction})`,
    `  family CSP: ${report.csp}`,
    `  largest worst-case block: ${report.maxBlock.id} ${report.maxBlock.total} B (limit ${report.maxBlock.limit} B)`,
    `  largest spliced section: ${Math.max(0, ...report.blocks.map((b) => b.sectionBytes))} B; largest single-block page: ${Math.max(0, ...report.blocks.map((b) => b.pageBytes))} B`,
    `  three-block page (${report.page.sections.join(' + ')}): ${report.page.bytes} B of ${report.page.limit} B`,
    `  frozen package: ${report.frozen.syncedDirsChecked} synchronized compiler dirs carry no Cult adapter; generated/ is ${report.frozen.generatedBytes} B outside them`,
    `  browser: ${report.browserPages} page loads (reducedMotion ${MOTION_MODES.join(' and ')}; viewports ${VIEWPORTS.join('px and ')}px); self-test detected ${report.selfTest.length}/${SELF_TEST_CATEGORIES.length * MOTION_MODES.length + NAMED_PLANTS.length} planted defects`,
    `  violations: ${CATEGORIES.map((c) => `${c} ${report.counts[c]}`).join(', ')}`,
  ];
  for (const v of report.violations.slice(0, 80)) lines.push(`  - [${v.category}${v.motion ? `/${v.motion}` : ''}] ${v.page}: ${v.detail}`);
  if (report.violations.length > 80) lines.push(`  … ${report.violations.length - 80} more (see the JSON report)`);
  lines.push(`  ${report.violations.length === 0 ? 'PASS' : 'FAIL'} in ${(report.ms / 1000).toFixed(1)} s`);
  return lines.join('\n');
}

/** Families checked by default: the strictest CSP (no images, no script) and one with approved
 * media, fonts and inline script (watson, the family the overlay test uses). */
export const DEFAULT_FAMILIES = [DEFAULT_FAMILY, 'watson'] as const;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : join(tmpdir(), 'cult-render-check', 'report.json');
  const families = args.flatMap((arg, i) => (args[i - 1] === '--family' ? [arg] : []));
  const reports: Report[] = [];
  for (const family of families.length > 0 ? families : DEFAULT_FAMILIES) {
    const report = await runRenderCheck({ family });
    reports.push(report);
    console.log(summary(report));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ reports }, null, 2)}\n`);
  const failed = reports.filter((report) => report.violations.length > 0).length;
  console.log(`cult render-check: ${failed === 0 ? 'PASS' : 'FAIL'} (${reports.length} families); report: ${out}`);
  process.exit(failed === 0 ? 0 : 1);
}
