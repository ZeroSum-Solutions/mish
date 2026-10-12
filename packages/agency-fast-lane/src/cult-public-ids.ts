/**
 * Public ids for Cult UI Pro section entries. The internal inventory id (`cult:<name>`) can name
 * the provider a style came from (`cult:marketing-pricing-vercel`); everything this package writes
 * where a person sees it — the published page's `data-od-selected-section` and section DOM id, the
 * artifact manifest, a composed page's saved recipe and state note — carries the public id
 * (`cult:<slug>`, `@mish/cult-ui-catalog/generated/slugs.json`) instead. Resolution
 * (`resolveSectionAdapter`) accepts either, so a project built before public ids still replays.
 *
 * The checked JSON maps use the catalog's package exports so the daemon prebundle carries them
 * after relocation. Lookup maps are initialized only when a `cult:` id asks. Other ids map to
 * themselves.
 */

import { publicAdapterNamesForId, PROSE_ATTRIBUTES } from './cult-adapter-names.ts';
export { PROSE_ATTRIBUTES } from './cult-adapter-names.ts';

import slugData from '@mish/cult-ui-catalog/generated/slugs.json' with { type: 'json' };
import publicNameData from '@mish/cult-ui-catalog/generated/public-names.json' with { type: 'json' };

const slugsSpecifier = '@mish/cult-ui-catalog/generated/slugs.json';

type Maps = { toPublic: ReadonlyMap<string, string>; toInternal: ReadonlyMap<string, string> };
let maps: Maps | undefined;

function load(): Maps {
  if (maps) return maps;
  const parsed = slugData as { schema?: unknown; items?: Record<string, unknown> };
  if (parsed.schema !== 'cult-slugs/1' || typeof parsed.items !== 'object' || parsed.items === null) {
    throw new Error(`${slugsSpecifier}: unexpected schema`);
  }
  const toPublic = new Map<string, string>();
  for (const [id, slug] of Object.entries(parsed.items)) if (typeof slug === 'string') toPublic.set(id, `cult:${slug}`);
  maps = { toPublic, toInternal: new Map([...toPublic].map(([id, publicId]) => [publicId, id])) };
  return maps;
}

/** The public id of a Cult section entry (`cult:<slug>`); any other id unchanged. */
export function publicSectionEntryId(id: string): string {
  // Only a Cult id initializes the lookup map; bundled JSON is imported without filesystem access.
  return id.startsWith('cult:') ? load().toPublic.get(id) ?? id : id;
}

/** The internal id for a public Cult id; an internal id or any other id unchanged. */
export function internalSectionEntryId(id: string): string {
  return id.startsWith('cult:') ? load().toInternal.get(id) ?? id : id;
}

/** Publication naming stage retained as a public helper. The generator uses the pure
 * `publicAdapterNamesForId` stage directly so it never loads the JSON it is generating. */
export function publicAdapterNames(adapterId: string, text: string): string {
  return publicAdapterNamesForId(adapterId, text, publicSectionEntryId(adapterId));
}

const publicNamesSpecifier = '@mish/cult-ui-catalog/generated/public-names.json';

/** One adapter's entry in `generated/public-names.json` (`scripts/public-names.ts` owns it). */
type PublicNames = {
  /** Identifier token → brand-free token: ids, classes, symbol and gradient ids, keyframes. */
  tokens?: Record<string, string>;
  /** Prose attribute value (an `aria-label`, `title`, `alt`, `placeholder`) → its scrubbed text. */
  prose?: Record<string, string>;
};
let publicNames: Readonly<Record<string, PublicNames>> | undefined;

function loadPublicNames(): Readonly<Record<string, PublicNames>> {
  if (publicNames) return publicNames;
  const parsed = publicNameData as { schema?: unknown; items?: Record<string, PublicNames> };
  if (parsed.schema !== 'cult-public-names/1' || typeof parsed.items !== 'object' || parsed.items === null) {
    throw new Error(`${publicNamesSpecifier}: unexpected schema`);
  }
  publicNames = parsed.items;
  return publicNames;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An adapter's rendered markup or CSS as it is published: stage 1 (`publicAdapterNames`), then
 * every other identifier that names a vendor (`generated/public-names.json`, e.g.
 * `id="footer-vite-email"` → `footer-email-series-vt`, `@keyframes comparison-vite-glow`,
 * `id="gemini-gradient-primary"` with `url(#…)`) renamed as a whole token. In markup only inside
 * tag attributes, never text; in CSS everywhere. The same token maps the same way in both, so an
 * id and every reference to it (`for`, `href="#…"`, `url(#…)`, `aria-labelledby`, a selector)
 * stay paired. A prose attribute value that names a vendor (`aria-label="Visit us on GitHub"`) is
 * replaced by its scrubbed text.
 */
export function publicAdapterText(adapterId: string, text: string, kind: 'markup' | 'css' = 'markup'): string {
  if (!adapterId.startsWith('cult:')) return text;
  return applyPublicNames(loadPublicNames()[adapterId], publicAdapterNames(adapterId, text), kind);
}

/** Stage 2 of `publicAdapterText`, pure: one adapter's `public-names.json` entry applied to text already through stage 1. */
export function applyPublicNames(entry: PublicNames | undefined, named: string, kind: 'markup' | 'css' = 'markup'): string {
  if (!entry) return named;
  const tokens = Object.entries(entry.tokens ?? {});
  const renameTokens = (value: string) => tokens.reduce(
    // A whole token; a custom property's `--` prefix counts as a boundary (`var(--font-x)`).
    (out, [from, to]) => out.replace(new RegExp(`(?:(?<=--)|(?<![\\w-]))${escapeRegExp(from)}(?![\\w-])`, 'g'), to),
    value,
  );
  if (kind === 'css') return renameTokens(named);
  const prose = entry.prose ?? {};
  return named.replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/(\s)([a-zA-Z:-]+)="([^"]*)"/g, (_m, space: string, attr: string, value: string) => {
    if (PROSE_ATTRIBUTES.includes(attr.toLowerCase())) return `${space}${attr}="${Object.hasOwn(prose, value) ? prose[value] : value}"`;
    return `${space}${attr}="${renameTokens(value)}"`;
  }));
}
