// Every insertable Cult adapter as the fast lane publishes it (`publicAdapterText`): no name in its
// markup or CSS names a vendor, by the independent brand list (tests/helpers/cult-brand-names.ts),
// and every in-page reference still reaches its target.
//
// Checked: every attribute that carries a name, label or reference (ids, `for`, classes, `aria-*`,
// in-page `href`, `title`/`alt`/`placeholder`, `data-*`), `url(#…)` targets in any attribute, a
// `style` attribute's names, and the CSS's names (class and id selectors, `@keyframes` names,
// custom properties, `url(#…)` targets). Not checked: text nodes (copy written into the markup is
// licensed source text, kept as shipped), SVG geometry, and CSS property values, where words such
// as `linear-gradient` are CSS keywords, not names (`brandHit`'s `markup` mode).

import { describe, expect, it } from 'vitest';

import { publicAdapterText } from '@open-design/agency-fast-lane/cult-public-ids';
import { brandHit } from './helpers/cult-brand-names.js';

type Slot = { name: string; max: number; atom?: string };
type Adapter = { id: string; css: string; text: readonly Slot[]; items?: { name: string; count: number; fields: readonly Slot[] }; render: (fill: unknown) => string };

/** Every slot at its limit and every item row present, so every conditional part renders. */
function fullFill(adapter: Adapter): unknown {
  const value = (slot: Slot) => (slot.atom === 'email' ? `${'w'.repeat(Math.max(1, slot.max - 12))}@example.com`.slice(-slot.max)
    : slot.atom === 'phone' ? '+1 (555) 010-0199'.slice(0, Math.min(slot.max, 17)) : 'W'.repeat(slot.max));
  const text = Object.fromEntries(adapter.text.map((slot) => [slot.name, value(slot)]));
  if (!adapter.items) return { text };
  const row = Object.fromEntries(adapter.items.fields.map((field) => [field.name, value(field)]));
  return { text, items: { [adapter.items.name]: Array.from({ length: adapter.items.count }, () => ({ ...row })) } };
}

/**
 * Attributes that carry a name, a label or a reference. Geometry and presentation values (`d`,
 * `points`, `viewBox`, `transform`, …) are not names; their `url(#…)` targets are read below.
 */
const NAME_ATTRIBUTE = /^(?:id|for|class|name|role|href|xlink:href|title|alt|placeholder|headers|form|list|aria-[a-z-]+|data-[a-z0-9-]+)$/;

function attributesOf(html: string): Array<{ attr: string; value: string }> {
  return (html.match(/<[a-zA-Z][^>]*>/g) ?? []).flatMap((tag) => [...tag.matchAll(/\s([a-zA-Z:-]+)="([^"]*)"/g)].map((match) => ({ attr: match[1]!, value: match[2]! })));
}

/** The names a CSS text declares or refers to. */
function cssNames(css: string): string[] {
  return [
    ...[...css.matchAll(/[.#]([A-Za-z_][\w-]*)/g)].map((match) => match[1]!),
    ...[...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!),
    ...[...css.matchAll(/--([\w-]+)/g)].map((match) => match[1]!),
    ...[...css.matchAll(/url\(\s*#([\w-]+)\s*\)/g)].map((match) => match[1]!),
  ];
}

/** In-page references (`for`, `href="#…"`, `url(#…)`, id-list `aria-*`) with no element id to reach. */
function unresolved(html: string): string[] {
  const attributes = attributesOf(html);
  const ids = new Set(attributes.filter(({ attr }) => attr === 'id').map(({ value }) => value));
  const refs = attributes.flatMap(({ attr, value }) => [
    ...(attr === 'for' ? [value] : []),
    ...((attr === 'href' || attr === 'xlink:href') && value.startsWith('#') && value.length > 1 ? [value.slice(1)] : []),
    ...(/^aria-(labelledby|describedby|controls|owns|activedescendant|errormessage|flowto|details)$/.test(attr) ? value.split(/\s+/) : []),
    ...[...value.matchAll(/url\(\s*#([\w-]+)\s*\)/g)].map((match) => match[1]!),
  ]);
  return refs.filter((ref) => ref && !ids.has(ref));
}

// The generated registry is TypeScript source with `.ts` import paths, which this app's tsc does
// not accept; a non-literal specifier keeps tsc from following it, and vitest loads it as usual.
const REGISTRY = '@open-design/cult-ui-catalog/generated';
const { CULT_ADAPTERS } = await import(REGISTRY) as { CULT_ADAPTERS: Record<string, () => Promise<Adapter>> };
const ADAPTERS = await Promise.all(Object.values(CULT_ADAPTERS).map((load) => load()));

describe('published Cult adapters', () => {
  it('covers every insertable adapter', () => {
    expect(ADAPTERS.length).toBeGreaterThan(80);
  });

  it.each(ADAPTERS.map((adapter) => [adapter.id, adapter] as const))('%s: no attribute value or CSS names a vendor', (_id, adapter) => {
    const raw = adapter.render(fullFill(adapter));
    const html = publicAdapterText(adapter.id, raw);
    for (const { attr, value } of attributesOf(html)) {
      const names = [
        ...(NAME_ATTRIBUTE.test(attr) ? [value] : []),
        ...(attr === 'style' ? cssNames(value) : []),
        ...[...value.matchAll(/url\(\s*#([\w-]+)\s*\)/g)].map((match) => match[1]!),
      ];
      for (const name of names) expect(brandHit(name, 'markup'), `${attr}="${value}"`).toBeNull();
    }
    for (const name of cssNames(publicAdapterText(adapter.id, adapter.css, 'css'))) expect(brandHit(name, 'markup'), `css ${name}`).toBeNull();
    // Renaming keeps every reference paired: nothing that resolved before stops resolving.
    expect(unresolved(html).length, 'unresolved references').toBeLessThanOrEqual(unresolved(raw).length);
  });

  it('renames footer-vite-email with the label that points at it', () => {
    const adapter = ADAPTERS.find((entry) => entry.id === 'cult:marketing-footer-vite');
    if (!adapter) return; // a later catalog may retire the block; the sweep above still covers the rest
    const html = publicAdapterText(adapter.id, adapter.render(fullFill(adapter)));
    expect(html).toContain('id="footer-email-series-vt"');
    expect(html).toContain('for="footer-email-series-vt"');
    expect(html).not.toContain('footer-vite-email');
  });
});
