import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { catalogAsset } from './catalog-block.ts';

// Reviewed GenUI effect placements: a family's `catalog.json` `effects` declaration and the
// deterministic decoration of a rendered page. Shared: edit plugins/_official/shared/agency-compiler,
// then sync. Rationale: that folder's README.md, "Effect placements".

export const EFFECT_PLACEMENT_IDS = ['hero-background', 'hero-title', 'eyebrow', 'section-title', 'card-surface', 'nav', 'section-reveal', 'testimonials', 'gallery', 'cta'] as const;
export type EffectPlacementId = (typeof EFFECT_PLACEMENT_IDS)[number];
/** Over the byte budget, the first placement here is dropped first. */
export const EFFECT_DROP_ORDER: readonly EffectPlacementId[] = ['section-reveal', 'card-surface', 'section-title', 'eyebrow', 'cta', 'gallery', 'testimonials', 'nav', 'hero-background', 'hero-title'];
/** A decorated page must stay strictly below this many UTF-8 bytes. */
export const PAGE_BYTE_LIMIT = 200 * 1024;

export type EffectKind = 'css-only' | 'js';
export type EffectScriptPolicy = 'none' | 'hash' | 'inline';
export type EffectSkipReason = 'not-allowed' | 'script-policy' | 'byte-budget' | 'max-effects' | 'host-missing' | 'host-occupied' | 'incompatible';
export type EffectHost = { id: string } | { odId: string };
export interface EffectPlacement { host: EffectHost; allow: string[] }
export interface FamilyEffectDeclaration {
  scriptPolicy: EffectScriptPolicy;
  maxEffects: number;
  placements: Partial<Record<EffectPlacementId, EffectPlacement>>;
}
/** `hint` = named in the request; `jev` = chosen by Jev; `repair` = replayed from a saved build.
 * Provenance only: no check in this module reads it. */
export type EffectSource = 'hint' | 'jev' | 'repair';
export interface EffectPlan { effects: Array<{ placement: EffectPlacementId; componentId: string; source: EffectSource }> }
export interface EffectRenderReport {
  applied: Array<{ placement: EffectPlacementId; componentId: string; kind: EffectKind; source: EffectSource }>;
  skipped: Array<{ placement: EffectPlacementId; componentId?: string; reason: EffectSkipReason }>;
  bytesAdded: number;
}

/**
 * The page (with no effect on it) is at or over `PAGE_BYTE_LIMIT`. `code` is fixed, so a caller
 * in another module copy can recognise it without `instanceof`.
 */
export class PageByteLimitError extends Error {
  readonly code = 'page-too-large';
  readonly bytes: number;
  readonly limit = PAGE_BYTE_LIMIT;
  constructor(bytes: number) {
    super(`effects: the base page is ${bytes} bytes, at or over the ${PAGE_BYTE_LIMIT}-byte page limit`);
    this.name = 'PageByteLimitError';
    this.bytes = bytes;
  }
}

const SCRIPTS_DIR = import.meta.dirname;
const FAMILY = /^[a-z][a-z0-9-]{0,63}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,63}$/;
const HOST_VALUE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const POLICIES: readonly EffectScriptPolicy[] = ['none', 'hash', 'inline'];
const isPlacement = (value: unknown): value is EffectPlacementId => (EFFECT_PLACEMENT_IDS as readonly unknown[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

let kinds: Map<string, EffectKind> | undefined;
/** A component's kind, from this copy's generated `catalog/CATALOG.json`. */
export function componentKind(id: string): EffectKind {
  if (!kinds) {
    const file = path.join(SCRIPTS_DIR, 'catalog/CATALOG.json');
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const components = isRecord(parsed) && isRecord(parsed.components) ? parsed.components : {};
    kinds = new Map();
    for (const [key, value] of Object.entries(components)) {
      const kind = isRecord(value) ? value.kind : undefined;
      if (kind === 'css-only' || kind === 'js') kinds.set(key, kind);
    }
  }
  const kind = kinds.get(id);
  if (!kind) throw new Error(`catalog component ${JSON.stringify(id)}: no kind in this compiler copy's catalog/CATALOG.json`);
  return kind;
}

/** Validates a family's `effects` declaration against its `catalogComponents`. Throws on any defect. */
export function parseFamilyEffectDeclaration(value: unknown, catalogComponents: readonly string[], label: string): FamilyEffectDeclaration {
  const fail = (detail: string): never => { throw new Error(`${label}: effects ${detail}`); };
  if (!isRecord(value)) return fail('must be an object');
  for (const key of Object.keys(value)) if (!['scriptPolicy', 'maxEffects', 'placements'].includes(key)) fail(`has unknown field ${JSON.stringify(key)}`);
  const scriptPolicy = value.scriptPolicy as EffectScriptPolicy;
  if (!POLICIES.includes(scriptPolicy)) fail('scriptPolicy must be none, hash or inline');
  const maxEffects = value.maxEffects;
  if (typeof maxEffects !== 'number' || !Number.isInteger(maxEffects) || maxEffects < 1 || maxEffects > 10) fail('maxEffects must be an integer from 1 to 10');
  if (!isRecord(value.placements)) return fail('placements must be an object');
  const placements: Partial<Record<EffectPlacementId, EffectPlacement>> = {};
  for (const [placement, raw] of Object.entries(value.placements)) {
    if (!isPlacement(placement)) fail(`placement ${JSON.stringify(placement)} is not a known placement id`);
    const at = `placements.${placement}`;
    if (!isRecord(raw) || Object.keys(raw).some((key) => key !== 'host' && key !== 'allow')) fail(`${at} must be {host, allow}`);
    const entry = raw as Record<string, unknown>;
    const host = entry.host;
    const hostKeys = isRecord(host) ? Object.keys(host) : [];
    if (!isRecord(host) || hostKeys.length !== 1 || !['id', 'odId'].includes(hostKeys[0]!)) fail(`${at}.host must be {"id": …} or {"odId": …}`);
    const hostValue = (host as Record<string, unknown>)[hostKeys[0]!];
    if (typeof hostValue !== 'string' || !HOST_VALUE.test(hostValue)) fail(`${at}.host value is not a plain id`);
    const allow = entry.allow;
    if (!Array.isArray(allow) || allow.length === 0 || new Set(allow).size !== allow.length) fail(`${at}.allow must be a non-empty list of unique component ids`);
    for (const id of allow as unknown[]) {
      if (typeof id !== 'string' || !COMPONENT.test(id)) fail(`${at}.allow has an invalid component id`);
      // `none` is the "no effect" sentinel and placement ids name slots: neither is ever a component.
      if (id === 'none' || isPlacement(id)) fail(`${at}.allow lists "${id}", which is reserved and never a component id`);
      if (!catalogComponents.includes(id as string)) fail(`${at}.allow lists "${id}", which catalogComponents does not declare`);
      if (scriptPolicy === 'none' && componentKind(id as string) !== 'css-only') fail(`${at}.allow lists js component "${id}" under scriptPolicy none`);
    }
    placements[placement as EffectPlacementId] = {
      host: hostKeys[0] === 'id' ? { id: hostValue as string } : { odId: hostValue as string },
      allow: [...(allow as string[])],
    };
  }
  return { scriptPolicy, maxEffects: maxEffects as number, placements };
}

const declarations = new Map<string, FamilyEffectDeclaration | null>();
/** The validated `effects` of `families/<family>/catalog.json` in this copy, or null when it declares none. */
export function readFamilyEffectDeclaration(family: string): FamilyEffectDeclaration | null {
  if (!FAMILY.test(family)) throw new Error(`family id: ${JSON.stringify(family)} is not a family id`);
  if (declarations.has(family)) return declarations.get(family)!;
  const file = path.join(SCRIPTS_DIR, 'families', family, 'catalog.json');
  let declaration: FamilyEffectDeclaration | null = null;
  if (existsSync(file)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && parsed.effects !== undefined) {
      const components = Array.isArray(parsed.catalogComponents) ? parsed.catalogComponents.filter((id): id is string => typeof id === 'string') : [];
      declaration = parseFamilyEffectDeclaration(parsed.effects, components, `families/${family}/catalog.json`);
    }
  }
  declarations.set(family, declaration);
  return declaration;
}

// Structural scan: tags outside comments and raw-text elements, with their attribute spans, so a
// tag or attribute written inside a script, style or comment is never mistaken for markup.
type Attr = { name: string; value: string; start: number; end: number; valueStart: number; valueEnd: number; quote: string };
type Tag = { name: string; close: boolean; start: number; nameEnd: number; end: number; attrs: Attr[] };
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const SPACE = /[\t\n\f\r ]/;
const NAME_END = /[\t\n\f\r />]/;
const ATTR_NAME_END = /[\t\n\f\r />=]/;
const UNQUOTED_END = /[\t\n\f\r >]/;
const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

function scanTags(html: string): Tag[] {
  const lower = asciiLower(html);
  const length = html.length;
  const tags: Tag[] = [];
  let i = 0;
  while (i < length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const close = html[lt + 1] === '/';
    const nameStart = lt + (close ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? '')) { i = lt + 1; continue; }
    let k = nameStart;
    while (k < length && !NAME_END.test(html[k]!)) k++;
    const name = lower.slice(nameStart, k);
    const nameEnd = k;
    const attrs: Attr[] = [];
    let end = -1;
    while (k < length) {
      while (k < length && (SPACE.test(html[k]!) || html[k] === '/')) k++;
      if (k >= length) break;
      if (html[k] === '>') { end = k + 1; break; }
      const start = k;
      k++;
      while (k < length && !ATTR_NAME_END.test(html[k]!)) k++;
      const attrName = lower.slice(start, k);
      let p = k;
      while (p < length && SPACE.test(html[p]!)) p++;
      if (html[p] !== '=') { attrs.push({ name: attrName, value: '', start, end: k, valueStart: k, valueEnd: k, quote: '' }); continue; }
      p++;
      while (p < length && SPACE.test(html[p]!)) p++;
      const quote = html[p];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, p + 1);
        if (close < 0) { k = length; break; }
        attrs.push({ name: attrName, value: html.slice(p + 1, close), start, end: close + 1, valueStart: p + 1, valueEnd: close, quote });
        k = close + 1;
      } else {
        let e = p;
        while (e < length && !UNQUOTED_END.test(html[e]!)) e++;
        attrs.push({ name: attrName, value: html.slice(p, e), start, end: e, valueStart: p, valueEnd: e, quote: '' });
        k = e;
      }
    }
    if (end < 0) break;
    tags.push({ name, close, start: lt, nameEnd, end, attrs });
    i = end;
    if (!close && RAW_TEXT.has(name)) {
      let s = end;
      let found = -1;
      while ((s = lower.indexOf(`</${name}`, s)) >= 0) {
        const after = html[s + 2 + name.length];
        if (after === undefined || NAME_END.test(after)) { found = s; break; }
        s += 2;
      }
      if (found < 0) break;
      i = found;
    }
  }
  return tags;
}

/** First occurrence of an attribute on a tag, as the HTML parser keeps it. */
const attr = (tag: Tag, name: string): Attr | undefined => tag.attrs.find((candidate) => candidate.name === name);

type Page = { tags: Tag[]; headClose: Tag; bodyClose: Tag; csp: Attr | undefined; styles: Set<string>; scripts: Set<string> };

function readPage(html: string): Page {
  const tags = scanTags(html);
  const headClose = tags.find((tag) => tag.close && tag.name === 'head');
  const bodyClose = tags.find((tag) => tag.close && tag.name === 'body');
  if (!headClose || !bodyClose) throw new Error('effects: the rendered page has no real </head> or </body>');
  const metas = tags.filter((tag) => !tag.close && tag.name === 'meta' && tag.start < headClose.start
    && asciiLower(attr(tag, 'http-equiv')?.value ?? '') === 'content-security-policy');
  if (metas.length > 1) throw new Error('effects: the rendered page carries more than one CSP meta');
  const ids = (name: string, attribute: string) => new Set(tags.filter((tag) => !tag.close && tag.name === name).map((tag) => attr(tag, attribute)?.value).filter((id): id is string => id !== undefined));
  return { tags, headClose, bodyClose, csp: metas[0] ? attr(metas[0], 'content') : undefined, styles: ids('style', 'data-genui-style'), scripts: ids('script', 'data-genui-script') };
}

function hostTags(page: Page, host: EffectHost): Tag[] {
  const [name, value] = 'id' in host ? ['id', host.id] : ['data-od-id', host.odId];
  return page.tags.filter((tag) => !tag.close && attr(tag, name)?.value === value);
}

/** CSP3 hash source: base64 of the SHA-256 of the script element's exact text. */
export function scriptHashSource(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function directives(value: string): string[] {
  return value.split(';');
}
const directiveName = (directive: string): string => asciiLower(directive.trim().split(/[\t\n\f\r ]+/)[0] ?? '');

type Accepted = { index: number; placement: EffectPlacementId; componentId: string; kind: EffectKind; source: EffectSource; host: Tag };
type Edit = { at: number; remove: number; text: string };

function decorate(host: Tag, id: string): Edit[] {
  const edits: Edit[] = [];
  const cls = `genui-${id}`;
  const current = attr(host, 'class');
  let insert = ` data-genui="${id}"`;
  if (!current) insert = ` class="${cls}"${insert}`;
  else if (!current.value.split(/[\t\n\f\r ]+/).includes(cls)) {
    if (current.quote) edits.push({ at: current.valueEnd, remove: 0, text: current.value.trim() ? ` ${cls}` : cls });
    else edits.push({ at: current.start, remove: current.end - current.start, text: `class="${current.value} ${cls}"` });
  }
  edits.push({ at: host.nameEnd, remove: 0, text: insert });
  return edits;
}

function build(html: string, page: Page, active: readonly Accepted[], policy: EffectScriptPolicy): string {
  const edits: Edit[] = active.flatMap((item) => decorate(item.host, item.componentId));
  const ids = [...new Set(active.map((item) => item.componentId))];
  const styles = ids.filter((id) => !page.styles.has(id)).map((id) => `<style data-genui-style="${id}">${catalogAsset(id, 'styles.css')}</style>`).join('');
  if (styles) edits.push({ at: page.headClose.start, remove: 0, text: styles });
  const scripts = ids.filter((id) => componentKind(id) === 'js' && !page.scripts.has(id)).map((id) => ({ id, text: catalogAsset(id, 'auto.js') }));
  if (scripts.length > 0) {
    edits.push({ at: page.bodyClose.start, remove: 0, text: scripts.map(({ id, text }) => `<script type="module" data-genui-script="${id}">${text}</script>`).join('') });
    const csp = page.csp;
    const scriptSrc = csp ? directives(csp.value).findIndex((directive) => directiveName(directive) === 'script-src') : -1;
    if (policy === 'hash') {
      if (!csp || csp.quote !== '"' || scriptSrc < 0) throw new Error('effects: a hash-policy page requires a CSP script-src directive');
      const parts = directives(csp.value);
      if (parts.some((part) => ['script-src-elem', 'script-src-attr'].includes(directiveName(part)))) throw new Error('effects: a hash-policy page cannot override script-src');
      if (parts.filter((part) => directiveName(part) === 'script-src').length !== 1) throw new Error('effects: duplicate script-src directive');
      const tokens = parts[scriptSrc]!.trim().split(/[\t\n\f\r ]+/).slice(1);
      // A family may carry its own progressive enhancement. Authorize only the exact inline
      // bytes already present when previously authorized; a none policy keeps existing scripts blocked.
      // External sources, permissive keywords and stale hashes fail closed.
      const existing = new Set(page.tags.filter((tag) => !tag.close && tag.name === 'script').map((tag) => {
        if (attr(tag, 'src')) throw new Error('effects: a hash-policy page cannot carry external scripts');
        const end = page.tags.find((candidate) => candidate.close && candidate.name === 'script' && candidate.start >= tag.end);
        if (!end) throw new Error('effects: an inline script must close');
        return scriptHashSource(html.slice(tag.end, end.start));
      }));
      const none = tokens.length === 1 && tokens[0] === "'none'";
      if (!none && (tokens.length === 0 || tokens.some((token) => !existing.has(token)) || existing.size !== new Set(tokens).size)) {
        throw new Error('effects: script-src must exactly match the hashes of existing inline scripts, or none to keep existing scripts blocked');
      }
      const lead = /^[\t\n\f\r ]*/.exec(parts[scriptSrc]!)![0];
      parts[scriptSrc] = `${lead}${['script-src', ...new Set([...(none ? [] : existing), ...scripts.map(({ text }) => scriptHashSource(text))])].join(' ')}`;
      edits.push({ at: csp.valueStart, remove: csp.valueEnd - csp.valueStart, text: parts.join(';') });
    } else if (csp && scriptSrc >= 0 && !directives(csp.value)[scriptSrc]!.includes("'unsafe-inline'")) {
      throw new Error("effects: an inline-policy page must ship script-src 'unsafe-inline'");
    }
  }
  let out = html;
  for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.remove);
  return out;
}

/**
 * Applies a validated effect plan to a rendered page: decorates each host, inlines each component's
 * CSS once before </head> and its auto.js once before </body>, allows that script by hash on a
 * hash-policy page, and keeps the page strictly below PAGE_BYTE_LIMIT. Throws when the base page is
 * already at or over the limit.
 */
export function applyEffectPlan(html: string, plan: EffectPlan, declaration: FamilyEffectDeclaration | null): { html: string; report: EffectRenderReport } {
  if (!isRecord(plan) || !Array.isArray(plan.effects)) throw new Error('effects: plan must be {effects: [...]}');
  const base = utf8(html);
  if (base >= PAGE_BYTE_LIMIT) throw new PageByteLimitError(base);
  const page = readPage(html);
  const skipped: Array<EffectRenderReport['skipped'][number] & { index: number }> = [];
  const accepted: Accepted[] = [];
  const claimed = new Set<number>();
  const placed = new Set<string>();
  plan.effects.forEach((item, index) => {
    if (!isRecord(item) || typeof item.placement !== 'string' || typeof item.componentId !== 'string' || (item.source !== 'hint' && item.source !== 'jev' && item.source !== 'repair')) {
      throw new Error(`effects: plan item ${index} must be {placement, componentId, source}`);
    }
    const { placement, componentId, source } = item;
    const skip = (reason: EffectSkipReason) => skipped.push({ index, placement, componentId, reason });
    const entry = declaration && isPlacement(placement) ? declaration.placements[placement] : undefined;
    if (!declaration || !entry || !entry.allow.includes(componentId)) return skip('not-allowed');
    if (placed.has(placement)) return skip('incompatible');
    const kind = componentKind(componentId);
    if (kind === 'js' && declaration.scriptPolicy === 'none') return skip('script-policy');
    const hosts = hostTags(page, entry.host);
    if (hosts.length === 0) return skip('host-missing');
    if (hosts.length > 1) return skip('incompatible');
    const host = hosts[0]!;
    // Occupied: a `data-genui` component, a family that mounted one by its `genui-<id>` class
    // alone, or an earlier item of this plan.
    const classes = attr(host, 'class')?.value.split(/[\t\n\f\r ]+/) ?? [];
    if (attr(host, 'data-genui') || classes.some((token) => token.startsWith('genui-')) || claimed.has(host.start)) return skip('host-occupied');
    if (accepted.length >= declaration.maxEffects) return skip('max-effects');
    claimed.add(host.start);
    placed.add(placement);
    accepted.push({ index, placement, componentId, kind, source, host });
  });
  const policy = declaration?.scriptPolicy ?? 'none';
  let active = accepted;
  let out = build(html, page, active, policy);
  while (utf8(out) >= PAGE_BYTE_LIMIT && active.length > 0) {
    const rank = (item: Accepted) => EFFECT_DROP_ORDER.indexOf(item.placement);
    const victim = active.reduce((worst, item) => (rank(item) < rank(worst) || (rank(item) === rank(worst) && item.index > worst.index) ? item : worst));
    skipped.push({ index: victim.index, placement: victim.placement, componentId: victim.componentId, reason: 'byte-budget' });
    active = active.filter((item) => item !== victim);
    out = build(html, page, active, policy);
  }
  return {
    html: out,
    report: {
      applied: active.map(({ placement, componentId, kind, source }) => ({ placement, componentId, kind, source })),
      skipped: skipped.sort((a, b) => a.index - b.index).map(({ placement, componentId, reason }) => (componentId === undefined ? { placement, reason } : { placement, componentId, reason })),
      bytesAdded: utf8(out) - base,
    },
  };
}
