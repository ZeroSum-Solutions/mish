/**
 * Live preview of one Cult UI Pro catalog row, for the Catalog tab's preview modal
 * (`routes/cult-live-preview.ts`). Two sources, both on this machine only:
 *
 * - Sections and pages: the kit converter's static output for the item
 *   (`<kit>/converted/<name>/{template.html,styles.css,slots.json}`), filled with the item's own
 *   source text from slots.json and wrapped the way the converter's review page wraps it, under the
 *   family CSP a build ships (`COMPOSED_PAGE_CSP`: no script, inline style, no network). The light
 *   and dark themes are two sets of the seven `--role-*` values the converted CSS reads.
 * - Primitives and apps: the local preview harness (`<kits>/cult-ui-pro-preview`, outside the
 *   repo), which renders the item's own demo from the kit. `CultPreviewHarness` starts it on demand
 *   on a free loopback port, the way the web sidecar starts its standalone backend: a child
 *   process that exits when this daemon's pid is gone, a readiness probe, and one shared start
 *   for concurrent callers. A running instance is reused, found through the harness's own
 *   `.run/harness.json` (port, pid and a random token every harness request must carry). A child
 *   that fails to start or to answer its health check is killed at once, so a broken harness
 *   never leaves one orphan per preview click. The child gets a minimal environment
 *   (`harnessEnv`), never the daemon's API keys.
 *
 * Nothing here decides who may see a preview: the route applies `cultLocalOnlyRefusal` first.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CultPreviewTheme } from '@open-design/contracts';
import { cultPreviewArtwork } from './cult-preview-artwork.js';
import { cultPreviewPresentationCss } from './cult-preview-presentation.js';
import { cultRefinedSlot } from './cult-copy-refinements.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

// ---------------------------------------------------------------------------------------------
// Sections and pages: the converted static page
// ---------------------------------------------------------------------------------------------

interface SlotFile {
  text?: Array<{ name?: unknown; text?: unknown }>;
}

/** Light and dark values for the seven semantic roles the converted CSS reads. */
const ROLE_THEMES: Record<CultPreviewTheme, Record<string, string>> = {
  light: {
    background: '#ffffff', surface: '#f4f4f5', foreground: '#18181b', muted: '#71717a',
    accent: '#4f46e5', 'on-accent': '#ffffff', border: '#e4e4e7',
  },
  dark: {
    background: '#09090b', surface: '#18181b', foreground: '#fafafa', muted: '#a1a1aa',
    accent: '#818cf8', 'on-accent': '#0b0b1a', border: '#27272a',
  },
};
const ROLE_FONTS = '--role-font-display:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;'
  + '--role-font-body:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--role-font-mono:ui-monospace,Menlo,monospace';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * Fills a converter template: `{{#if slot}}…{{/if}}` keeps its body when the slot has text, and
 * `{{slot}}` becomes the slot's escaped text. The converter emits no other syntax and never nests
 * an `#if`; an unknown slot renders empty.
 */
export function fillConvertedTemplate(template: string, text: ReadonlyMap<string, string>): string {
  const withIfs = template.replace(/\{\{#if ([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, slot: string, body: string) =>
    ((text.get(slot) ?? '').length > 0 ? body : ''));
  return withIfs.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, slot: string) => escapeHtml(text.get(slot) ?? ''));
}

/** The converter's directory for one item, or null when the name is unsafe or has none. */
export function convertedDir(kitDir: string | null, name: string): string | null {
  if (kitDir === null || !NAME.test(name)) return null;
  const base = path.resolve(kitDir, 'converted');
  const dir = path.resolve(base, name);
  if (path.dirname(dir) !== base) return null;
  return existsSync(path.join(dir, 'template.html')) && existsSync(path.join(dir, 'styles.css')) ? dir : null;
}

export const CONVERTED_ARTWORK_NOTE = 'Original Higgsfield imagery fills image slots in this layout preview. Portraits show fictional people. Supply your own images in a build.';
export const CONVERTED_STATIC_DEMO_NOTE = 'Static illustrative layout preview. Animated typing and tab changes are not available here.';
export function convertedPreviewMockNote(kitDir: string | null, name: string): string | null {
  const dir = convertedDir(kitDir, name);
  if (!dir) return null;
  const template = readFileSync(path.join(dir, 'template.html'), 'utf8');
  const notes = [cultPreviewArtwork(template, name) !== template ? CONVERTED_ARTWORK_NOTE : null,
    name === 'organic--tabs-showcase' && EMPTY_TABS_MESSAGE.test(template) ? CONVERTED_STATIC_DEMO_NOTE : null].filter(Boolean);
  return notes.length ? notes.join(' ') : null;
}

// These two converter outputs retain frozen interactive-demo scaffolding and microscopic
// labels. Repair their presentation only at the preview boundary; the kit and readiness stay
// unchanged. The class hooks are the reviewed converter output, not a general HTML rewrite.
const EMPTY_TABS_MESSAGE = /<p\b([^>]*\bclass="[^"]*\bhss\b[^"]*"[^>]*)>\s*<span\b[^>]*\bclass="[^"]*\bhst\b[^"]*"[^>]*>\s*<\/span>\s*<\/p>/i;
function withPreviewDetails(body: string, name: string, section: string): { body: string; css: string; note: string | null } {
  if (name === 'marketing-cta-animated') {
    // KineticText is script-driven in the source. The converter leaves two empty spans.
    return {
      body: body.replace('<span class="c1 c8"></span><br><span class="c1 c8 cw"></span>', '<span class="c1 c8">Make the idea</span><br><span class="c1 c8 cw">real.</span>'),
      css: '',
      note: CONVERTED_STATIC_DEMO_NOTE,
    };
  }
  if (name === 'organic--tabs-showcase' && EMPTY_TABS_MESSAGE.test(body)) {
    const scope = `#${section} .cult-organic--tabs-showcase`;
    const message = '<span data-preview-tabs-kicker>LAYOUT STUDY / 01</span><strong>Space for the idea.</strong>'
      + '<span>A steady grid keeps the message clear. Give the primary action one unmistakable place.</span>'
      + '<span data-preview-tabs-grid><span>Type</span><span>Space</span><span>Action</span></span>';
    return {
      body: body.replace(EMPTY_TABS_MESSAGE, `<p$1 data-preview-tabs-message>${message}</p>`).replace(/<span class="hsi">Live<\/span>/, '<span class="hsi">Static</span>'),
      note: CONVERTED_STATIC_DEMO_NOTE,
      css: `${scope} .hs2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-height:0;--ga-fg:var(--role-background);--ga-fg-body:var(--role-background);--ga-fg-muted:color-mix(in srgb,var(--role-background) 78%,var(--role-foreground))}`
        + `${scope} .hs3,${scope} .hsk{min-width:0;padding:40px;width:auto}`
        + `${scope} .hsk{justify-content:center}${scope} .hsj{display:none}`
        + `${scope} .hsq{aspect-ratio:auto;min-height:260px;padding:28px}`
        + `${scope} .hsr{height:auto;max-height:none;overflow:visible}`
        + `${scope} [data-preview-tabs-message]{mask-image:none;-webkit-mask-image:none;color:var(--role-foreground);background:var(--role-background);padding:24px;border-radius:12px;font-size:15px;line-height:1.6;overflow-wrap:break-word}`
        + `${scope} [data-preview-tabs-message]>span,${scope} [data-preview-tabs-message]>strong{display:block}`
        + `${scope} [data-preview-tabs-message]>strong{font-size:24px;line-height:1.15;letter-spacing:-.025em;margin:14px 0}`
        + `${scope} [data-preview-tabs-kicker]{font:10px/1.4 var(--role-font-mono);letter-spacing:.08em}`
        + `${scope} [data-preview-tabs-message]>[data-preview-tabs-grid]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:22px}`
        + `${scope} [data-preview-tabs-grid]>span{padding:8px 4px;text-align:center;font-size:11px;background:var(--role-surface);border:1px solid var(--role-border)}`
        + `@media(max-width:640px){${scope} .hs2{grid-template-columns:minmax(0,1fr)}${scope} .hs3,${scope} .hsk{padding:24px}${scope} .hsm{display:block}${scope} .hsn{display:none}${scope} .hsq{min-height:0;padding:0}${scope} [data-preview-tabs-message]{padding:22px}}`,
    };
  }
  if (name === 'sass-colorful--features') {
    const scope = `#${section} .cult-sass-colorful--features`;
    return {
      body: body.replace(/<span>(THE DESIGN|ZEPXEN|OPS|BASELINE)<\/span>/g, '<span data-preview-feature-label>$1</span>'),
      css: `${scope} [data-preview-feature-label]{display:inline-flex;width:fit-content;padding:2px 5px;font-size:11px;line-height:1.35;font-weight:600;letter-spacing:.02em;color:var(--role-foreground);background:var(--role-background);border-radius:2px}`,
      note: null,
    };
  }
  return { body, css: '', note: null };
}

/** The full static page for a section or page row, or null when the kit has no converted output. */
export function convertedPreviewHtml(kitDir: string | null, name: string, theme: CultPreviewTheme, csp: string): string | null {
  const dir = convertedDir(kitDir, name);
  if (dir === null) return null;
  const template = readFileSync(path.join(dir, 'template.html'), 'utf8');
  const css = readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const slotsFile = path.join(dir, 'slots.json');
  const slots = existsSync(slotsFile) ? JSON.parse(readFileSync(slotsFile, 'utf8')) as SlotFile : {};
  const text = new Map<string, string>();
  for (const slot of slots.text ?? []) {
    if (typeof slot.name === 'string' && typeof slot.text === 'string') text.set(slot.name, cultRefinedSlot(name, slot.name, slot.text));
  }
  const roles = Object.entries(ROLE_THEMES[theme]).map(([role, value]) => `--role-${role}:${value}`).join(';');
  const section = 'od-live-preview';
  const scope = `[data-od-section="${section}"]`;
  const base = `:root{${roles};${ROLE_FONTS};color-scheme:${theme}}html,body{margin:0;background:var(--role-background)}`
    + `${scope} :is(a,button,[tabindex]):focus-visible{outline:3px solid var(--role-accent);outline-offset:3px}`
    + `@media (prefers-reduced-motion: reduce){${scope} *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
  const filled = fillConvertedTemplate(template, text).replace(/<\/style/gi, '<\\/style');
  const artworkBody = cultPreviewArtwork(filled, name);
  const hasArtwork = artworkBody !== filled;
  const details = withPreviewDetails(artworkBody, name, section);
  const body = details.body;
  const note = [hasArtwork ? CONVERTED_ARTWORK_NOTE : null, details.note].filter(Boolean).join(' ');
  const artworkCss = hasArtwork ? `${scope} .cult-img-box{overflow:hidden}${scope} .cult-img-box>img{display:block;width:100%;height:100%;object-fit:cover}${scope} .cult-organic--banner-section .cult-img-box{width:min(450px,82vw)}` : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title>'
    + `<style>${base}${artworkCss}${details.css}</style></head><body><div id="${section}" data-od-section="${section}">`
    + `<style>${css.replace(/<\/style/gi, '<\\/style')}${cultPreviewPresentationCss(name)}</style>${body}</div>${note ? `<p style="padding:12px 24px;font:12px/1.5 system-ui;color:var(--role-muted)">${escapeHtml(note)}</p>` : ''}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Primitives and apps: the local preview harness
// ---------------------------------------------------------------------------------------------

export type HarnessInfo = { live: true; supportsDark: boolean; mockNote: string | null } | { live: false; reason: string };
export type HarnessPage = { status: number; html: string } | { status: number; reason: string };

export class CultHarnessUnavailable extends Error {}

/**
 * The harness child's whole environment: what Node needs to run, the four `CULT_*` values, and
 * `ELECTRON_RUN_AS_NODE` when the daemon itself runs under Electron's Node. Nothing else from the
 * daemon's environment (API keys, tokens) reaches the harness.
 */
export function harnessEnv(base: NodeJS.ProcessEnv, values: { token: string; kitDir: string; parentPid: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PORT: '0',
    CULT_PREVIEW_TOKEN: values.token,
    CULT_KIT_DIR: values.kitDir,
    CULT_PREVIEW_PARENT_PID: String(values.parentPid),
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'ELECTRON_RUN_AS_NODE'] as const) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface HarnessState { port: number; pid: number; token: string }

export interface CultPreviewHarnessOptions {
  /** The harness directory (server.mjs + node_modules); null when it is not installed. */
  dir: string | null;
  kitDir: string | null;
  /** The Node binary that runs the harness. Defaults to this daemon's own. */
  nodePath?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** `CULT_PREVIEW_HARNESS_DIR`, else `cult-ui-pro-preview` next to the kit; null when absent. */
export function resolveCultPreviewHarnessDir(kitDir: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CULT_PREVIEW_HARNESS_DIR?.trim();
  const dir = configured ? path.resolve(configured) : kitDir ? path.join(path.dirname(kitDir), 'cult-ui-pro-preview') : null;
  return dir !== null && existsSync(path.join(dir, 'server.mjs')) && existsSync(path.join(dir, 'node_modules')) ? dir : null;
}

export class CultPreviewHarness {
  private readonly options: Required<Omit<CultPreviewHarnessOptions, 'dir' | 'kitDir'>> & Pick<CultPreviewHarnessOptions, 'dir' | 'kitDir'>;
  private state: HarnessState | null = null;
  private starting: Promise<HarnessState> | null = null;
  private child: ChildProcess | null = null;

  constructor(options: CultPreviewHarnessOptions) {
    this.options = {
      nodePath: process.execPath,
      startTimeoutMs: 20_000,
      requestTimeoutMs: 60_000,
      ...options,
    };
  }

  get installed(): boolean {
    return this.options.dir !== null && this.options.kitDir !== null;
  }

  /** The running harness: this process's, a reused one from .run/harness.json, or a new start. */
  async ensure(): Promise<HarnessState> {
    if (!this.installed) throw new CultHarnessUnavailable('the local preview harness is not installed on this machine');
    if (this.state && (await this.healthy(this.state))) return this.state;
    this.state = null;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    this.state = await this.starting;
    return this.state;
  }

  async info(name: string): Promise<HarnessInfo> {
    const res = await this.request(`/info/${encodeURIComponent(name)}`);
    const body = await res.json() as { live?: unknown; supportsDark?: unknown; mockNote?: unknown; reason?: unknown; error?: unknown };
    if (!res.ok) return { live: false, reason: typeof body.error === 'string' ? body.error : `the harness answered ${res.status}` };
    if (body.live === true) {
      return { live: true, supportsDark: body.supportsDark === true, mockNote: typeof body.mockNote === 'string' ? body.mockNote : null };
    }
    return { live: false, reason: typeof body.reason === 'string' ? body.reason : 'the harness could not build it' };
  }

  async page(name: string, theme: CultPreviewTheme): Promise<HarnessPage> {
    const res = await this.request(`/p/${encodeURIComponent(name)}?theme=${theme}`);
    if (res.ok) return { status: 200, html: await res.text() };
    const body = await res.json().catch(() => ({})) as { reason?: unknown; error?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : `the harness answered ${res.status}`;
    return { status: res.status, reason };
  }

  /** Stops a harness this process started (tests; the parent-pid monitor covers a daemon exit). */
  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.state = null;
  }

  private stateFile(): string {
    return path.join(this.options.dir!, '.run', 'harness.json');
  }

  private async request(pathname: string): Promise<Response> {
    const state = await this.ensure();
    return fetch(`http://127.0.0.1:${state.port}${pathname}`, {
      headers: { 'x-cult-preview-token': state.token },
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
  }

  private async healthy(state: HarnessState): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const body = await res.json() as { ok?: unknown; app?: unknown; pid?: unknown };
      return body.ok === true && body.app === 'cult-ui-pro-preview' && body.pid === state.pid;
    } catch {
      return false;
    }
  }

  private readState(): HarnessState | null {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(), 'utf8')) as Partial<HarnessState>;
      if (Number.isInteger(raw.port) && Number.isInteger(raw.pid) && typeof raw.token === 'string' && raw.token.length >= 16) {
        return { port: raw.port!, pid: raw.pid!, token: raw.token };
      }
    } catch {
      // No state file, or a torn one: start a new harness.
    }
    return null;
  }

  private async start(): Promise<HarnessState> {
    const reused = this.readState();
    if (reused && (await this.healthy(reused))) return reused;

    const token = randomBytes(24).toString('hex');
    const child = spawn(this.options.nodePath, ['server.mjs'], {
      cwd: this.options.dir!,
      env: harnessEnv(process.env, { token, kitDir: this.options.kitDir!, parentPid: process.pid }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    // Every failure below kills the child it started and forgets it, before the caller sees the error.
    const abandon = (error: CultHarnessUnavailable): CultHarnessUnavailable => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (this.child === child) this.child = null;
      return error;
    };
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        reject(abandon(new CultHarnessUnavailable(`the preview harness did not start within ${this.options.startTimeoutMs} ms`)));
      }, this.options.startTimeoutMs);
      child.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /listening (\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(abandon(new CultHarnessUnavailable(`the preview harness failed to start: ${error.message}`)));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(abandon(new CultHarnessUnavailable(`the preview harness exited (${code ?? 'signal'}): ${err.split('\n')[0]?.slice(0, 160) ?? ''}`)));
      });
    });
    child.stdout!.resume();
    child.stderr!.resume();
    const state = { port, pid: child.pid!, token };
    if (!(await this.healthy(state))) throw abandon(new CultHarnessUnavailable('the preview harness started but does not answer'));
    mkdirSync(path.dirname(this.stateFile()), { recursive: true });
    writeFileSync(this.stateFile(), JSON.stringify(state), { mode: 0o600 });
    return state;
  }
}
