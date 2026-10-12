/**
 * Section adapter contract and deterministic renderer.
 *
 * An "adapter" turns one vendored, MIT-licensed HyperUI block into a selectable page section: a
 * fixed markup skeleton (derived at author time by `scripts/build-section-adapters.ts`, never at
 * request time) plus a finite set of named slots a model may fill. The renderer below is the only
 * code that ever writes a `<SectionAdapter>`'s markup: it substitutes escaped plain text and
 * approved asset ids into the fixed skeleton and nothing else. It never evaluates model-authored
 * HTML, CSS, `<script>` content, or URLs — the skeleton's structure, its scoped CSS and its
 * `links` are fixed at adapter-author time; the model only ever supplies the strings named in
 * `text`/`items`.
 *
 * This mirrors the family compiler's own contract (`plugins/_official/shared/agency-compiler`):
 * `AtomKind` below is the same nullable-fact-atom union each family's `slots.ts` declares
 * (`phone | email | address | plain`), and `renderSectionAdapter` merges/escapes the way
 * `render.ts` does — but for exactly one section, addressed by an id namespaced
 * `hyperui:<blockId>`, never a whole family recipe.
 *
 * Shared file: edit `plugins/_official/shared/agency-compiler`, then run
 * `scripts/sync-agency-compiler.ts` (see that file's README for why there are 14 copies). This
 * particular file has no family module to dispatch through — every copy carries it unused except
 * the canonical one, which `packages/agency-fast-lane` imports directly by path (the fast lane's
 * composition overlay runs in-process, with full node_modules access, never inside a packaged,
 * dependency-free family compiler) — kept in the shared location anyway because the family
 * compiler contract it extends lives there, and a later milestone may render a selected section
 * from inside a packaged build too.
 */

/** A fact a brief may not state: the slot is `null`, and the adapter drops its element. Same
 * union as every family's `slots.ts` (`AtomKind` there). */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain';

export type AdapterTextSlot = {
  name: string;
  /** Maximum characters; enforced before substitution, never after. */
  max: number;
  /** Present only on a slot that may be a fact the brief does not state. */
  atom?: AtomKind;
};

/** A fixed-count repeat of one item shape (mirrors `ItemsSpec` in a family's `slots.ts`). */
export type AdapterItemsSlot = {
  name: string;
  count: number;
  fields: readonly AdapterTextSlot[];
};

/**
 * A link the adapter's skeleton renders. The `href` is fixed at author time — an internal anchor
 * such as `#contact`, never a value the model supplies — so no model output can ever become a
 * URL. `label` names the slot a model may still write text for (the visible link text), when the
 * adapter exposes one; a link with no `label` renders fixed text too.
 */
export type AdapterLink = { name: string; href: string; label?: string };

/** An approved image asset the adapter's skeleton positions. The caller supplies the asset id and
 * its resolved `src`; the model supplies only the bounded `alt` text named by `altSlot`. */
export type AdapterAssetSlot = { name: string; altSlot?: string; altMax?: number };

/** Semantic color/font roles a converted adapter's CSS may reference — see `direction-tokens.ts`.
 * No other custom property or literal color may appear in an adapter's `css`. */
export const SEMANTIC_ROLES = ['background', 'surface', 'foreground', 'muted', 'accent', 'on-accent', 'border'] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export type AdapterFill = {
  text?: Readonly<Record<string, string | null>>;
  items?: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, string | null>>>>>;
  links?: Readonly<Record<string, string>>;
  assets?: Readonly<Record<string, { src: string; alt?: string }>>;
};

export type SectionAdapter = {
  /** `hyperui:<blockId>`, e.g. `hyperui:marketing/ctas/1`. */
  id: string;
  /** Bumped whenever the derived skeleton or slot roster changes; folded into the artifact digest. */
  version: string;
  /** The pinned HyperUI block this adapter derives from. */
  sourceBlockId: string;
  /** SHA-256 of the exact pinned block HTML this adapter was generated from — ties the generated
   * derivative to one exact source snapshot; `build-section-adapters.ts --check` verifies it. */
  sourceSha256: string;
  /** Semantic roles this adapter's `css` actually references. */
  roles: readonly SemanticRole[];
  text: readonly AdapterTextSlot[];
  items?: AdapterItemsSlot;
  links?: readonly AdapterLink[];
  assets?: readonly AdapterAssetSlot[];
  /** Section-scoped CSS: role-based custom properties only, no literal colors, no arbitrary
   * Tailwind utilities, no `url()`, no `@import`, no `expression`. Validated at generation time. */
  css: string;
  /**
   * The one function that ever produces this adapter's markup. Pure and deterministic: same
   * `fill` in, same HTML out. Every string it places on the page is either escaped model text
   * (from `fill`) or a fixed literal the generator wrote — never string concatenation of anything
   * else. Returns the section's inner markup only (no `<section>`/`<html>` wrapper); the overlay
   * supplies the wrapper, the `data-od-id`s and the direction scope.
   */
  render: (fill: AdapterFill) => string;
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Strips control characters a text slot must never carry (matches the family schema's `text()`). */
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE = /^\+?[0-9()\-.\s]{7,20}$/;

function validAtom(kind: AtomKind, value: string): boolean {
  if (kind === 'plain') return true;
  if (kind === 'email') return EMAIL.test(value);
  if (kind === 'phone') return PHONE.test(value);
  // 'address' has no fixed machine format; any cleaned, non-empty text is accepted, same as the
  // family compiler's own address atoms (see e.g. listings' `address` slot in `slots.ts`).
  return value.length > 0;
}

export type AdapterFillError = { slot: string; reason: string };

/** Validates one flat slot value (or `null`) against its spec; returns the cleaned string, `null`
 * for a legally dropped atom, or an error. */
function checkSlot(spec: AdapterTextSlot, raw: string | null | undefined, at: string): { value: string | null } | { error: AdapterFillError } {
  if (raw === null) {
    if (!spec.atom) return { error: { slot: at, reason: 'not nullable: this slot has no fact atom kind' } };
    return { value: null };
  }
  if (typeof raw !== 'string' || raw.length === 0) return { error: { slot: at, reason: 'expected non-empty text' } };
  const cleaned = cleanText(raw);
  if (cleaned.length === 0) return { error: { slot: at, reason: 'expected non-empty text after trimming' } };
  if (cleaned.length > spec.max) return { error: { slot: at, reason: `exceeds ${spec.max} characters` } };
  if (spec.atom && !validAtom(spec.atom, cleaned)) return { error: { slot: at, reason: `does not look like a valid ${spec.atom}` } };
  return { value: cleaned };
}

/**
 * Validates a whole fill against the adapter's declared slots (every required text slot present,
 * every item's fixed count matched, no unknown slot names, no unapproved asset). Returns the list
 * of problems; an empty list means the fill is safe to render. This runs before `adapter.render`
 * is ever called — the renderer itself assumes a validated fill and does no further checking.
 */
export function validateAdapterFill(adapter: SectionAdapter, fill: AdapterFill): AdapterFillError[] {
  const errors: AdapterFillError[] = [];
  const text = fill.text ?? {};
  const knownText = new Set(adapter.text.map((slot) => slot.name));
  for (const key of Object.keys(text)) if (!knownText.has(key)) errors.push({ slot: key, reason: 'unknown text slot' });
  for (const spec of adapter.text) {
    const result = checkSlot(spec, text[spec.name], spec.name);
    if ('error' in result) errors.push(result.error);
  }
  if (adapter.items) {
    const rows = fill.items?.[adapter.items.name] ?? [];
    if (rows.length !== adapter.items.count) {
      errors.push({ slot: adapter.items.name, reason: `expected exactly ${adapter.items.count} items, got ${rows.length}` });
    } else {
      const knownFields = new Set(adapter.items.fields.map((field) => field.name));
      rows.forEach((row, index) => {
        for (const key of Object.keys(row)) if (!knownFields.has(key)) errors.push({ slot: `${adapter.items!.name}[${index}].${key}`, reason: 'unknown item field' });
        for (const field of adapter.items!.fields) {
          const result = checkSlot(field, row[field.name], `${adapter.items!.name}[${index}].${field.name}`);
          if ('error' in result) errors.push(result.error);
        }
      });
    }
  } else if (fill.items && Object.keys(fill.items).length > 0) {
    errors.push({ slot: 'items', reason: 'this adapter declares no item slot' });
  }
  const knownAssets = new Set((adapter.assets ?? []).map((asset) => asset.name));
  for (const key of Object.keys(fill.assets ?? {})) if (!knownAssets.has(key)) errors.push({ slot: key, reason: 'unknown asset slot' });
  for (const asset of adapter.assets ?? []) {
    const value = fill.assets?.[asset.name];
    if (!value) continue; // Assets are optional unless the caller's selection requires one; the
    // overlay decides whether an absent asset is acceptable before calling render.
    if (typeof value.src !== 'string' || value.src.length === 0 || /^(javascript:|data:|vbscript:)/i.test(value.src.trim())) {
      errors.push({ slot: asset.name, reason: 'asset src must be a resolved, non-script path supplied by the caller, never model text' });
    }
    if (asset.altMax !== undefined && value.alt !== undefined && value.alt.length > asset.altMax) {
      errors.push({ slot: `${asset.name}.alt`, reason: `alt text exceeds ${asset.altMax} characters` });
    }
  }
  // A link's `href` is fixed at adapter-author time (see `AdapterLink`'s own doc comment) — the
  // model never supplies a URL. `render` already ignores `fill.links` and hardcodes each declared
  // `href`, so today this is defense in depth rather than a live path (NIT 8, delta audit): it
  // stops a FUTURE adapter that trusted `fill.links` from ever rendering a model-supplied URL,
  // by refusing any value that does not match the adapter's own declared href, not only an
  // unknown key.
  const linkHrefByName = new Map((adapter.links ?? []).map((link) => [link.name, link.href]));
  for (const [key, value] of Object.entries(fill.links ?? {})) {
    const declaredHref = linkHrefByName.get(key);
    if (declaredHref === undefined) {
      errors.push({ slot: key, reason: 'unknown link slot' });
    } else if (value !== declaredHref) {
      errors.push({ slot: key, reason: 'link href must match the adapter-declared href; the model may never supply a URL' });
    }
  }
  return errors;
}

/**
 * Validates, then renders. Throws `AdapterFillRejectedError` on any validation failure — the
 * caller (the composition overlay) repairs or refuses the selection before this ever throws in
 * a strict build.
 */
export class AdapterFillRejectedError extends Error {
  readonly errors: AdapterFillError[];
  constructor(errors: AdapterFillError[]) {
    super(`Section adapter fill rejected: ${errors.map((e) => `${e.slot}: ${e.reason}`).join('; ')}`);
    this.name = 'AdapterFillRejectedError';
    this.errors = errors;
  }
}

export function renderSectionAdapter(adapter: SectionAdapter, fill: AdapterFill): string {
  const errors = validateAdapterFill(adapter, fill);
  if (errors.length > 0) throw new AdapterFillRejectedError(errors);
  return adapter.render(fill);
}
