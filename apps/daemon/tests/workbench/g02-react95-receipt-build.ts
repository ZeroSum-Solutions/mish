import { build, type BuildOptions } from 'esbuild';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/workbench/placement/adoption-plan.js';
import { REACT95_KIT } from '../../src/workbench/kits/react95/kit.generated.js';
import { REACT95_TOOLCHAIN } from '../../src/workbench/kits/react95/pins.js';
import { react95UnitFiles } from '../../src/workbench/kits/react95/unit.js';
import { REACT95_BROWSER_WIDTHS, type React95BrowserReceipt, type React95CheckResult, type React95KitReceipt, type React95TemplateReceipt } from '../../src/workbench/targets/react/react95-receipt.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { readPageText } from '../../src/workbench/review/evidence.js';
import type { ViewportCapture } from '../../src/workbench/review/types.js';
import { REACT95_TYPECHECK_PROFILE, typecheckUnit } from './react95-typecheck.js';

/**
 * G02 receipt generator for the React95 kit (AC-R17.2; deterministic, no
 * network, no install). For each template unit, exactly as apply writes it:
 * type-check under the recorded project profile; build the production preview
 * bundle with the pinned esbuild; render the preview on the server (no
 * window) with styled-components' ServerStyleSheet; hydrate the preview
 * document under Strict Mode in jsdom; then drive a separate harness bundle of
 * the same unit through its behavior, keyboard, style-isolation, contrast and
 * cleanup checks. Regenerate with
 * `OD_UPDATE_REACT95_RECEIPT=1 pnpm --filter @mish/daemon exec vitest run tests/workbench/g02-react95-receipt.test.ts`.
 */
const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureRoot = join(daemonRoot, 'tests', 'fixtures', 'workbench', 'g02-react95-fixture');
const previewRoot = join(daemonRoot, 'kits', 'react95', 'preview');
export const REACT95_RECEIPT_DOC_PATH = join(repoRoot, 'docs', 'plans', '2026-10-02-design-workbench', 'evidence', 'implementation-start', 'g02-react95-receipt.json');
export const REACT95_RECEIPT_MODULE_PATH = join(daemonRoot, 'src', 'workbench', 'targets', 'react', 'g02-react95-receipt.ts');
export const REACT95_PREVIEW_MODULE_PATH = join(daemonRoot, 'src', 'workbench', 'kits', 'react95', 'preview.generated.ts');
const nodeModules = join(daemonRoot, 'node_modules');
const daemonRequire = createRequire(join(daemonRoot, 'package.json'));
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const posix = (value: string) => value.split('\\').join('/');
const settle = (ms = 30) => new Promise(done => setTimeout(done, ms));

/** Production preview build options, recorded verbatim in the receipt. */
export const REACT95_CLIENT_BUILD = Object.freeze({
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof',
} as const);

function filesOf(root: string): { path: string; sha256: string }[] {
  const out: { path: string; sha256: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: posix(relative(root, full)), sha256: sha256(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}
const installedVersion = (name: string) => (JSON.parse(readFileSync(daemonRequire.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;

/** Package directory of a bundled input under node_modules (pnpm layout included). */
function packageOf(input: string): string | null {
  const marker = input.lastIndexOf('node_modules/');
  if (marker < 0) return null;
  const rest = input.slice(marker + 'node_modules/'.length).split('/');
  return input.slice(0, marker + 'node_modules/'.length) + (rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
}
function bundledPackages(inputs: readonly string[], workDir: string): React95KitReceipt['bundledPackages'] {
  const dirs = [...new Set(inputs.map(packageOf).filter((dir): dir is string => dir !== null))];
  return dirs.map(dir => {
    const abs = dir.startsWith('/') ? dir : join(workDir, dir);
    const manifest = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown };
    const licence = readdirSync(abs).sort().find(name => /^licen[cs]e(?:\.(?:md|txt))?$/iu.test(name));
    return {
      name: manifest.name, version: manifest.version, manifestLicense: typeof manifest.license === 'string' ? manifest.license : null,
      licenceFile: licence ? { path: licence, sha256: sha256(readFileSync(join(abs, licence))) } : null,
    };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---- style isolation ----------------------------------------------------------------------
/** Splits a stylis-minified stylesheet into rules, descending into @media/@supports blocks. */
function cssRules(css: string): { selector: string; atRule: string | null }[] {
  const out: { selector: string; atRule: string | null }[] = [];
  const walk = (text: string, atRule: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (/^@(?:media|supports)/u.test(prelude)) walk(body, prelude);
      else out.push({ selector: prelude, atRule: prelude.startsWith('@') ? prelude : atRule });
      i = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//gu, ''), null);
  return out;
}
/**
 * styled-components' server rehydration markers (`data-styled.g1[id="sc-…"]{content:…}`)
 * name an element that never exists; they style nothing and are allowed.
 */
const REHYDRATION_MARKER = /^data-styled\.g\d+\[id="sc-[A-Za-z0-9]+"\]$/u;
/** A selector is scoped when every comma part starts at a styled-components class (no element, :root or * at the root). */
const scoped = (part: string) => /^\.[A-Za-z0-9_-]+/u.test(part) || REHYDRATION_MARKER.test(part);
function unscopedSelectors(css: string): string[] {
  return cssRules(css).flatMap(rule => rule.selector.startsWith('@') ? [rule.selector] : rule.selector.split(',').map(part => part.trim()).filter(part => !scoped(part)));
}

// ---- contrast -----------------------------------------------------------------------------
function luminance(hex: string): number {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
function themeColors(path: string): Record<string, string> {
  const text = REACT95_KIT.vendored.find(file => file.path === path)!.text;
  return Object.fromEntries([...text.matchAll(/^\s*([A-Za-z]+):\s*'(#[0-9a-fA-F]{6})'/gmu)].map(match => [match[1]!, match[2]!.toLowerCase()]));
}
/** Text/background pairs the templates render (disabled text is exempt under WCAG 1.4.3). */
const CONTRAST_PAIRS = [
  ['materialText', 'material', 4.5, 'window and form text'],
  ['canvasText', 'canvas', 4.5, 'input text and messages'],
  ['headerText', 'headerBackground', 4.5, 'active title bar'],
  ['materialText', 'material', 4.5, 'inactive title bar (template repair)'],
  ['materialTextInvert', 'hoverBackground', 4.5, 'focused menu item'],
  ['materialText', 'material', 3, 'focus outline on material'],
  ['canvasText', 'canvas', 3, 'focus outline in inputs'],
] as const;
function contrastChecks(): React95CheckResult[] {
  return (['original', 'highContrast'] as const).flatMap(theme => {
    const colors = themeColors(`src/common/themes/${theme}.ts`);
    return CONTRAST_PAIRS.map(([fg, bg, minimum, use]) => {
      const ratio = contrastRatio(colors[fg]!, colors[bg]!);
      return { name: `contrast:${theme}:${use}`, passed: ratio >= minimum, detail: `${fg} ${colors[fg]} on ${bg} ${colors[bg]}: ${ratio}:1 (needs ${minimum}:1)` };
    });
  });
}

// ---- jsdom harness ------------------------------------------------------------------------
type Win = any; // jsdom window
function dom(html: string, errors: string[]) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  virtualConsole.on('warn', (...args: unknown[]) => errors.push(`warn: ${args.map(String).join(' ')}`));
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  const jsdom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole });
  const window: Win = jsdom.window;
  window.addEventListener('error', (event: { message: string }) => errors.push(event.message));
  return jsdom;
}
/** Tracks listeners on window and document, so cleanup can be compared before and after. */
function trackListeners(window: Win) {
  const live = new Map<string, number>();
  const proto = window.EventTarget.prototype;
  const add = proto.addEventListener; const remove = proto.removeEventListener;
  const key = (target: unknown, type: string) => (target === window ? `window:${type}` : target === window.document ? `document:${type}` : null);
  proto.addEventListener = function (this: unknown, type: string, ...rest: unknown[]) { const k = key(this, type); if (k) live.set(k, (live.get(k) ?? 0) + 1); return add.call(this, type, ...rest); };
  proto.removeEventListener = function (this: unknown, type: string, ...rest: unknown[]) { const k = key(this, type); if (k) live.set(k, (live.get(k) ?? 0) - 1); return remove.call(this, type, ...rest); };
  return () => JSON.stringify([...live.entries()].filter(([, count]) => count !== 0).sort());
}
const key = (window: Win, target: Win, value: string, init: Record<string, unknown> = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
const pointer = (window: Win, target: Win, type: string, x: number, y: number) => {
  const Ctor = window.PointerEvent ?? window.MouseEvent;
  target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
};
const check = (name: string, passed: boolean, detail: string): React95CheckResult => ({ name, passed, detail });
/** Accessible name: aria-label, aria-labelledby text, an associated <label>, or own text. */
function accessibleName(window: Win, element: Win): string {
  const doc = window.document;
  if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
  const by = element.getAttribute('aria-labelledby');
  if (by) return by.split(' ').map((id: string) => doc.getElementById(id)?.textContent ?? '').join(' ').trim();
  if (element.id) { const label = doc.querySelector(`label[for="${element.id}"]`); if (label) return label.textContent.trim(); }
  const wrapping = element.closest('label'); if (wrapping) return wrapping.textContent.trim();
  return (element.textContent ?? '').trim();
}
function namedControls(window: Win, root: Win): React95CheckResult {
  const controls = [...root.querySelectorAll('button, input, textarea, select, [role="slider"], [role="menuitem"], [tabindex="0"]')];
  const unnamed = controls.filter(control => !accessibleName(window, control)).map(control => control.outerHTML.slice(0, 60));
  return check('keyboard:every control has an accessible name', controls.length > 0 && unnamed.length === 0, unnamed.length ? `unnamed: ${unnamed.join(' | ')}` : `${controls.length} controls named`);
}

async function windowAppChecks(window: Win, container: Win): Promise<React95CheckResult[]> {
  const doc = window.document;
  const results: React95CheckResult[] = [];
  const region = () => container.querySelector('[role="region"]');
  const fileButton = () => [...container.querySelectorAll('button')].find((b: Win) => b.textContent.trim() === 'File');
  const items = () => [...container.querySelectorAll('[role="menuitem"]')];
  results.push(namedControls(window, container));
  // Menu: open, arrow/Home/End movement, Escape returns focus.
  fileButton().click(); await settle();
  results.push(check('menu:opens from its button with focus on the first item', fileButton().getAttribute('aria-expanded') === 'true' && !!container.querySelector('[role="menu"]') && doc.activeElement === items()[0], `expanded=${fileButton().getAttribute('aria-expanded')}`));
  key(window, doc.activeElement, 'ArrowDown'); await settle();
  const second = doc.activeElement === items()[1];
  key(window, doc.activeElement, 'End'); await settle();
  const last = doc.activeElement === items()[items().length - 1];
  key(window, doc.activeElement, 'Home'); await settle();
  results.push(check('menu:arrow, Home and End move focus between items', second && last && doc.activeElement === items()[0], `second=${second} last=${last}`));
  key(window, doc.activeElement, 'Escape'); await settle();
  results.push(check('menu:Escape closes the menu and returns focus to its button', !container.querySelector('[role="menu"]') && doc.activeElement === fileButton(), `focus=${doc.activeElement?.textContent}`));
  key(window, fileButton(), 'ArrowDown'); await settle();
  key(window, doc.activeElement, 'Enter'); await settle();
  const cleared = container.querySelector('textarea').value === '' && /Unsaved changes/u.test(container.textContent);
  key(window, fileButton(), 'ArrowDown'); await settle();
  key(window, doc.activeElement, 'ArrowDown'); await settle();
  key(window, doc.activeElement, 'Enter'); await settle();
  results.push(check('menu:Enter activates the focused item (New, then Save)', cleared && !container.querySelector('[role="menu"]') && /All changes saved/u.test(container.textContent), `cleared=${cleared}`));
  // Resize: keyboard slider and pointer drag on the upstream handle.
  const handle = () => container.querySelector('[data-od-resize]');
  const width = () => region().style.getPropertyValue('--od-window-width');
  const height = () => region().style.getPropertyValue('--od-window-height');
  const before = width();
  handle().focus(); key(window, handle(), 'ArrowRight'); await settle();
  results.push(check('resize:keyboard slider widens the window by one step', handle().getAttribute('role') === 'slider' && handle().getAttribute('tabindex') === '0' && before === '480px' && width() === '496px' && handle().getAttribute('aria-valuenow') === '496', `${before} → ${width()}`));
  pointer(window, handle(), 'pointerdown', 100, 100);
  pointer(window, window, 'pointermove', 140, 124);
  pointer(window, window, 'pointerup', 140, 124); await settle();
  results.push(check('resize:pointer drag resizes from the handle and releases its listeners', width() === '536px' && height() === '344px', `${width()} × ${height()}`));
  // Focus: leaving the window marks it inactive; returning reactivates it.
  const header = () => container.querySelector('[data-od-active]');
  const outside = doc.createElement('button'); outside.textContent = 'outside'; doc.body.appendChild(outside);
  fileButton().focus(); outside.focus(); await settle();
  const inactive = header().getAttribute('data-od-active') === 'false';
  fileButton().focus(); await settle();
  results.push(check('focus:the title bar reflects whether focus is inside the window', inactive && header().getAttribute('data-od-active') === 'true', `inactive=${inactive}`));
  outside.remove();
  // Close and reopen from the taskbar, with focus following.
  const task = () => container.querySelector('[aria-label="Taskbar"] button');
  container.querySelector('button[aria-label="Close Notepad"]').click(); await settle();
  results.push(check('window:close removes the window and focuses its taskbar button', !region() && doc.activeElement === task() && task().getAttribute('aria-pressed') === 'false', `region=${!!region()}`));
  task().click(); await settle();
  results.push(check('window:reopen restores the window and moves focus into it', !!region() && doc.activeElement === fileButton() && task().getAttribute('aria-pressed') === 'true', `focus=${doc.activeElement?.textContent}`));
  key(window, fileButton(), 'ArrowDown'); await settle();
  items().find((item: Win) => item.textContent.trim() === 'Close window').click(); await settle();
  results.push(check('window:the File menu can close the window too', !region() && doc.activeElement === task(), 'Close window chosen'));
  task().click(); await settle();
  return results;
}

async function settingsFormChecks(window: Win, container: Win): Promise<React95CheckResult[]> {
  const doc = window.document;
  const results: React95CheckResult[] = [];
  const byLabel = (text: string) => { const label = [...container.querySelectorAll('label')].find((l: Win) => l.textContent.trim().startsWith(text)); return label?.htmlFor ? doc.getElementById(label.htmlFor) : label?.querySelector('input'); };
  const button = (text: string) => [...container.querySelectorAll('button')].find((b: Win) => b.textContent.trim() === text);
  const setValue = (input: Win, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  results.push(namedControls(window, container));
  const account = byLabel('Account ID');
  const beta = byLabel('Beta features');
  results.push(check('state:disabled controls are disabled and not editable', account.disabled === true && beta.disabled === true && button('Save').disabled === false, `account=${account.disabled} beta=${beta.disabled}`));
  const name = byLabel('Display name'); const email = byLabel('Email');
  name.focus();
  results.push(check('state:focus lands on an enabled field', doc.activeElement === name, 'Display name focused'));
  setValue(name, ''); setValue(email, 'not-an-email'); await settle();
  button('Save').click(); await settle();
  const nameError = doc.getElementById(name.getAttribute('aria-describedby')?.split(' ').pop() ?? '');
  results.push(check('state:invalid fields are marked, described and focused', name.getAttribute('aria-invalid') === 'true' && email.getAttribute('aria-invalid') === 'true' && /^Error:/u.test(nameError?.textContent ?? '') && doc.activeElement === name, `${nameError?.textContent}`));
  setValue(name, 'Ada'); setValue(email, 'ada@example.com'); await settle();
  button('Save').click();
  await Promise.resolve();
  const saving = button('Saving…')?.disabled === true;
  await settle();
  const status = container.querySelector('[role="status"]');
  results.push(check('state:saving disables the action, then success is announced', saving && /^Saved:/u.test(status.textContent) && !name.hasAttribute('aria-invalid'), `status=${status.textContent}`));
  byLabel('Simulate a server error').click(); await settle();
  button('Save').click(); await settle();
  const alert = container.querySelector('[role="alert"]');
  results.push(check('state:a failed save shows the error with focus on Retry and keeps the input', /^Error:/u.test(alert?.textContent ?? '') && doc.activeElement === button('Retry') && name.value === 'Ada', `alert=${alert?.textContent}`));
  byLabel('Simulate a server error').click(); await settle();
  button('Retry').click(); await settle();
  results.push(check('state:retry after the failure succeeds', !container.querySelector('[role="alert"]') && /^Saved:/u.test(container.querySelector('[role="status"]').textContent), 'retried'));
  const compact = byLabel('Compact'); compact.click(); await settle();
  results.push(check('state:radio and checkbox controls change state', compact.checked === true && byLabel('Comfortable').checked === false, 'Compact selected'));
  return results;
}

// ---- build --------------------------------------------------------------------------------
async function bundle(entry: string, absWorkingDir: string, extra: BuildOptions = {}) {
  const result = await build({ ...REACT95_CLIENT_BUILD, entryPoints: [entry], absWorkingDir, nodePaths: [nodeModules], write: false, metafile: true, logLevel: 'silent', ...extra });
  return { text: result.outputFiles![0]!.text, inputs: Object.keys(result.metafile!.inputs).map(posix) };
}
const inlineScript = (code: string) => `<script>\n${code.replace(/<\/script/giu, '<\\/script')}\n</script>`;

async function templateReceipt(template: (typeof REACT95_KIT.templates)[number], previewCss: string, packages: Set<string>, workRoot: string): Promise<{ receipt: React95TemplateReceipt; preview: string }> {
  const work = join(workRoot, template.id);
  const src = join(work, 'src');
  mkdirSync(src, { recursive: true });
  const unit = react95UnitFiles(REACT95_KIT, template.id)!;
  for (const file of unit) { mkdirSync(dirname(join(src, file.path)), { recursive: true }); writeFileSync(join(src, file.path), file.bytes); }
  // No package.json in the work tree: a `"type": "module"` manifest would switch the server build to Node ESM interop.
  cpSync(join(previewRoot, 'Preview.tsx'), join(work, 'Preview.tsx'));
  const stem = template.file.replace(/\.tsx$/u, '');
  writeFileSync(join(work, 'client.tsx'), `import { StrictMode } from 'react';\nimport { hydrateRoot } from 'react-dom/client';\nimport Template from './src/${stem}';\nimport { Preview } from './Preview';\nhydrateRoot(document.getElementById('root')!, <StrictMode><Preview Template={Template} /></StrictMode>);\n`);
  writeFileSync(join(work, 'harness.tsx'), `import { StrictMode } from 'react';\nimport { hydrateRoot } from 'react-dom/client';\nimport Template from './src/${stem}';\nimport { Preview } from './Preview';\nexport function mount(container: HTMLElement) { const root = hydrateRoot(container, <StrictMode><Preview Template={Template} /></StrictMode>); return () => root.unmount(); }\n`);
  writeFileSync(join(work, 'server.tsx'), `import { renderToString } from 'react-dom/server';\nimport { ServerStyleSheet } from 'styled-components';\nimport Template from './src/${stem}';\nimport { Preview } from './Preview';\nexport function render() { const sheet = new ServerStyleSheet(); try { const html = renderToString(sheet.collectStyles(<Preview Template={Template} />)); return { html, styles: sheet.getStyleTags() }; } finally { sheet.seal(); } }\n`);

  const diagnostics = typecheckUnit(src, [template.file, 'React95Theme.d.ts']);
  const client = await bundle('client.tsx', work);
  if (client.text.includes(work)) throw new Error('Production bundle embeds the build directory');
  for (const input of client.inputs) { const dir = packageOf(input); if (dir) packages.add(dir.startsWith('/') ? dir : join(work, dir)); }
  const harness = await bundle('harness.tsx', work, { globalName: 'OdReact95Harness', minify: false });
  // styled-components is bundled into each server render (not shared through require), so its
  // component counters start fresh and the server class names equal the client bundle's.
  const server = await build({
    entryPoints: ['server.tsx'], absWorkingDir: work, nodePaths: [nodeModules], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['react', 'react-dom', 'react-dom/*'], logLevel: 'silent',
  });
  const module = { exports: {} as { render?: () => { html: string; styles: string } } };
  new Function('module', 'exports', 'require', server.outputFiles[0]!.text)(module, module.exports, daemonRequire);
  const { html, styles } = module.exports.render!();
  const cssText = [...styles.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map(match => match[1]!).join('');
  const preview = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${template.title} · React95 kit preview</title>`,
    `<style data-od-preview>${previewCss}</style>`,
    styles,
    '</head>',
    '<body>',
    `<div id="root">${html}</div>`,
    inlineScript(client.text),
    '</body>',
    '</html>',
    '',
  ].join('\n');

  const checks: React95CheckResult[] = [];
  checks.push(check('ssr:renders on the server without a window', html.includes(`data-od-react95="${template.id}"`), `${html.length} characters of markup`));
  const unscoped = unscopedSelectors(cssText);
  checks.push(check('isolation:every server style rule is scoped to a component class', cssRules(cssText).length > 0 && unscoped.length === 0, unscoped.length ? `unscoped: ${unscoped.join(' | ')}` : `${cssRules(cssText).length} rules scoped`));
  const unitText = unit.filter(file => file.role === 'source').map(file => file.bytes.toString('utf8')).join('\n');
  checks.push(check('isolation:no global style, reset or font face in the unit', !/createGlobalStyle|@font-face|ms_sans_serif|ms-sans-serif/u.test(unitText) && !/@font-face/u.test(cssText), 'system font stack; no font file'));
  checks.push(check('focus:visible focus rules for inputs, menu items and the resize handle', /input:focus/u.test(cssText) && (template.id !== 'window-app' || (/\[role='menuitem'\]:focus|\[role="menuitem"\]:focus|\[role=menuitem\]:focus/u.test(cssText) && /\[data-od-resize\]:focus/u.test(cssText))), 'restored where upstream removes them'));
  checks.push(check('responsive:stacked layout below 768px and a 44px minimum for every control', /@media \(max-width:\s?767px\)/u.test(cssText) && /min-height:\s?44px/u.test(cssText), 'declared rules; measured in the browser section'));

  // The shipped preview document hydrates cleanly under Strict Mode, and its theme switch stays inside it.
  const previewErrors: string[] = [];
  const previewDom = dom(preview.replace(inlineScript(client.text), ''), previewErrors);
  previewDom.window.eval(client.text);
  await settle(50);
  const rootClass = () => previewDom.window.document.querySelector(`[data-od-react95="${template.id}"]`)?.className;
  const originalClass = rootClass();
  const highContrastRadio = [...previewDom.window.document.querySelectorAll('.od-preview-themes input')].find((input: Win) => input.value === 'highContrast');
  highContrastRadio.click(); await settle();
  const themed = rootClass() !== originalClass;
  const previewRules = [...previewDom.window.document.styleSheets].filter((sheet: Win) => !sheet.ownerNode?.hasAttribute('data-od-preview'))
    .flatMap((sheet: Win) => [...sheet.cssRules].flatMap((rule: Win) => rule.cssRules ? [...rule.cssRules] : [rule])).map((rule: Win) => rule.selectorText ?? '').filter(Boolean);
  const leaked = previewRules.flatMap((selector: string) => selector.split(',').map(part => part.trim())).filter((part: string) => !scoped(part));
  previewDom.window.close();
  checks.push(check('hydration:the preview document hydrates under Strict Mode without console errors', previewErrors.length === 0, previewErrors.join(' | ') || 'no errors'));
  checks.push(check('theme:the project-owned theme switch restyles only the template', themed && leaked.length === 0, leaked.length ? `unscoped after switching: ${leaked.join(' | ')}` : 'original → high contrast, all rules scoped'));

  // Behavior, keyboard and cleanup on a harness bundle of the same unit.
  const harnessErrors: string[] = [];
  const harnessDom = dom(`<!doctype html><html lang="en"><head>${styles}</head><body><div id="root">${html}</div></body></html>`, harnessErrors);
  const window: Win = harnessDom.window;
  const listeners = trackListeners(window);
  window.eval(harness.text);
  const container = window.document.getElementById('root');
  const unmount = window.OdReact95Harness.mount(container);
  await settle(50);
  const baseline = listeners();
  checks.push(...(template.id === 'window-app' ? await windowAppChecks(window, container) : await settingsFormChecks(window, container)));
  if (template.id === 'window-app') {
    // Unmount in the middle of a drag: the template must release its window listeners.
    const handle = container.querySelector('[data-od-resize]');
    pointer(window, handle, 'pointerdown', 10, 10);
    await settle();
  }
  unmount();
  await settle();
  checks.push(check('cleanup:unmount releases every listener the template added and empties its root', listeners() === baseline && container.innerHTML === '', `listeners ${listeners()} vs ${baseline}`));
  checks.push(check('hydration:the harness runs every interaction without console errors', harnessErrors.length === 0, harnessErrors.join(' | ') || 'no errors'));
  window.close();
  checks.push(...contrastChecks());

  return {
    receipt: {
      template: template.id,
      unitSha256: sha256(canonicalJson(unit.map(file => ({ path: file.path, role: file.role, sha256: sha256(file.bytes) })))),
      files: unit.map(file => ({ path: file.path, sha256: sha256(file.bytes) })),
      typecheck: { diagnostics: diagnostics.length },
      outputs: { productionBundle: { sha256: sha256(client.text), bytes: Buffer.byteLength(client.text) }, preview: { sha256: sha256(preview), bytes: Buffer.byteLength(preview) } },
      checks,
    },
    preview,
  };
}

export async function buildReact95Receipt(): Promise<{ receipt: React95KitReceipt; previews: Record<string, string> }> {
  const toolchain = Object.fromEntries(Object.keys(REACT95_TOOLCHAIN).map(name => [name, installedVersion(name)])) as React95KitReceipt['toolchain'];
  const pins = JSON.parse(readFileSync(join(fixtureRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  for (const [name, version] of Object.entries(toolchain)) {
    const pinned = pins.dependencies[name] ?? pins.devDependencies[name];
    if (pinned !== version || version !== REACT95_TOOLCHAIN[name as keyof typeof REACT95_TOOLCHAIN]) throw new Error(`Fixture pins ${name}@${pinned} but the workspace resolves ${version}`);
  }
  const previewCss = readFileSync(join(previewRoot, 'preview.css'), 'utf8').trim().split('\n').join('');
  const work = mkdtempSync(join(tmpdir(), 'g02-react95-receipt-'));
  try {
    const packages = new Set<string>();
    const templates: React95TemplateReceipt[] = [];
    const previews: Record<string, string> = {};
    for (const template of REACT95_KIT.templates) {
      const result = await templateReceipt(template, previewCss, packages, work);
      templates.push(result.receipt);
      previews[template.id] = result.preview;
    }
    const passed = templates.every(entry => entry.typecheck.diagnostics === 0 && entry.checks.every(entry => entry.passed));
    const receipt: React95KitReceipt = {
      schema: 'g02-react-receipt/1', adapter: 'react-source/v1', sources: ['react95'], status: passed ? 'passed' : 'failed',
      toolchainResolution: 'Resolved from apps/daemon node_modules as installed from the workspace pnpm-lock.yaml (exact pins); no network install at build time. The fixture package.json pins and the kit pins must equal the resolved versions or the build refuses.',
      toolchain,
      source: { repository: REACT95_KIT.source.repository, commit: REACT95_KIT.source.commit, archiveSha256: REACT95_KIT.source.archive.sha256 },
      fixture: { path: posix(relative(repoRoot, fixtureRoot)), files: filesOf(fixtureRoot) },
      typecheckProfile: { ...REACT95_TYPECHECK_PROFILE },
      build: {
        tool: 'esbuild', options: { ...REACT95_CLIENT_BUILD },
        inputs: [join(previewRoot, 'Preview.tsx'), join(previewRoot, 'preview.css')].map(path => ({ path: posix(relative(repoRoot, path)), sha256: sha256(readFileSync(path)) })),
        generator: 'apps/daemon/tests/workbench/g02-react95-receipt-build.ts buildReact95Receipt()',
      },
      bundledPackages: bundledPackages([...packages], work),
      templates,
    };
    return { receipt, previews };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- real browser (AC-R17.2 PRD widths) ---------------------------------------------------
function browserChecks(capture: ViewportCapture, width: number): React95CheckResult[] {
  const at = (kind: string) => `browser:${width}:${kind}`;
  const results: React95CheckResult[] = [];
  const doc = capture.document;
  results.push(check(at('no horizontal overflow'), capture.loadError === null && doc.scrollWidth <= doc.clientWidth && doc.layoutWidth === width && capture.outsideViewport.length === 0,
    capture.loadError ? 'the preview did not load' : `scrollWidth ${doc.scrollWidth} ≤ clientWidth ${doc.clientWidth}; ${capture.outsideViewport.length} text boxes outside the viewport`));
  // Pointer targets: every visible control (an input inside a label measures its label) and every enabled button.
  const sizes = [
    ...capture.controls.map(control => ({ name: readPageText(control.role), width: control.width, height: control.height })),
    ...capture.actions.filter(action => action.visible && !action.disabled && action.kind === 'button').map(action => ({ name: 'button', width: action.width, height: action.height })),
  ];
  const small = sizes.filter(size => size.width === undefined || size.height === undefined || Math.round(size.width) < 44 || Math.round(size.height) < 44);
  const smallest = sizes.reduce((min, size) => Math.min(min, Math.round(size.width ?? 0), Math.round(size.height ?? 0)), Number.POSITIVE_INFINITY);
  results.push(check(at('every interactive target is at least 44px'), capture.loadError === null && sizes.length > 0 && small.length === 0,
    small.length ? `below 44px: ${small.map(size => `${size.name} ${Math.round(size.width ?? 0)}×${Math.round(size.height ?? 0)}`).join(', ')}` : `${sizes.length} targets; smallest side ${smallest}px`));
  // Keyboard: Tab stops until focus leaves the document (or wraps), strictly in document order, each with a visible focus.
  const stops: ViewportCapture['keyboard']['steps'] = [];
  for (const step of capture.keyboard.steps) {
    if (step.selector === null || (stops[0] && step.selector.equals(stops[0].selector))) break;
    stops.push(step);
  }
  const ended = stops.length < capture.keyboard.steps.length;
  const ordered = stops.every((step, index) => index === 0 || (step.documentIndex ?? -1) > (stops[index - 1]!.documentIndex ?? Number.POSITIVE_INFINITY));
  const visible = stops.every(step => step.focusVisible);
  results.push(check(at('keyboard order follows the document with a visible focus at every stop'), stops.length > 0 && ended && ordered && visible,
    `${stops.length} stops; document order ${ordered}; focus visible ${visible}; trace ended ${ended}`));
  const unserved = capture.resources.filter(resource => resource.outcome !== 'served');
  results.push(check(at('no console errors and every resource served'), capture.console.length === 0 && unserved.length === 0 && capture.blockedRequests.length === 0,
    `${capture.console.length} console records, ${unserved.length} unserved resources, ${capture.blockedRequests.length} blocked requests`));
  return results;
}

/**
 * Renders each receipt-hashed preview document through the daemon's CDP
 * review worker (headless Chromium, network refused) at 320/375/768/1440,
 * one capture at a time in one browser session, and records the checks.
 */
export async function runReact95BrowserChecks(previews: Readonly<Record<string, string>>): Promise<React95BrowserReceipt> {
  const root = mkdtempSync(join(tmpdir(), 'react95-browser-'));
  const profiles = mkdtempSync(join(tmpdir(), 'react95-browser-profiles-'));
  try {
    for (const [id, html] of Object.entries(previews)) writeFileSync(join(root, `${id}.html`), html);
    const port = createCdpReviewPort(root, { profileRoot: profiles });
    const capability = await port.capability();
    if (!capability.available) throw new Error(`No headless browser for the React95 browser check: ${String(capability.reason)}`);
    const session = await port.open();
    try {
      const templates: React95BrowserReceipt['templates'] = [];
      for (const template of REACT95_KIT.templates) {
        const html = previews[template.id];
        if (html === undefined) throw new Error(`No preview for ${template.id}`);
        const checks: React95CheckResult[] = [];
        for (const width of REACT95_BROWSER_WIDTHS) {
          const capture = await session.capture({ url: `${port.origin}/${template.id}.html`, width, height: width < 768 ? 740 : 900, targets: [], probeAllActions: false });
          checks.push(...browserChecks(capture, width));
        }
        templates.push({ template: template.id, previewSha256: sha256(html), checks });
      }
      return { worker: 'cdp-review/headless', widths: [...REACT95_BROWSER_WIDTHS], templates };
    } finally { await session.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(profiles, { recursive: true, force: true });
  }
}

export function writeReact95Receipt({ receipt: built, previews }: { receipt: React95KitReceipt; previews: Record<string, string> }): void {
  // A failed real-browser check fails the whole receipt.
  const browserPassed = !!built.browser && built.browser.templates.every(entry => entry.checks.every(item => item.passed));
  const receipt: React95KitReceipt = { ...built, status: built.status === 'passed' && browserPassed ? 'passed' : 'failed' };
  writeFileSync(REACT95_RECEIPT_DOC_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(REACT95_RECEIPT_MODULE_PATH, [
    '// Generated by apps/daemon/tests/workbench/g02-react95-receipt-build.ts; do not edit.',
    '// Mirrors docs/plans/2026-10-02-design-workbench/evidence/implementation-start/g02-react95-receipt.json.',
    "import type { React95KitReceipt } from './react95-receipt.js';",
    '',
    `export const G02_REACT95_RECEIPT: React95KitReceipt | null = ${JSON.stringify(receipt, null, 2)};`,
    '',
  ].join('\n'));
  writeFileSync(REACT95_PREVIEW_MODULE_PATH, [
    '// Generated by apps/daemon/tests/workbench/g02-react95-receipt-build.ts; do not edit.',
    '// The isolated preview documents the G02 React95 receipt hashed (outputs.preview.sha256).',
    '',
    `export const REACT95_PREVIEWS: Readonly<Record<string, string>> = ${JSON.stringify(previews, null, 2)};`,
    '',
  ].join('\n'));
}

export const react95ReceiptArtifactsExist = () => existsSync(REACT95_RECEIPT_MODULE_PATH) && existsSync(REACT95_PREVIEW_MODULE_PATH);
