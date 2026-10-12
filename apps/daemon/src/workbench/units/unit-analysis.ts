import path from 'node:path';
import { load } from 'cheerio';
import type { ReusableUnitManifest } from '@mish/contracts';

type Dependency = ReusableUnitManifest['dependencies'][number];
type Capability = ReusableUnitManifest['capabilities'][number];

export interface SourceAnalysis {
  /** Project-relative local files this source references. */
  localRefs: Set<string>;
  /** References that cannot resolve inside the project (escapes, unsupported forms). */
  unresolved: string[];
  dependencies: Dependency[];
  capabilities: Set<Capability>;
  tokens: Map<string, string>;
}

const empty = (): SourceAnalysis => ({ localRefs: new Set(), unresolved: [], dependencies: [], capabilities: new Set(), tokens: new Map() });
const IGNORED_SCHEME = /^(?:data|blob|mailto|tel|javascript|about):/iu;
const REMOTE = /^(?:https?:)?\/\//iu;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Name and exact version from a pinned CDN URL; anything else is `unpinned`. */
export function dependencyFromUrl(raw: string, referencedFrom: string): Dependency {
  const href = raw.startsWith('//') ? `https:${raw}` : raw;
  let url: URL | null = null;
  try { url = new URL(href); } catch { /* recorded unpinned below */ }
  const pathname = url?.pathname ?? '';
  const match = /^\/(?:npm\/)?((?:@[^/@]+\/)?[^/@]+)@([^/]+)/u.exec(url && /(?:jsdelivr\.net|unpkg\.com|esm\.sh|skypack\.dev)$/u.test(url.hostname) ? pathname : '')
    ?? (url?.hostname === 'cdnjs.cloudflare.com' ? /^\/ajax\/libs\/([^/]+)\/([^/]+)\//u.exec(pathname) : null);
  const name = match?.[1] ?? (url ? `${url.hostname}${pathname}` : raw).slice(0, 300);
  const version = match?.[2] && EXACT_VERSION.test(match[2]) ? match[2] : 'unpinned';
  return { name, version, license: 'unknown', required: true, source: 'remote-url', url: url ? url.toString().slice(0, 2048) : null, referencedFrom };
}

function resolveLocal(ref: string, fromFile: string, out: SourceAnalysis): void {
  const value = ref.trim();
  if (!value || value.startsWith('#') || IGNORED_SCHEME.test(value)) return;
  if (REMOTE.test(value)) { out.dependencies.push(dependencyFromUrl(value, fromFile)); return; }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) { out.unresolved.push(value.slice(0, 200)); return; }
  const clean = value.split(/[?#]/u, 1)[0]!;
  let decoded: string;
  try { decoded = decodeURIComponent(clean); } catch { out.unresolved.push(value.slice(0, 200)); return; }
  const joined = decoded.startsWith('/') ? path.posix.normalize(decoded.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded));
  if (!joined || joined === '.' || joined.startsWith('../') || joined === '..' || joined.includes('\\')) { out.unresolved.push(value.slice(0, 200)); return; }
  out.localRefs.add(joined);
}

export function analyzeCss(text: string, fromFile: string, out: SourceAnalysis = empty()): SourceAnalysis {
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gu)) resolveLocal(match[1]!, fromFile, out);
  for (const match of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gu)) resolveLocal(match[2]!, fromFile, out);
  for (const match of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]{1,100})\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/gu)) {
    if (!out.tokens.has(match[1]!)) out.tokens.set(match[1]!, (match[2] ?? '').trim().slice(0, 200));
  }
  if (/@keyframes\b|\banimation\s*:|\btransition\s*:/u.test(text)) out.capabilities.add('animation');
  return out;
}

export function analyzeJs(text: string, fromFile: string, out: SourceAnalysis = empty()): SourceAnalysis {
  out.capabilities.add('script');
  const specifiers = [
    ...text.matchAll(/\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/gu),
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
  ].map(match => match[1]!);
  for (const specifier of specifiers) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || REMOTE.test(specifier)) resolveLocal(specifier, fromFile, out);
    else out.dependencies.push({ name: specifier.slice(0, 300), version: 'unpinned', license: 'unknown', required: true, source: 'bare-import', url: null, referencedFrom: fromFile });
  }
  if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource|sendBeacon/u.test(text)) out.capabilities.add('network');
  if (/requestAnimationFrame|\.animate\s*\(|\bgsap\b/u.test(text)) out.capabilities.add('animation');
  if (/getContext\(\s*["'](?:webgl2?|experimental-webgl)["']/u.test(text)) out.capabilities.add('webgl');
  return out;
}

const CSS_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/u;

export interface HtmlAnalysis extends SourceAnalysis {
  rootFound: boolean;
  rootError: string | null;
  rootCandidates: string[];
}

/** Root check, root suggestions, references, dependencies, capabilities and tokens of one HTML file. */
export function analyzeHtml(html: string, fromFile: string, rootSelector: string | null): HtmlAnalysis {
  const $ = load(html);
  const out = empty();
  let rootFound = false; let rootError: string | null = null;
  if (rootSelector !== null) {
    try { rootFound = $(rootSelector).length > 0; } catch { rootError = `"${rootSelector.slice(0, 120)}" is not a valid CSS selector`; }
  }
  const candidates: string[] = ['body'];
  for (const tag of ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer']) if ($(tag).length === 1) candidates.push(tag);
  $('[id]').each((_, element) => { const id = $(element).attr('id') ?? ''; if (CSS_IDENT.test(id) && candidates.length < 40) candidates.push(`#${id}`); });
  $('[data-od-unit]').each((_, element) => { const value = $(element).attr('data-od-unit') ?? ''; if (/^[A-Za-z0-9_-]{1,80}$/u.test(value) && candidates.length < 40) candidates.push(`[data-od-unit="${value}"]`); });

  // Only links that load bytes count; preconnect/canonical/alternate hints load nothing.
  $('link[href]').each((_, element) => {
    const rel = ($(element).attr('rel') ?? '').toLowerCase().split(/\s+/u);
    if (rel.some(token => ['stylesheet', 'icon', 'preload', 'modulepreload', 'manifest', 'apple-touch-icon'].includes(token))) resolveLocal($(element).attr('href') ?? '', fromFile, out);
  });
  $('script[src]').each((_, element) => { out.capabilities.add('script'); resolveLocal($(element).attr('src') ?? '', fromFile, out); });
  $('img[src], source[src], video[src], audio[src], track[src], iframe[src], embed[src], input[type="image"][src]').each((_, element) => resolveLocal($(element).attr('src') ?? '', fromFile, out));
  $('video[poster]').each((_, element) => resolveLocal($(element).attr('poster') ?? '', fromFile, out));
  $('img[srcset], source[srcset]').each((_, element) => {
    for (const part of ($(element).attr('srcset') ?? '').split(',')) { const ref = part.trim().split(/\s+/u)[0]; if (ref) resolveLocal(ref, fromFile, out); }
  });
  $('object[data]').each((_, element) => resolveLocal($(element).attr('data') ?? '', fromFile, out));
  $('style').each((_, element) => { analyzeCss($(element).text(), fromFile, out); });
  $('[style]').each((_, element) => { analyzeCss($(element).attr('style') ?? '', fromFile, out); });
  $('script:not([src])').each((_, element) => {
    const type = ($(element).attr('type') ?? '').toLowerCase();
    if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) return;
    analyzeJs($(element).text(), fromFile, out);
  });
  if ($('form').length) out.capabilities.add('form');
  out.dependencies = out.dependencies.filter((dep, index, all) => all.findIndex(other => (other.url ?? other.name) === (dep.url ?? dep.name)) === index);
  return { ...out, rootFound, rootError, rootCandidates: [...new Set(candidates)] };
}

export function mergeAnalysis(target: SourceAnalysis, source: SourceAnalysis): void {
  for (const ref of source.localRefs) target.localRefs.add(ref);
  target.unresolved.push(...source.unresolved);
  for (const dep of source.dependencies) if (!target.dependencies.some(other => (other.url ?? other.name) === (dep.url ?? dep.name))) target.dependencies.push(dep);
  for (const capability of source.capabilities) target.capabilities.add(capability);
  for (const [name, fallback] of source.tokens) if (!target.tokens.has(name)) target.tokens.set(name, fallback);
}

export const emptyAnalysis = empty;
