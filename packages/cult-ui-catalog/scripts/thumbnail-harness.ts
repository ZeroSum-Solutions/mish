/**
 * Renders one Cult UI Pro item from the private source kit to a PNG, for its Catalog tab thumbnail.
 * `scripts/thumbnails.ts` drives it; nothing here runs in the product.
 *
 * It reuses the kit converter's own stages, read-only, so a thumbnail looks like the existing
 * converter previews (same shims, same Tailwind build, same neutral `--role-*` light palette):
 *
 *   - `renderPage` (the item has a page.tsx): the kit's `renderBlock` (React SSR, no JS), the kit's
 *     `compileTailwind`, then the kit's `page()` + `check()` screenshot with JS off. This is how the
 *     converter makes `converted/<name>/preview-source.png`.
 *   - `renderClient` (a demo item, or a page whose server render fails on a server-only package):
 *     the module is bundled for the browser with the kit's shims (server, WebGL and unknown packages
 *     stubbed), mounted with JS on so mount effects run, its DOM compiled with the kit's Tailwind
 *     build and styled in place, then screenshotted. The page has no network.
 *
 * The kit's converter files are imported, never edited. CULT_KIT_DIR (default
 * ~/projects/mm-source-kits/cult-ui-pro) names the kit; PLAYWRIGHT_MODULE overrides the workspace's
 * Playwright copy.
 */

import { findRealTagEnd } from '@open-design/contracts/runtime/html-injection-points';

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KIT_DIR = process.env.CULT_KIT_DIR ?? join(homedir(), 'projects', 'mm-source-kits', 'cult-ui-pro');
const KIT_SCRIPTS = join(KIT_DIR, 'scripts');
const KIT_SRC = join(KIT_DIR, 'src');
const SHIMS = join(KIT_SCRIPTS, 'shims');
// A handful of kit items assume a shared `@/components/ai-elements/*` library (Vercel's "AI
// Elements", a generic shadcn-style OSS component set) is already installed in the app they were
// captured from — the kit itself never vendored it, since it isn't Cult UI Pro's own content.
// `AI_ELEMENTS_DIR` (default: the sibling `cult-ui-pro-preview` live-preview harness's own local,
// non-licensed copy of the same library, kept there for the same reason) fills that gap when
// present; a missing directory falls back to the existing generic stub, unchanged, so a CI
// checkout with no kit and no sibling harness on disk is unaffected.
const AI_ELEMENTS_DIR = process.env.AI_ELEMENTS_DIR
  ?? join(dirname(KIT_DIR), 'cult-ui-pro-preview', 'src', 'components', 'ai-elements');
// AI_ELEMENTS_DIR's own files import their `@/*` siblings (e.g. `@/components/ui/input-group`,
// `@/lib/utils`) against ITS OWN tsconfig root (the sibling harness repo's `src/`), not the
// licensed kit's. Resolving those through the kit's `@/components/ui/*` shim lookup below finds
// nothing (the shim set only covers the licensed kit's own primitives) and silently stubs them,
// which is how a real, present component like `InputGroup` rendered as empty instead of its real
// markup. Any importer under this root gets first crack at its own `@/*` tree.
const AI_ELEMENTS_SRC = dirname(dirname(AI_ELEMENTS_DIR));

export const VIEWPORT = { width: 1280, height: 800 } as const;

export type RenderResult = { png: string; text: number } | { error: string };

// Mirrors the kit's render.mjs ALIASES (not exported there): bare imports the kit answers with a shim.
const ALIASES: Record<string, string> = {
  '@/lib/utils': 'utils.js', 'next/link': 'next-link.jsx', 'next/image': 'next-image.jsx', 'next/navigation': 'next-misc.js',
  'next-themes': 'next-misc.js', 'next/dynamic': 'next-dynamic.js', 'motion/react': 'motion.jsx', motion: 'motion.jsx',
  'framer-motion': 'motion.jsx', '@/lib/motion-casts': 'motion-casts.js', 'react-intersection-observer': 'intersection-observer.jsx',
  shiki: 'shiki.js', '@shikijs/transformers': 'shiki.js', '@number-flow/react': 'number-flow.jsx',
  'geist/font/sans': 'next-font.js', 'geist/font/mono': 'next-font.js',
  '@/components/registry-section-root': 'registry-section-root.jsx',
};

// This package's own require, for resolving generic packages the kit does not vendor (see
// `workspaceResolve` below). Bound to this file, not the kit, so it walks THIS package's
// node_modules (and the pnpm store above it) rather than the kit's private converter toolchain.
const packageRequire = createRequire(import.meta.url);

/**
 * Resolve a bare specifier against this package's own dependencies (declared in package.json,
 * e.g. `zod`), for a package the kit's converter does not carry in KIT_SCRIPTS/node_modules.
 * Returns null for anything this package does not itself depend on, so an unlisted package keeps
 * falling through to the inert stub.
 */
export function workspaceResolve(specifier: string): string | null {
  try {
    const resolved = packageRequire.resolve(specifier);
    // A Node built-in (`fs/promises`, `node:fs`, …) resolves to its own bare specifier, not a
    // file path; esbuild's plugin API requires an absolute path for a real (non-namespaced)
    // result, and a component that imports a Node built-in directly cannot render in a browser
    // regardless — fall through to the inert stub, same as before this fallback existed.
    return isAbsolute(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

// The kit's browser.mjs review palette (light), set on :root for the client pass.
const ROLE_CSS = ':root{--role-background:#ffffff;--role-surface:#f4f4f5;--role-foreground:#18181b;--role-muted:#71717a;'
  + '--role-accent:#4f46e5;--role-on-accent:#ffffff;--role-border:#e4e4e7;'
  + '--role-font-display:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;'
  + '--role-font-body:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--role-font-mono:ui-monospace,Menlo,monospace}'
  + 'html,body{margin:0;background:#fff;color:var(--role-foreground);font-family:var(--role-font-body)}'
  + '*,::before,::after{box-sizing:border-box;border:0 solid var(--role-border)}';

// ---- the kit's untyped modules, typed to what this file calls ---------------------------------

interface KitItem { files?: Array<{ path: string; content?: string }> }
interface KitRender {
  renderBlock: (name: string, item: KitItem, outDir: null) => Promise<{ html: string }>;
  WEBGL_PKGS: RegExp[];
  SERVER_PKGS: RegExp[];
}
interface KitCss { compileTailwind: (workDir: string, htmlFile: string) => string }
interface KitBrowser {
  page: (adapter: { id: string; css: string }, innerHtml: string) => string;
  check: (html: string, options: { shot: string }) => Promise<{ metrics: { text: number } }>;
  closeBrowser: () => Promise<void>;
}
interface OnResolveArgs { path: string; importer: string; resolveDir: string; kind: string; pluginData?: { probe?: boolean } }
interface OnResolveResult { path?: string; namespace?: string; pluginData?: unknown; errors?: unknown[] }
interface OnLoadArgs { path: string; pluginData?: { names?: string[] } }
interface PluginBuild {
  onResolve: (o: { filter: RegExp }, cb: (a: OnResolveArgs) => Promise<OnResolveResult | undefined> | OnResolveResult | undefined) => void;
  onLoad: (o: { filter: RegExp; namespace: string }, cb: (a: OnLoadArgs) => { contents: string; loader: string; resolveDir?: string }) => void;
  resolve: (p: string, o: { resolveDir: string; kind: string; importer: string; pluginData: { probe: true } }) => Promise<{ path: string; errors: unknown[] }>;
}
interface Esbuild {
  build: (o: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }> }>;
}
interface PwPage {
  on: (event: 'pageerror', cb: (e: Error) => void) => void;
  setContent: (html: string) => Promise<void>;
  addScriptTag: (o: { content: string }) => Promise<unknown>;
  addStyleTag: (o: { content: string }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForFunction: (fn: () => unknown, arg: undefined, options: { timeout: number }) => Promise<unknown>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (o: { path: string }) => Promise<unknown>;
}
interface PwContext {
  route: (url: RegExp, handler: (route: { abort: () => Promise<void> }) => Promise<void>) => Promise<void>;
  newPage: () => Promise<PwPage>;
  close: () => Promise<void>;
}
interface PwBrowser { newContext: (o: Record<string, unknown>) => Promise<PwContext>; close: () => Promise<void> }

interface Kit { render: KitRender; css: KitCss; browser: KitBrowser; esbuild: Esbuild }
let kitModules: Kit | null = null;
async function kit(): Promise<Kit> {
  if (kitModules) return kitModules;
  const lib = (file: string) => pathToFileURL(join(KIT_SCRIPTS, 'lib', file)).href;
  kitModules = {
    render: await import(lib('render.mjs')) as KitRender,
    css: await import(lib('css.mjs')) as KitCss,
    browser: await import(lib('browser.mjs')) as KitBrowser,
    esbuild: createRequire(join(KIT_SCRIPTS, 'package.json'))('esbuild') as Esbuild,
  };
  return kitModules;
}

// Playwright is a workspace dev dependency (e2e), not this package's; use the workspace's pinned copy.
function playwrightModule(): string {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  const store = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.pnpm');
  const dir = existsSync(store) ? readdirSync(store).filter((d) => /^playwright@\d/.test(d)).sort().pop() : undefined;
  if (!dir) throw new Error('playwright is not installed in the workspace; run pnpm install or set PLAYWRIGHT_MODULE');
  return join(store, dir, 'node_modules', 'playwright', 'index.mjs');
}

let browser: PwBrowser | null = null;
async function chromium(): Promise<PwBrowser> {
  if (!browser) {
    const pw = await import(pathToFileURL(playwrightModule()).href) as {
      chromium: { launch: (o?: { args?: string[] }) => Promise<PwBrowser> };
    };
    // Playwright's bundled Chromium can rasterize real WebGL headlessly through ANGLE's
    // SwiftShader software backend — no GPU needed. Without these flags Chromium's headless
    // WebGL context creation silently fails, so a globe/shader item's own canvas draws nothing
    // even when its real library code runs (unstubbed, see WEBGL_PKGS resolution below): the
    // canvas exists and the DOM is non-empty, but the pixels are blank.
    browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  }
  return browser;
}

export async function closeHarness(): Promise<void> {
  await browser?.close();
  browser = null;
  if (kitModules) await kitModules.browser.closeBrowser();
}

/** Screenshot the real local converted frame without executing scripts or allowing network. */
export async function renderConverted(name: string, pngPath: string, daemonUrl: string): Promise<RenderResult> {
  const base = new URL(daemonUrl);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    return { error: 'preview daemon must be a loopback HTTP origin' };
  }
  const response = await fetch(new URL(`/api/cult/preview/${encodeURIComponent(`cult:${name}`)}/frame?theme=light`, base), { redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return { error: `converted preview answered ${response.status}` };
  const html = await response.text();
  const ctx = await (await chromium()).newContext({ viewport: VIEWPORT, javaScriptEnabled: false, reducedMotion: 'reduce' });
  try {
    await ctx.route(/^https?:/, (route) => route.abort());
    const page = await ctx.newPage();
    await page.setContent(html);
    const text = await page.evaluate(() => document.body.textContent?.trim().length ?? 0);
    await page.screenshot({ path: pngPath });
    return { png: pngPath, text };
  } finally { await ctx.close(); }
}

export function kitPresent(): boolean {
  return existsSync(join(KIT_DIR, 'registry')) && existsSync(join(KIT_SCRIPTS, 'lib', 'render.mjs'));
}

function kitItem(name: string): KitItem | null {
  const file = join(KIT_DIR, 'registry', `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as KitItem : null;
}

function walkFiles(root: string, visit: (file: string) => void): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) stack.push(f);
      else visit(f);
    }
  }
}

/** The item's entry page (app/page.tsx first, then the shallowest page.tsx), or null. */
export function pageEntry(name: string): string | null {
  const pages: string[] = [];
  walkFiles(join(KIT_SRC, name), (f) => { if (f.endsWith(`${sep}page.tsx`)) pages.push(f); });
  pages.sort((a, b) => (Number(b.includes('/app/')) - Number(a.includes('/app/'))) || a.split('/').length - b.split('/').length);
  return pages[0] ?? null;
}

/** A demo item's module: its one React file. */
export function moduleEntry(name: string): string | null {
  const file = (kitItem(name)?.files ?? []).find((f) => /\.(tsx|jsx)$/.test(f.path));
  if (!file) return null;
  const local = join(KIT_SRC, name, file.path);
  return existsSync(local) ? local : null;
}

function tailwindFor(css: KitCss, html: string): string {
  mkdirSync(join(KIT_SCRIPTS, '.cache'), { recursive: true });
  const work = mkdtempSync(join(KIT_SCRIPTS, '.cache', 'thumb-'));
  const file = join(work, 'input.html');
  writeFileSync(file, html);
  try {
    return css.compileTailwind(work, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').slice(0, 120);
}

/** A block or page: the converter's own source render (SSR, JS off). */
export async function renderPage(name: string, pngPath: string): Promise<RenderResult> {
  const k = await kit();
  const item = kitItem(name);
  if (!item) return { error: 'no registry item in the kit' };
  let html: string;
  try {
    html = (await k.render.renderBlock(name, item, null)).html;
  } catch (error) {
    return { error: `server render failed: ${firstLine(error)}` };
  }
  const page = k.browser.page({ id: `cult:${name}`, css: tailwindFor(k.css, html) }, html);
  const shot = await k.browser.check(page, { shot: pngPath });
  return { png: pngPath, text: shot.metrics.text };
}

// Every kit source file by its path under src/<item>/ (e.g. `registry/components/animated-badge`),
// for relative and `@/` imports that cross into another item's directory: a demo imports its
// primitive as `../animated-badge`, which the per-item kit layout puts in a sibling item.
let crossIndex: Map<string, string> | null = null;
function crossFile(rel: string): string | null {
  if (!crossIndex) {
    const index = new Map<string, string>();
    for (const itemDir of readdirSync(KIT_SRC)) {
      const root = join(KIT_SRC, itemDir);
      walkFiles(root, (f) => {
        if (!/\.(tsx?|jsx?)$/.test(f)) return;
        const key = relative(root, f).split(sep).join('/').replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
        if (!index.has(key)) index.set(key, f);
      });
    }
    crossIndex = index;
  }
  return crossIndex.get(rel) ?? null;
}

function importedNames(importer: string, spec: string): string[] {
  if (!importer || !existsSync(importer)) return [];
  const src = readFileSync(importer, 'utf8');
  const names = new Set<string>();
  const specPattern = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`import\\s+(?:type\\s+)?([^;]*?)\\s+from\\s+["']${specPattern}["']`, 'g');
  for (const m of src.matchAll(re)) {
    const clause = m[1] ?? '';
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) {
      for (const part of (brace[1] ?? '').split(',')) {
        const n = (part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim();
        if (n) names.add(n);
      }
      continue;
    }
    // `import * as Local from "spec"` has no braces: a stub with only a default export leaves
    // `Local.Root` undefined even though `Local` itself resolved, because esbuild's namespace
    // object for a stubbed ESM module only ever contains the names it statically declares. Scan
    // this same file for `Local.<Property>` accesses and stub each one too, so
    // `SliderPrimitive.Root.displayName` (radix's namespace-import pattern, common across the kit's
    // shadcn/ui components) sees a real (inert) value instead of throwing on `undefined`.
    const star = clause.match(/^\*\s+as\s+(\w+)$/);
    if (star) {
      const local = star[1]!;
      const propRe = new RegExp(`\\b${local}\\.(\\w+)`, 'g');
      for (const p of src.matchAll(propRe)) if (p[1]) names.add(p[1]);
    }
  }
  return [...names];
}

// `then` used to be `undefined` (a stubbed value was never awaitable, so `await stub.from(x)`
// resolved to the stub object itself). A database/auth client stub now behaves like a resolved,
// empty-but-valid query result instead: `{ data: [], items: [], rows: [], results: [], error:
// null, count: 0 }` covers the field names a demo's own fetch/query handler tends to destructure,
// so `const { data } = await supabase.from("t").select()` (a chain of inert calls terminated by
// an await) renders an empty state instead of throwing on `undefined`. Matches the same fix in
// the live-preview harness's INERT (mm-source-kits/cult-ui-pro-preview/lib/build.mjs).
// Symbol.iterator used to yield nothing: `const [value] = stubbedHook(x)` (a common tuple-return
// hook shape — useState-like, or a stubbed `useDebounce`/`useLocalStorage`/etc. this package does
// not itself depend on) destructured to `undefined`, and a later `.trim()`/`.map()` on that threw.
// Yielding `inert()` a few times means that destructure gets a real, chainable inert value in
// every position a tuple hook is reasonably ever destructured into, instead of `undefined`.
const INERT = 'function inert() { return new Proxy(function () {}, { apply: () => inert(), construct: () => inert(), '
  + 'get: (t, k) => (k === "then" ? (resolve) => resolve({ data: [], items: [], rows: [], results: [], error: null, count: 0 }) '
  + ': k === Symbol.toPrimitive ? () => "" : k === Symbol.iterator ? function* () { yield inert(); yield inert(); yield inert(); } : inert()) }); }';

// A hook re-export must itself be a function that RETURNS an inert value, not the inert callable
// value itself: a component destructures a hook's result (`const { object } = useObject(...)`),
// and calling a bare `Stub`/`C` returns `null` (see the stub/webgl loaders below), which throws on
// destructure. `/^use[A-Z]/` alone misses the AI SDK's `experimental_useObject` /
// `experimental_useAssistant` naming, so match a `use` segment anywhere a `_` or the start
// introduces it.
export const HOOK_NAME = /(^|_)use[A-Z]/;
// A lower-camelCase, non-hook export from a component PACKAGE (never `@/...` kit source, where a
// lowercase name is a normal helper function) is a plain data export more often than a component —
// `flutedGlassPresets` from `@paper-design/shaders-react` is exactly this: an array of presets,
// not a component, and the webgl stub used to bind it to the canvas component value, so
// `flutedGlassPresets.map(...)` threw "not a function". Bind it to `[]` instead: safe for `.map`,
// `.length`, `.find` and spreading, wrong only for a lowercase FUNCTION export, which is rarer
// from a component package's public API than a data table or preset list.
const DATA_NAME = /^[a-z]/;
// A lower-camelCase name from a fully-stubbed SERVER_PKGS import (`tool`, `createClient`,
// `generateText`, …) is almost always a factory FUNCTION by JS/TS convention (PascalCase is a
// class/constructor; the component default export is the one case that IS a component, handled
// separately by `component` below). Binding it to `component` directly means CALLING it goes
// through that value's own `apply` trap, which returns a bare `null` for the default-export
// Stub (correct for a stubbed React component rendering nothing) — so `tool({ execute })`
// resolved to `null`, and `tools.someTool.execute` threw. A local `() => inert()` wrapper always
// returns a real, chainable inert value instead, so a factory's result can be destructured,
// chained or read from without throwing.
export const STUB_EXPORTS = (names: readonly string[], component: string, dataFallback = false, factoryFallback = false) =>
  names.map((n) => {
    if (HOOK_NAME.test(n)) return `export const ${n} = () => inert();`;
    if (dataFallback && DATA_NAME.test(n)) return `export const ${n} = [];`;
    if (factoryFallback && DATA_NAME.test(n)) return `export const ${n} = () => inert();`;
    return `export const ${n} = ${component};`;
  }).join('\n');

// The kit's own node_modules (KIT_SCRIPTS/node_modules) is the one React instance the mounting
// entry (`renderClient`'s own `createRoot`/hooks) is built against. A shared file resolved from a
// DIFFERENT directory — AI_ELEMENTS_DIR's own `node_modules/react`, most often — would otherwise
// bundle a second, physically distinct React module: same version, different module identity, so
// a hook called from that copy's component sees no active dispatcher ("Cannot read properties of
// null (reading 'useRef')" et al — React's invalid-hook-call class of error). Force every `react`/
// `react-dom` import, from any file, to this one resolved path.
const ONE_REACT: Record<string, string> = {};
{
  const reactPkg = join(KIT_SCRIPTS, 'node_modules', 'react', 'package.json');
  if (existsSync(reactPkg)) {
    const kitRequire = createRequire(reactPkg);
    for (const spec of ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']) {
      try {
        ONE_REACT[spec] = kitRequire.resolve(spec);
      } catch {
        // Not every spec (e.g. a jsx-runtime subpath) exists on every React version; skip it and
        // let normal resolution find it, same as before this fix existed.
      }
    }
  }
}

function clientPlugin(k: Kit) {
  return {
    name: 'cult-thumbnail-client',
    setup(build: PluginBuild) {
      // One stub module per importer: esbuild caches a module by path, and each importer names its own exports.
      const stub = (a: OnResolveArgs): OnResolveResult => ({ path: `${a.path}?${a.importer}`, namespace: 'stub', pluginData: { names: importedNames(a.importer, a.path) } });
      build.onResolve({ filter: /.*/ }, async (a) => {
        const p = a.path;
        if (a.pluginData?.probe) return undefined;
        if (ONE_REACT[p]) return { path: ONE_REACT[p] };
        if (/\.css$/.test(p)) return { path: p, namespace: 'empty' };
        if (p.startsWith('@/') && a.importer && a.importer.startsWith(AI_ELEMENTS_SRC + sep)) {
          const bare = p.slice(2);
          for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
            const file = join(AI_ELEMENTS_SRC, `${bare}${ext}`);
            if (existsSync(file)) return { path: file };
          }
        }
        const alias = ALIASES[p];
        if (alias) return { path: join(SHIMS, alias) };
        if (k.render.WEBGL_PKGS.some((r) => r.test(p))) {
          // The kit's own converter always stubs a WEBGL_PKGS import to a bare <canvas> with no
          // draw call, because its preview pipeline has no headless GPU. This one does (SwiftShader,
          // wired into chromium() above): a package this thumbnail pipeline itself depends on
          // (e.g. `cobe`) resolves for real, so the item's own globe/shader code actually draws.
          // A webgl package we do NOT carry as a real dependency still falls back to the stub —
          // adding one is a deliberate, reviewed choice (see package.json), not implicit here.
          const real = workspaceResolve(p);
          if (real) return { path: real };
          return { path: `${p}?${a.importer}`, namespace: 'webgl', pluginData: { names: importedNames(a.importer, p) } };
        }
        if (k.render.SERVER_PKGS.some((r) => r.test(p)) || p === 'next' || p.startsWith('next/')) return stub(a);
        const ui = p.match(/^@\/(?:components|registry)\/ui\/(.+)$/);
        if (ui) {
          const shim = join(SHIMS, 'ui', `${ui[1]}.jsx`);
          if (existsSync(shim)) return { path: shim };
        }
        const aiElements = p.match(/^@\/components\/ai-elements\/(.+)$/);
        if (aiElements) {
          for (const ext of ['.tsx', '.ts']) {
            const file = join(AI_ELEMENTS_DIR, `${aiElements[1]}${ext}`);
            if (existsSync(file)) return { path: file };
          }
        }
        if (p.startsWith('@/')) {
          const bare = p.slice(2);
          const hit = crossFile(bare) ?? crossFile(`registry/${bare}`) ?? crossFile(bare.replace(/^components\//, 'registry/components/'));
          return hit ? { path: hit } : stub(a);
        }
        if (p.startsWith('.')) {
          const naive = resolve(a.resolveDir, p);
          for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
            if (existsSync(naive + ext) && statSync(naive + ext).isFile()) return { path: naive + ext };
          }
          const hit = crossFile(relative(KIT_SRC, naive).split(sep).slice(1).join('/'));
          return hit ? { path: hit } : stub(a);
        }
        const r = await build.resolve(p, { resolveDir: a.resolveDir, kind: a.kind, importer: a.importer, pluginData: { probe: true } });
        if (r.errors.length === 0) return r;
        // The kit's own node_modules (KIT_SCRIPTS/node_modules, the only entry in `nodePaths`
        // above) is a thin converter toolchain, not a copy of every package a block imports —
        // generic MIT/permissive logic-only packages like `zod` live in this workspace instead.
        // Resolve those for real rather than stubbing: a stub answers `z.string()` with another
        // inert value, which is fine for chaining but wrong wherever the block actually inspects
        // the schema (`.shape`, `.safeParse(...).success`), and a real, side-effect-free schema
        // library renders exactly like the product does. Packages this package does not itself
        // depend on (server SDKs, anything with a network/secrets surface) still fall through to
        // the stub below, unchanged.
        const real = workspaceResolve(p);
        return real ? { path: real } : stub(a);
      });
      build.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'webgl' }, (a) => ({
        contents: `import * as React from "react";\n${INERT}\nconst C = function (p) { return React.createElement("canvas", { className: p && p.className }); };\nexport default C;\n${STUB_EXPORTS(a.pluginData?.names ?? [], 'C', true)}`,
        loader: 'js', resolveDir: join(KIT_SCRIPTS, 'node_modules'),
      }));
      // A stubbed module's exports render nothing as components, and stay inert as values: any
      // property, call or construction (`Redis.fromEnv()`, `new Client()`) yields another inert
      // value instead of throwing, so the item's own UI around it still renders.
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: `${INERT}\nconst Stub = new Proxy(function () {}, { apply: () => null, construct: () => inert(), get: (t, k) => (k === "prototype" ? t.prototype : k === "then" ? undefined : inert()) });\nexport default Stub;\n${STUB_EXPORTS(a.pluginData?.names ?? [], 'Stub', false, true)}`,
        loader: 'js',
      }));
    },
  };
}

/**
 * Use the installed live-preview harness when present, so a thumbnail and the opened component
 * use the same real UI dependencies and disclosed offline demo records. The licensed kit stays
 * read-only. An absent harness keeps the standalone converter fallback available.
 */
export async function renderLive(name: string, pngPath: string): Promise<RenderResult> {
  const previewRoot = process.env.CULT_PREVIEW_DIR ?? join(dirname(KIT_DIR), 'cult-ui-pro-preview');
  const buildFile = join(previewRoot, 'lib', 'build.mjs');
  if (!existsSync(buildFile)) return { error: 'live-preview harness is not installed' };
  const live = await import(pathToFileURL(buildFile).href) as {
    inspect: (name: string) => Promise<{ live: boolean; reason?: string; css: string; js: string }>;
    pageHtml: (built: unknown, theme: string) => string;
  };
  const built = await live.inspect(name);
  if (!built.live) return { error: built.reason ?? 'live preview is unavailable' };
  const ctx = await (await chromium()).newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  await ctx.route(/^https?:/, (route) => route.abort());
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(firstLine(error)));
  try {
    const html = live.pageHtml(built, 'light');
    const at = findRealTagEnd(html, /<head\b/i);
    const observer = '<script>window.__cultPreviewReady=false;window.__cultPreviewError=null;addEventListener("message",e=>{if(e.data?.source==="cult-live-preview"&&e.data.type==="error")window.__cultPreviewError=e.data.reason;if(e.data?.source==="cult-live-preview"&&e.data.type==="ready")window.__cultPreviewReady=true;});</script>';
    await page.setContent(at < 0 ? html : html.slice(0, at) + observer + html.slice(at));

    await page.waitForFunction(() => {
      const state = window as unknown as { __cultPreviewReady: boolean; __cultPreviewError: string | null };
      return state.__cultPreviewReady || state.__cultPreviewError;
    }, undefined, { timeout: 16_000 });
    await page.waitForTimeout(300);
    if (errors.length) return { error: `live preview threw: ${errors[0]}` };
    const signaledError = await page.evaluate(() => (window as unknown as { __cultPreviewError: string | null }).__cultPreviewError);
    if (signaledError) return { error: `live preview failed: ${signaledError}` };
    const text = await page.evaluate(() => (document.getElementById('root')?.innerText ?? '').trim().length);
    const markup = await page.evaluate(() => document.getElementById('root')?.innerHTML ?? '');
    if (!markup.trim()) return { error: 'live preview rendered nothing' };
    await page.screenshot({ path: pngPath });
    return { png: pngPath, text };
  } finally {
    await ctx.close();
  }
}

/** A demo module (or a page the server render refused): mount it in a browser, then screenshot. */
export async function renderClient(entryFile: string, pngPath: string): Promise<RenderResult> {
  const k = await kit();
  const entry = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import * as M from ${JSON.stringify(entryFile)};
    // No real server, model or database: every fetch a demo makes on mount is answered locally
    // with a generic empty-but-valid JSON body (screenshotting the initial render never needs the
    // response itself — most demos don't fetch until a user interacts — this only keeps an
    // on-mount fetch from rejecting into console noise or an unhandled-rejection failure).
    window.fetch = async () => new Response(JSON.stringify({ data: [], items: [], rows: [], results: [], error: null, count: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    const Demo = M.default || Object.values(M).find((v) => typeof v === "function" && /^[A-Z]/.test(v.name || ""));
    window.__thumbError = null;
    // A measuring hook whose ref never attached (its element comes from a stubbed module) would
    // make ResizeObserver throw; observing nothing is what a real page does in that case.
    if (window.ResizeObserver) { const observe = ResizeObserver.prototype.observe; ResizeObserver.prototype.observe = function (el, o) { if (el instanceof Element) observe.call(this, el, o); }; }
    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { failed: false }; }
      static getDerivedStateFromError(e) { window.__thumbError = String((e && e.message) || e).slice(0, 160); return { failed: true }; }
      render() { return this.state.failed ? null : this.props.children; }
    }
    function mount(element) {
      createRoot(document.getElementById("root")).render(React.createElement(Boundary, null, element));
    }
    if (typeof Demo === "function" && Demo.constructor && Demo.constructor.name === "AsyncFunction") {
      // A React Server Component's async work is data-fetching, already answered by the mock
      // fetch above; calling it directly (not through React's own reconciler, which cannot render
      // an async function component without a server) resolves to the plain element tree it would
      // have returned from a real server render, and that tree mounts like any other.
      // Next.js 15's App Router convention: a page component receives \`params\`/\`searchParams\` as
      // Promises resolving to plain objects, not the objects directly. An empty (never undefined)
      // resolved value here is exactly what a real request with no dynamic segment or query string
      // would deliver, so \`await searchParams\` (or \`params\`) is always safe to index into.
      const pageProps = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };
      Promise.resolve(Demo(pageProps)).then(mount, (e) => { window.__thumbError = String((e && e.message) || e).slice(0, 160); });
    } else {
      mount(React.createElement(Demo));
    }
  `;
  let bundle: string;
  try {
    const out = await k.esbuild.build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: dirname(entryFile), sourcefile: 'thumbnail-entry.tsx' },
      bundle: true, platform: 'browser', format: 'iife', write: false, jsx: 'automatic', logLevel: 'silent',
      nodePaths: [join(KIT_SCRIPTS, 'node_modules')], plugins: [clientPlugin(k)],
      // `development`, not `production`: a thrown React error is a full message here
      // ("Cannot update a component while rendering a different component"), not a minified
      // "error #185" link the Boundary below has to render to a screenshot nobody can click.
      // `generated/thumbnails.json`'s placeholder `reason` is this message verbatim, so a real
      // message is also what future maintainers read when deciding whether a row is fixable.
      define: {
        'process.env.NODE_ENV': '"development"',
        // `NEXT_PUBLIC_*` vars are compiled into the client bundle by Next.js convention, so
        // these three (the kit's whole `NEXT_PUBLIC_` surface — see the grep this comment
        // documents) are already public, not secrets: a real deployment ships their real values
        // to every browser tab. A placeholder value only satisfies an item's own `if
        // (!process.env.NEXT_PUBLIC_X) throw` startup guard; renderClient's `ctx.route(/^https?:/,
        // abort)` still refuses every network request the value could be used to make, so no call
        // ever reaches Supabase, Stripe or Trigger.dev.
        'process.env.NEXT_PUBLIC_BLOCKS_SUPABASE_URL': '"https://cult-thumbnail-preview.invalid"',
        'process.env.NEXT_PUBLIC_STRIPE_COFFEE_ID': '"price_cult_thumbnail_preview"',
        'process.env.NEXT_PUBLIC_TRIGGER_API_KEY': '"pk_cult_thumbnail_preview"',
        // These two are real secret-named vars (never public), but the client they guard is
        // already a stubbed/inert import in this bundle (SERVER_PKGS above) — no real Supabase or
        // Resend call happens whether the guard passes or not, and `ctx.route(/^https?:/, abort)`
        // below refuses every network request regardless. A placeholder value here only satisfies
        // an item's own `if (!process.env.X) throw` startup guard so its UI can mount; it is never
        // a real credential and is never sent anywhere.
        'process.env.BLOCKS_SUPABASE_SERVICE_ROLE_KEY': '"cult-thumbnail-preview-not-a-real-key"',
        'process.env.RESEND_API_KEY': '"cult-thumbnail-preview-not-a-real-key"',
        'process.env': '{}',
      },
    });
    bundle = out.outputFiles[0]?.text ?? '';
  } catch (error) {
    const first = (error as { errors?: Array<{ text: string }> }).errors?.[0]?.text;
    return { error: `bundle failed: ${(first ?? firstLine(error)).slice(0, 120)}` };
  }
  const ctx = await (await chromium()).newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  // No network: every request leaves the page unanswered (fonts, images, vendor-hosted assets).
  await ctx.route(/^https?:/, (route) => route.abort());
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 160)));
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${ROLE_CSS}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    await page.waitForTimeout(900);
    const failed = await page.evaluate(() => (window as unknown as { __thumbError: string | null }).__thumbError);
    if (failed) return { error: `threw while rendering: ${failed}` };
    const markup = await page.evaluate(() => document.getElementById('root')?.innerHTML ?? '');
    if (!markup.trim()) return { error: `rendered nothing${pageErrors[0] ? ` (${pageErrors[0]})` : ''}` };
    await page.addStyleTag({ content: tailwindFor(k.css, markup) });
    await page.waitForTimeout(500);
    if (process.env.THUMB_DEBUG) {
      const rect = await page.evaluate(() => JSON.stringify(document.getElementById('root')?.getBoundingClientRect()));
      console.error('DEBUG rect', rect);
      console.error('DEBUG markup', markup.slice(0, 3000));
    }
    const text = await page.evaluate(() => (document.getElementById('root')?.innerText ?? '').trim().length);
    await page.screenshot({ path: pngPath });
    return { png: pngPath, text };
  } finally {
    await ctx.close();
  }
}
