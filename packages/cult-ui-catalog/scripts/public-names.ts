/**
 * The published names of every insertable Cult adapter: the identifiers and prose attributes in its
 * markup and CSS that would name a vendor on a published page, each with its brand-free
 * replacement. Generated with the catalog from the adapters themselves:
 *
 *   node --experimental-strip-types scripts/public-names.ts          write generated/public-names.json
 *   node --experimental-strip-types scripts/public-names.ts --check  write nothing; exit 1 when stale
 *
 * The fast lane applies the file when it publishes an adapter (`publicAdapterText`,
 * packages/agency-fast-lane/src/cult-public-ids.ts), after renaming the adapter's own internal
 * name to its slug (`publicAdapterNames`). This generator calls the pure first-stage helper
 * `publicAdapterNamesForId` from `cult-adapter-names.ts` with the reviewed slug manifest. It
 * never imports `cult-public-ids.ts` or its own output, and records only what is still branded:
 *
 * - tokens: identifier tokens in markup attributes (`id`, `for`, `class`, `aria-labelledby` and the
 *   other id-list attributes, in-page `href`, `url(#…)`) and in the CSS (`.class`, `#id`,
 *   `@keyframes name`, `--custom-property`) that name a denied brand
 *   (`isCultBrandFree`, @open-design/contracts). Each gets `cultBrandFreeSegment` of itself
 *   (`footer-vite-email` → `footer-email-series-vt`), made unique within the adapter with `-2`,
 *   `-3`, … A pure function of the adapter, applied as a whole token everywhere, so an id and its
 *   references stay paired.
 * - prose: values of prose attributes (`aria-label`, `title`, `alt`, `placeholder`, …) that name
 *   a denied brand, context-only names included (`isCultBrandFreeLabel`: `aria-label="Discord"`),
 *   each with `cultBrandFreeLabel` of itself (`Discord` → `A third-party service`).
 *
 * `pnpm --filter @open-design/cult-ui-catalog adapters` regenerates it after the adapters; `check`
 * fails when it is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cultBrandFreeLabel, cultBrandFreeSegment, isCultBrandFree, isCultBrandFreeLabel } from '@open-design/contracts';

import { PACKAGE_DIR, worstCaseFill } from './adapter-check.ts';

export const PUBLIC_NAMES_SCHEMA = 'cult-public-names/1';

type Adapter = { id: string; css: string; render: (fill: unknown) => string; text: unknown[]; items?: unknown };
export type PublicNames = { tokens?: Record<string, string>; prose?: Record<string, string> };
export type PublicNamesManifest = { schema: typeof PUBLIC_NAMES_SCHEMA; items: Record<string, PublicNames> };

const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
const OUT = join(PACKAGE_DIR, 'generated', 'public-names.json');
// Import only the pure first stage: this generator must work before its own JSON output exists.
const { publicAdapterNamesForId, PROSE_ATTRIBUTES } = await import(pathToFileURL(join(REPO_ROOT, 'packages/agency-fast-lane/src/cult-adapter-names.ts')).href) as {
  publicAdapterNamesForId: (adapterId: string, text: string, publicId: string) => string;
  PROSE_ATTRIBUTES: readonly string[];
};
const slugFile = join(PACKAGE_DIR, 'generated', 'slugs.json');
const slugManifest = JSON.parse(readFileSync(slugFile, 'utf8')) as { schema?: unknown; items?: Record<string, unknown> };
if (slugManifest.schema !== 'cult-slugs/1' || typeof slugManifest.items !== 'object' || slugManifest.items === null) {
  throw new Error(`${slugFile}: unexpected schema`);
}
const slugItems = slugManifest.items;
function publicAdapterNames(adapterId: string, text: string): string {
  const slug = slugItems[adapterId];
  return publicAdapterNamesForId(adapterId, text, typeof slug === 'string' ? `cult:${slug}` : adapterId);
}

/** Attributes whose value is one id or a list of ids, classes or in-page references. */
const ID_ATTRIBUTES = new Set([
  'id', 'for', 'class', 'href', 'xlink:href', 'form', 'list', 'headers', 'aria-labelledby', 'aria-describedby',
  'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-errormessage', 'aria-flowto', 'aria-details',
]);

/** Every identifier token in markup attributes and CSS, and every prose attribute value. */
export function namesIn(markup: readonly string[], css: string): { tokens: Set<string>; prose: Set<string> } {
  const tokens = new Set<string>();
  const prose = new Set<string>();
  for (const html of markup) {
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      for (const [, attr, value] of tag.matchAll(/\s([a-zA-Z:-]+)="([^"]*)"/g)) {
        const name = attr!.toLowerCase();
        if (PROSE_ATTRIBUTES.includes(name)) { prose.add(value!); continue; }
        if (ID_ATTRIBUTES.has(name)) for (const part of value!.split(/\s+/)) if (part) tokens.add(part.replace(/^#/, ''));
        for (const [, ref] of value!.matchAll(/url\(\s*#([\w-]+)\s*\)/g)) tokens.add(ref!);
      }
    }
  }
  for (const [, token] of css.matchAll(/[.#]([A-Za-z_][\w-]*)/g)) tokens.add(token!);
  for (const [, token] of css.matchAll(/@keyframes\s+([\w-]+)/g)) tokens.add(token!);
  for (const [, token] of css.matchAll(/--([\w-]+)/g)) tokens.add(token!);
  for (const [, token] of css.matchAll(/url\(\s*#([\w-]+)\s*\)/g)) tokens.add(token!);
  return { tokens, prose };
}

/** The published-name entry for one adapter, or undefined when nothing it publishes is branded. */
export function publicNamesOf(adapter: Adapter, fills: readonly unknown[]): PublicNames | undefined {
  const markup = fills.map((fill) => publicAdapterNames(adapter.id, adapter.render(fill)));
  const css = publicAdapterNames(adapter.id, adapter.css);
  const { tokens, prose } = namesIn(markup, css);
  const taken = new Set(tokens);
  const renamed: Record<string, string> = {};
  for (const token of [...tokens].filter((value) => !isCultBrandFree(value)).sort()) {
    const base = cultBrandFreeSegment(token, new Map()) || 'item';
    let next = base;
    for (let n = 2; taken.has(next) || !isCultBrandFree(next); n += 1) next = `${base}-${n}`;
    taken.add(next);
    renamed[token] = next;
  }
  const scrubbed: Record<string, string> = {};
  for (const value of [...prose].filter((text) => !isCultBrandFreeLabel(text)).sort()) scrubbed[value] = cultBrandFreeLabel(value);
  if (Object.keys(renamed).length === 0 && Object.keys(scrubbed).length === 0) return undefined;
  return { ...(Object.keys(renamed).length > 0 ? { tokens: renamed } : {}), ...(Object.keys(scrubbed).length > 0 ? { prose: scrubbed } : {}) };
}

export async function publicNamesManifestText(): Promise<string> {
  const { CULT_ADAPTERS } = await import(pathToFileURL(join(PACKAGE_DIR, 'generated', 'index.ts')).href) as { CULT_ADAPTERS: Record<string, () => Promise<Adapter>> };
  const { layoutFill } = await import(pathToFileURL(join(PACKAGE_DIR, 'scripts', 'render-check.ts')).href) as { layoutFill: (adapter: Adapter) => unknown };
  const items: Record<string, PublicNames> = {};
  for (const id of Object.keys(CULT_ADAPTERS).sort()) {
    const adapter = await CULT_ADAPTERS[id]!();
    const entry = publicNamesOf(adapter, [worstCaseFill(adapter as never), layoutFill(adapter)]);
    if (entry) items[id] = entry;
  }
  const manifest: PublicNamesManifest = { schema: PUBLIC_NAMES_SCHEMA, items };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(): Promise<void> {
  const text = await publicNamesManifestText();
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (text !== current) {
      console.error('generated/public-names.json is stale; run `node --experimental-strip-types scripts/public-names.ts`');
      process.exit(1);
    }
    console.log(`generated/public-names.json matches the adapters (${Object.keys(JSON.parse(text).items).length} adapters renamed)`);
    return;
  }
  if (text !== current) writeFileSync(OUT, text);
  console.log(`generated/public-names.json: ${Object.keys(JSON.parse(text).items).length} adapters with published renames`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
