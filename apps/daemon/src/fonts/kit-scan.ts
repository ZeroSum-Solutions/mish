import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { FONT_FILE_LIMIT } from './local-files.js';

/**
 * AC-R11 preamble: find every font family a bundled kit or example declares. Text files
 * under the bundled resource roots are read as untrusted text and matched against a few
 * declaration shapes (CSS font-family / font shorthand / font custom properties,
 * @font-face, JS and JSON fontFamily keys, Google Fonts and Fontshare stylesheet URLs).
 * Nothing is executed or fetched. A self-hosted face's bytes are only hashed, inside its
 * root, so a kit alias can be mapped to admitted bytes by digest.
 */
export const FONT_KIT_ROOT_IDS = ['bundled-plugins', 'design-templates', 'design-systems'] as const;
export type FontKitRootId = typeof FONT_KIT_ROOT_IDS[number];
export interface FontKitRoot { id: FontKitRootId; path: string }
export type FontKitLoading = 'local-font-face' | 'google-fonts-css' | 'fontshare-css' | 'other-remote' | 'none';
export interface KitFontDeclaration {
  root: FontKitRootId; kit: string; family: string; key: string;
  files: string[]; loading: Set<FontKitLoading>; remoteHosts: Set<string>;
  /** Self-hosted faces of this family in this kit: their bytes' sha256, or null when unreadable or outside the root. */
  faces: Array<string | null>;
  /** An @font-face of this family names installed fonts through local(). */
  localAlias: boolean;
}
/** `kits` and `files` count what was scanned, with or without declarations. */
export interface KitFontScan { roots: FontKitRootId[]; kits: number; files: number; truncated: boolean; declarations: KitFontDeclaration[] }
/** What a single text file declares. Exported for focused tests of the text shapes. */
export interface ParsedFontText { families: string[]; faces: Array<{ family: string; sources: string[]; local: boolean }>; google: string[]; fontshare: string[]; remoteHosts: string[] }

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx', '.svg', '.vue', '.astro']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.next', '.turbo', '.cache']);
const MAX_FILES = 8000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 14;
const NOT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'normal', 'auto', 'italic', 'oblique', 'bold', 'bolder', 'lighter', 'small-caps',
  'swap', 'block', 'fallback', 'optional', 'default', 'sans', 'mono', 'display', 'body', 'heading', 'true', 'false', 'null', 'undefined', 'transparent', 'currentcolor',
]);
const FONT_HOSTS = ['use.typekit.net', 'p.typekit.net', 'fonts.bunny.net', 'fonts.cdnfonts.com', 'rsms.me', 'fonts.adobe.com', 'cdn.fontshare.com'];
const CSS_FAMILY = /(?<![\w-])font-family\s*:\s*([^;{}<>\n]{1,300})/giu;
const CSS_SHORTHAND = /(?<![\w-])font\s*:\s*([^;{}<>\n]{1,300})/giu;
const CUSTOM_PROPERTY = /(?<![\w-])(--[\w-]{1,80})\s*:\s*([^;{}<>\n]{1,300})/gu;
const SCRIPT_KEY = /["']?(?:fontFamily|font_family|font-family)["']?\s*:\s*(?:(["'`])((?:(?!\1)[^\n]){1,300})\1|\[([^\]]{1,300})\])/gu;
const FONT_FACE = /@font-face\s*\{([^}]{0,4000})\}/giu;
const GOOGLE_CSS = /fonts\.googleapis\.com\/css2?\?([^"'\s)<>`]{1,2000})/giu;
const FONTSHARE_CSS = /api\.fontshare\.com\/v2\/css\?([^"'\s)<>`]{1,2000})/giu;
const REMOTE_URL = /https?:\/\/([a-z0-9.-]{1,200})\//giu;
const SIZE_THEN_FAMILY = /(?:^|\s)(?:\d*\.?\d+(?:px|r?em|%|pt|pc|vw|vh|vmin|vmax|ch|ex|q|mm|cm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*\S+)?\s+(.+)$/iu;
const NAME = /^-?[\p{L}\p{N}][\p{L}\p{N} ._&+-]{0,79}$/u;
const ENTITIES: Record<string, string> = { '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };

export const familyKey = (family: string) => family.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Comma-separated family names, quotes stripped; generic keywords, variables and placeholders dropped. */
export function familyNames(value: string): string[] {
  const names: string[] = [];
  let current = ''; let quote = '';
  for (const char of `${value},`) {
    if (quote) { if (char === quote) quote = ''; else current += char; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char !== ',') { current += char; continue; }
    const name = current.replace(/!important/giu, '').replace(/^[\s"'`]+|[\s"'`]+$/gu, '').replace(/\s+/gu, ' ');
    current = '';
    if (!name || /[$(){}%<>\\=[\]]/u.test(name) || !NAME.test(name) || NOT_FAMILIES.has(name.toLowerCase())) continue;
    names.push(name);
  }
  return names;
}
function queryFamilies(query: string, key: RegExp): string[] {
  return query.replace(/&amp;/gu, '&').split('&').flatMap(part => {
    const [name, raw] = part.split('=');
    if (!name || raw === undefined || !key.test(decodeSafe(name))) return [];
    return decodeSafe(raw.replace(/\+/gu, ' ')).split('|');
  });
}
function decodeSafe(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }

export function parseFontText(input: string): ParsedFontText {
  const text = input.replace(/&(?:quot|#34|#39|apos|amp);/gu, entity => ENTITIES[entity]!);
  const families: string[] = [];
  for (const match of text.matchAll(CSS_FAMILY)) families.push(...familyNames(match[1]!));
  for (const match of text.matchAll(CSS_SHORTHAND)) {
    const rest = SIZE_THEN_FAMILY.exec(match[1]!.trim());
    if (rest) families.push(...familyNames(rest[1]!));
  }
  for (const match of text.matchAll(CUSTOM_PROPERTY)) {
    const [, name, value] = match;
    const named = /font|family|typeface/iu.test(name!) && !/size|weight|feature|variation|stretch|height|leading|tracking|spacing|scale|smoothing|synthesis|optical|kerning|style|wght/iu.test(name!);
    const stack = familyNames(value!);
    const endsGeneric = /,\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+)\s*$/iu.test(value!.trim());
    if (named || endsGeneric) families.push(...stack);
  }
  for (const match of text.matchAll(SCRIPT_KEY)) families.push(...familyNames(match[2] ?? match[3] ?? ''));
  const faces: ParsedFontText['faces'] = [];
  for (const match of text.matchAll(FONT_FACE)) {
    const body = match[1]!;
    const family = familyNames(/font-family\s*:\s*([^;]{1,300})/iu.exec(body)?.[1] ?? '')[0];
    if (!family) continue;
    const sources = [...body.matchAll(/url\(\s*(["']?)([^"')]{1,1000})\1\s*\)/giu)].map(entry => entry[2]!.trim());
    faces.push({ family, sources, local: /(?<![\w-])local\(/iu.test(body) });
  }
  const google = [...text.matchAll(GOOGLE_CSS)].flatMap(match => queryFamilies(match[1]!, /^family$/u))
    .map(entry => entry.split(':')[0]!.trim()).filter(name => NAME.test(name));
  const fontshare = [...text.matchAll(FONTSHARE_CSS)].flatMap(match => queryFamilies(match[1]!, /^f(?:\[\])?$/u))
    .map(entry => entry.split('@')[0]!.trim().toLowerCase()).filter(slug => /^[a-z0-9-]{1,120}$/u.test(slug));
  const remoteHosts = [...new Set([...text.matchAll(REMOTE_URL)].map(match => match[1]!.toLowerCase()).filter(host => FONT_HOSTS.includes(host)))];
  return { families, faces, google, fontshare, remoteHosts };
}

/** The kit a root-relative file belongs to: `examples/<id>`, `shared/ui-kits/<id>`, or a template/system directory. */
export function kitOf(root: FontKitRootId, relative: string): string {
  const parts = relative.split('/');
  if (root !== 'bundled-plugins') return parts.length > 1 ? parts[0]! : '.';
  if (parts[0] === 'shared' && parts[1] === 'ui-kits' && parts.length > 3) return parts.slice(0, 3).join('/');
  if (parts.length > 2) return parts.slice(0, 2).join('/');
  return parts.length > 1 ? parts[0]! : '.';
}

async function walk(rootReal: string, onFile: (relative: string) => Promise<void>, state: { files: number; truncated: boolean }): Promise<void> {
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) { state.truncated = true; return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await visit(full, depth + 1); continue; }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (state.files >= MAX_FILES) { state.truncated = true; return; }
      state.files++;
      await onFile(path.relative(rootReal, full).split(path.sep).join('/'));
    }
  };
  await visit(rootReal, 0);
}

/** sha256 of a self-hosted face file, only when it resolves to a bounded regular file inside the root. */
async function faceDigest(rootReal: string, fromFile: string, source: string): Promise<string | null> {
  const clean = decodeSafe(source.split(/[?#]/u)[0]!);
  if (!clean || clean.startsWith('/') || clean.includes('\\') || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) return null;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  if (relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative)) return null;
  const full = path.join(rootReal, ...relative.split('/'));
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > FONT_FILE_LIMIT) return null;
    const real = await realpath(full);
    if (!real.startsWith(rootReal + path.sep)) return null;
    return createHash('sha256').update(await readFile(real)).digest('hex');
  } catch { return null; }
}

/**
 * Scans the given roots once. `fontshareFamilies` resolves a Fontshare stylesheet slug to
 * its listed family name, so `f[]=satoshi` and `font-family: Satoshi` are one declaration.
 */
export async function scanKitFonts(roots: readonly FontKitRoot[], options: { fontshareFamilies?: ReadonlyMap<string, string> } = {}): Promise<KitFontScan> {
  const byKey = new Map<string, KitFontDeclaration>();
  const kits = new Set<string>();
  const state = { files: 0, truncated: false };
  const scannedRoots: FontKitRootId[] = [];
  for (const root of roots) {
    let rootReal: string;
    try { rootReal = await realpath(root.path); } catch { continue; }
    scannedRoots.push(root.id);
    await walk(rootReal, async relative => {
      const kit = kitOf(root.id, relative);
      kits.add(`${root.id}\0${kit}`);
      let text: string;
      try {
        const full = path.join(rootReal, ...relative.split('/'));
        const info = await lstat(full);
        if (info.size > MAX_TEXT_BYTES) { state.truncated = true; return; }
        text = await readFile(full, 'utf8');
      } catch { return; }
      if (!/font|typekit/iu.test(text)) return;
      const parsed = parseFontText(text);
      const declare = (family: string, loading?: FontKitLoading) => {
        const key = familyKey(family);
        const id = `${root.id}\0${kit}\0${key}`;
        let entry = byKey.get(id);
        if (!entry) { entry = { root: root.id, kit, family, key, files: [], loading: new Set(), remoteHosts: new Set(), faces: [], localAlias: false }; byKey.set(id, entry); }
        if (!entry.files.includes(relative)) entry.files.push(relative);
        if (loading) entry.loading.add(loading);
        for (const host of parsed.remoteHosts) entry.remoteHosts.add(host);
        return entry;
      };
      for (const family of parsed.families) declare(family);
      for (const family of parsed.google) declare(family, 'google-fonts-css').remoteHosts.add('fonts.googleapis.com');
      for (const slug of parsed.fontshare) declare(options.fontshareFamilies?.get(slug) ?? slug, 'fontshare-css').remoteHosts.add('api.fontshare.com');
      for (const face of parsed.faces) {
        const entry = declare(face.family);
        if (face.local) entry.localAlias = true;
        for (const source of face.sources) {
          const remote = /^(?:https?:)?\/\/([^/\s]{1,200})/iu.exec(source);
          if (remote) { entry.loading.add('other-remote'); entry.remoteHosts.add(remote[1]!.toLowerCase()); continue; }
          entry.loading.add('local-font-face');
          if (source.startsWith('data:')) { entry.faces.push(null); continue; }
          entry.faces.push(await faceDigest(rootReal, relative, source));
        }
      }
    }, state);
  }
  const declarations = [...byKey.values()].map(entry => (entry.loading.size ? entry : { ...entry, loading: new Set<FontKitLoading>(['none']) }))
    .sort((a, b) => a.root.localeCompare(b.root, 'en') || a.kit.localeCompare(b.kit, 'en') || a.key.localeCompare(b.key, 'en'));
  for (const entry of declarations) entry.files.sort((a, b) => a.localeCompare(b, 'en'));
  return { roots: scannedRoots, kits: kits.size, files: state.files, truncated: state.truncated, declarations };
}
