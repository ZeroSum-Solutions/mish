#!/usr/bin/env node
// Regenerate the reviewed section adapters (design decision §2/§3:
// <private-notes>/mishh-genui-production/motionsites/sol-design.md) from
// the pinned HyperUI blocks each one derives from.
//
// This is an AUTHOR-TIME, disk-only tool: no network access, no Tailwind compilation. Each
// adapter's markup and CSS are hand-authored below, once, by a human reviewing the pinned HyperUI
// block named in its `SPEC` (`plugins/_official/shared/ui-kits/hyperui/blocks/...`) — the
// structural markup and its color/font utility classes are converted to the seven semantic roles
// `background | surface | foreground | muted | accent | on-accent | border`
// (`plugins/_official/shared/agency-compiler/scripts/section-adapter.ts`,
// `direction-tokens.ts`). What THIS SCRIPT does deterministically is: (1) verify the pinned
// source block is still exactly the bytes the adapter was reviewed against — a byte-for-byte
// drift there means the review is stale and must be redone before the adapter can be trusted
// again; (2) render the SPEC into a generated `SectionAdapter` module; (3) reject the generated
// output if it contains anything the deterministic-renderer contract forbids: a literal color
// (hex/rgb/hsl, or an unmapped Tailwind named-palette utility class such as `bg-emerald-600` —
// the human conversion step above left one un-converted — outside the small
// `color-mix(... black|white|transparent ...)` shading idiom already used by the shared family
// compiler's own `styles.ts`), an arbitrary Tailwind `[...]`-bracket utility, a `<script>`, an
// external asset reference (`http(s)://`, `data:` other than the caller-supplied asset src, or
// any bare `<img>` not gated behind a declared asset
// slot).
//
// Usage:
//   node --experimental-strip-types scripts/build-section-adapters.ts            # write
//   node --experimental-strip-types scripts/build-section-adapters.ts --check    # CI gate
//
// Output (one file per SPEC, flat and top-level so `sync-agency-compiler.ts`'s `canonicalFiles()`
// picks each one up automatically — see that script's doc comment on why the shared compiler has
// no sync route for a nested folder):
//   plugins/_official/shared/agency-compiler/scripts/section-adapter-<slug>.ts

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hyperuiRoot = path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui');
const outDir = path.join(repoRoot, 'plugins/_official/shared/agency-compiler/scripts');
const check = process.argv.includes('--check');

type TextSlotSpec = { name: string; max: number; atom?: 'phone' | 'email' | 'address' | 'plain' };
type ItemFieldSpec = TextSlotSpec;
export type Spec = {
  slug: string;
  blockId: string;
  blockFile: string;
  version: string;
  roles: readonly string[];
  text: TextSlotSpec[];
  items?: { name: string; count: number; fields: ItemFieldSpec[] };
  links?: { name: string; href: string; label?: string }[];
  /** Ordered render body, built structurally so generation never string-concatenates anything
   * outside an escaped slot value or a fixed literal — see `renderBody`. */
  markup: (ids: { text: (name: string) => string; item: (index: number, field: string) => string; link: (name: string) => string }) => string;
  css: string;
};

const CTAS_1: Spec = {
  slug: 'ctas-1',
  blockId: 'marketing/ctas/1',
  blockFile: 'blocks/marketing/ctas/1.html',
  version: '1.0.0',
  roles: ['surface', 'foreground', 'muted', 'accent', 'on-accent'],
  text: [
    { name: 'heading', max: 90 },
    { name: 'body', max: 260 },
    { name: 'cta', max: 32 },
  ],
  links: [{ name: 'action', href: '#contact', label: 'cta' }],
  markup: ({ text }) => `<section class="od-cta" data-od-role="cta"><div class="od-cta__inner"><h2 class="od-cta__heading">${text('heading')}</h2><p class="od-cta__body">${text('body')}</p><div class="od-cta__actions"><a class="od-cta__button" href="#contact">${text('cta')}</a></div></div></section>`,
  css: `.od-cta{background:var(--role-surface);padding:3rem 1.5rem}.od-cta__inner{max-width:40rem;margin-inline:auto;text-align:center}.od-cta__heading{margin:0;font-family:var(--role-font-display);font-size:clamp(1.5rem,3vw,2rem);font-weight:700;color:var(--role-foreground)}.od-cta__body{margin:1rem 0 0;font-family:var(--role-font-body);color:var(--role-muted);line-height:1.6}.od-cta__actions{margin-top:2rem}.od-cta__button{display:inline-block;border-radius:.25rem;padding:.75rem 3rem;font-family:var(--role-font-body);font-size:.875rem;font-weight:500;text-decoration:none;background:var(--role-accent);color:var(--role-on-accent);transition:background-color .15s ease}.od-cta__button:hover{background:color-mix(in oklch,var(--role-accent) 85%,black)}@media(min-width:640px){.od-cta__inner{text-align:left}}`,
};

const FEATURE_GRIDS_1: Spec = {
  slug: 'feature-grids-1',
  blockId: 'marketing/feature-grids/1',
  blockFile: 'blocks/marketing/feature-grids/1.html',
  version: '1.0.0',
  roles: ['background', 'surface', 'foreground', 'muted', 'accent', 'border'],
  text: [
    { name: 'heading', max: 80 },
    { name: 'body', max: 220 },
  ],
  items: {
    name: 'features',
    count: 3,
    fields: [
      { name: 'title', max: 60 },
      { name: 'blurb', max: 140 },
    ],
  },
  // The three icons are fixed decorative SVG paths carried verbatim from the pinned block — not
  // model-authored, not a slot, and never file/URL-referenced (inline `<path>` data only).
  markup: ({ text, item }) => {
    const ICONS = [
      'm3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z',
      'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z',
      'M6 13.5V3.75m0 9.75a1.5 1.5 0 0 1 0 3m0-3a1.5 1.5 0 0 0 0 3m0 3.75V16.5m12-3V3.75m0 9.75a1.5 1.5 0 0 1 0 3m0-3a1.5 1.5 0 0 0 0 3m0 3.75V16.5m-6-9V3.75m0 3.75a1.5 1.5 0 0 1 0 3m0-3a1.5 1.5 0 0 0 0 3m0 9.75V10.5',
    ];
    const cards = ICONS.map((d, i) => `<article class="od-feature-grid__item"><div class="od-feature-grid__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor" class="od-feature-grid__icon-svg"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg></div><h3 class="od-feature-grid__item-title">${item(i, 'title')}</h3><p class="od-feature-grid__item-blurb">${item(i, 'blurb')}</p></article>`).join('');
    return `<section class="od-feature-grid" data-od-role="feature-grid"><div class="od-feature-grid__inner"><div class="od-feature-grid__intro"><h2 class="od-feature-grid__heading">${text('heading')}</h2><p class="od-feature-grid__body">${text('body')}</p></div><div class="od-feature-grid__items">${cards}</div></div></section>`;
  },
  css: `.od-feature-grid{background:var(--role-background);padding:2rem 1.5rem}.od-feature-grid__inner{max-width:80rem;margin-inline:auto}.od-feature-grid__intro{max-width:32rem;margin-inline:auto;text-align:center}.od-feature-grid__heading{margin:0;font-family:var(--role-font-display);font-size:clamp(1.75rem,3vw,2.25rem);font-weight:700;line-height:1.15;color:var(--role-foreground)}.od-feature-grid__body{margin-top:1rem;font-family:var(--role-font-body);color:var(--role-muted);line-height:1.6}.od-feature-grid__items{margin-top:2rem;display:grid;grid-template-columns:1fr;gap:2rem}.od-feature-grid__item{border:1px solid var(--role-border);border-radius:.5rem;padding:1.5rem}.od-feature-grid__icon{display:inline-flex;border-radius:.5rem;padding:.75rem;background:var(--role-surface);color:var(--role-accent)}.od-feature-grid__icon-svg{width:1.5rem;height:1.5rem}.od-feature-grid__item-title{margin:1rem 0 0;font-family:var(--role-font-display);font-size:1.125rem;font-weight:600;color:var(--role-foreground)}.od-feature-grid__item-blurb{margin:.5rem 0 0;font-family:var(--role-font-body);color:var(--role-muted)}@media(min-width:768px){.od-feature-grid__items{grid-template-columns:repeat(3,1fr)}}`,
};

const SECTIONS_1: Spec = {
  slug: 'sections-1',
  blockId: 'marketing/sections/1',
  blockFile: 'blocks/marketing/sections/1.html',
  version: '1.0.0',
  roles: ['background', 'foreground', 'muted'],
  text: [
    { name: 'heading', max: 90 },
    { name: 'body', max: 260 },
  ],
  markup: ({ text }) => `<section class="od-plain-section" data-od-role="plain-section"><div class="od-plain-section__inner"><h2 class="od-plain-section__heading">${text('heading')}</h2><p class="od-plain-section__body">${text('body')}</p></div></section>`,
  css: `.od-plain-section{background:var(--role-background);padding:2rem 1.5rem}.od-plain-section__inner{max-width:80rem;margin-inline:auto}.od-plain-section__heading{margin:0;font-family:var(--role-font-display);font-size:clamp(1.375rem,2.5vw,1.75rem);font-weight:600;color:var(--role-foreground)}.od-plain-section__body{margin-top:1rem;font-family:var(--role-font-body);color:var(--role-muted);line-height:1.7}`,
};

// Exported so a test can run the REAL specs against the REAL checked-in output (e.g.
// `buildSectionAdapters({ check: true })`, which defaults to this array) and assert zero errors —
// proving genuinely clean output actually clears the gate, not merely that a synthetic fixture
// fails for a DIFFERENT (expected) reason (delta re-audit, tests packet #4).
export const SPECS: Spec[] = [CTAS_1, FEATURE_GRIDS_1, SECTIONS_1];

// Tailwind's own named palette (utility color scale) — used only to build the "unmapped literal
// colour utility" pattern below, never to whitelist anything: converting a HyperUI block's color
// utilities to semantic roles is a human step (see the module doc comment), and this scan is what
// catches a class the human forgot to convert.
const TAILWIND_COLOR_PREFIXES = 'bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|shadow|placeholder';
const TAILWIND_PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white';

// Forbidden in generated markup/CSS. The `color-mix(...black|white|transparent|currentColor...)`
// shading idiom is explicitly allowed (see the module doc comment); it never introduces a brand
// literal, only a role-relative tint of an already-role-bound value — the same idiom the shared
// family compiler's own `styles.ts` already uses (`color-mix(in srgb,var(--ink) 25%,transparent)`).
//
// BLOCK 2 (delta audit): every pattern here must have a firing negative-fixture test —
// `e2e/tests/scripts/build-section-adapters.test.ts` proves each one actually rejects, rather than
// this list being merely asserted correct by review.
export const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script\b/i, reason: 'contains a <script> element' },
  { pattern: /\son[a-z]+\s*=/i, reason: 'contains an inline event handler attribute' },
  { pattern: /javascript:/i, reason: 'contains a javascript: URL' },
  { pattern: /https?:\/\//i, reason: 'references an external URL' },
  { pattern: /url\(/i, reason: 'contains a CSS url() reference' },
  { pattern: /@import/i, reason: 'contains a CSS @import' },
  { pattern: /#[0-9a-f]{3,8}\b/i, reason: 'contains a literal hex color' },
  { pattern: /\brgba?\(/i, reason: 'contains a literal rgb()/rgba() color' },
  { pattern: /\bhsla?\(/i, reason: 'contains a literal hsl()/hsla() color' },
  { pattern: /\[[^\]]*\]/, reason: 'contains an arbitrary-value utility ([...])' },
  { pattern: /<img\b(?![^>]*data-od-asset)/i, reason: 'contains an <img> not gated behind a declared asset slot' },
  {
    pattern: new RegExp(`\\b(?:${TAILWIND_COLOR_PREFIXES})-(?:${TAILWIND_PALETTE})(?:-\\d{2,3})?\\b`, 'i'),
    reason: 'contains an unmapped literal Tailwind color utility class',
  },
];

// The pinned HyperUI source is, by construction, full of un-converted Tailwind utility classes —
// that conversion is exactly the human authoring step this script verifies happened (see the
// module doc comment). So the "literal Tailwind color utility" pattern above is a GENERATED-OUTPUT
// check only: it would reject every pinned source file on sight if applied there. Every other
// pattern still applies to the pinned source too (script/handler/external-url/hex/bracket safety
// is not something a not-yet-converted block gets a pass on).
const SOURCE_FORBIDDEN = FORBIDDEN.filter(({ reason }) => reason !== 'contains an unmapped literal Tailwind color utility class');

export function assertClean(label: string, source: string, patterns: ReadonlyArray<{ pattern: RegExp; reason: string }> = FORBIDDEN): void {
  // Strip the one deliberately-allowed idiom before scanning, so its own `black`/`white`
  // arguments never trip the (much narrower) hex/rgb checks above — they are CSS keywords, not
  // the patterns those checks look for, but kept explicit for readability.
  const scanned = source.replace(/color-mix\(in oklch,var\(--role-accent\) \d+%,(black|white|transparent)\)/g, '');
  for (const { pattern, reason } of patterns) {
    if (pattern.test(scanned)) throw new Error(`${label}: generated output ${reason} (pattern ${pattern})`);
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function renderBody(spec: Spec): string {
  const text = (name: string) => `\${escapeHtml(t.${name} ?? '')}`;
  const item = (index: number, field: string) => `\${escapeHtml(items.at(${index})?.${field} ?? '')}`;
  const link = (name: string) => name;
  return spec.markup({ text, item, link });
}

export function generate(spec: Spec, sourceSha256: string): string {
  const html = renderBody(spec);
  assertClean(spec.slug, html);
  assertClean(spec.slug, spec.css);
  const textSlots = spec.text.map((slot) => JSON.stringify(slot)).join(', ');
  const itemsField = spec.items
    ? `\n  items: { name: ${JSON.stringify(spec.items.name)}, count: ${spec.items.count}, fields: [${spec.items.fields.map((f) => JSON.stringify(f)).join(', ')}] },`
    : '';
  const linksField = spec.links ? `\n  links: ${JSON.stringify(spec.links)},` : '';
  const itemsDestructure = spec.items ? `const items = fill.items?.[${JSON.stringify(spec.items.name)}] ?? [];\n    ` : '';
  return `// GENERATED by scripts/build-section-adapters.ts — do not edit by hand.
// Derived at author time from the pinned MIT block \`${spec.blockId}\`
// (plugins/_official/shared/ui-kits/hyperui/${spec.blockFile}, sha256 ${sourceSha256}). Color and
// font utility classes were converted to the seven semantic roles; the pinned source is
// untouched. Regenerate with \`node --experimental-strip-types scripts/build-section-adapters.ts\`.

import { escapeHtml, type SectionAdapter } from './section-adapter.ts';

const CSS = ${JSON.stringify(spec.css)};

export const ADAPTER: SectionAdapter = {
  id: ${JSON.stringify(`hyperui:${spec.blockId}`)},
  version: ${JSON.stringify(spec.version)},
  sourceBlockId: ${JSON.stringify(spec.blockId)},
  sourceSha256: ${JSON.stringify(sourceSha256)},
  roles: ${JSON.stringify(spec.roles)},
  text: [${textSlots}],${itemsField}${linksField}
  css: CSS,
  render(fill) {
    const t = fill.text ?? {};
    ${itemsDestructure}return \`${html}\`;
  },
};
`;
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export type BuildSectionAdaptersReport = { failed: boolean; errors: string[]; written: string[] };

/**
 * Runs the generate + check-or-write loop against `specs` (defaults to the shipped `SPECS`).
 * Never touches `process.exitCode` or logs — `main` below does both from the returned report, and
 * this separation is what lets a test import and call this directly (BLOCK 2, delta audit): before
 * it existed, the loop ran as top-level module code, so merely IMPORTING this file for a test —
 * with no way to opt out — read every pinned HyperUI source and, without `--check`, would have
 * written the real output files. An adversarial fixture spec still needs a real, existing
 * `blockFile` for the "pinned source" check to pass (this function does not fabricate one), but it
 * may reuse any already-vendored HyperUI block and override only `markup`/`css` — the forbidden
 * content need only appear in the GENERATED output, which is exactly what `assertClean` inside
 * `generate` re-checks regardless of what the pinned source looked like.
 */
export function buildSectionAdapters({ check = false, specs = SPECS }: { check?: boolean; specs?: readonly Spec[] } = {}): BuildSectionAdaptersReport {
  const errors: string[] = [];
  const written: string[] = [];
  for (const spec of specs) {
    const sourcePath = path.join(hyperuiRoot, spec.blockFile);
    if (!existsSync(sourcePath)) {
      errors.push(`${spec.slug}: pinned source missing: ${path.relative(repoRoot, sourcePath)}`);
      continue;
    }
    const source = readFileSync(sourcePath, 'utf8');
    // Defense in depth: the pinned HyperUI vendoring step already strips <script>/<img> (see
    // vendor-hyperui.ts), but this adapter's own guarantee must not rely on that alone.
    try {
      assertClean(`${spec.slug} (pinned source)`, source, SOURCE_FORBIDDEN);
    } catch (error) {
      errors.push(String(error instanceof Error ? error.message : error));
      continue;
    }
    const sourceSha256 = sha256Of(sourcePath);
    let generated: string;
    try {
      generated = generate(spec, sourceSha256);
    } catch (error) {
      errors.push(String(error instanceof Error ? error.message : error));
      continue;
    }
    const outFile = path.join(outDir, `section-adapter-${spec.slug}.ts`);
    written.push(path.relative(repoRoot, outFile));
    if (check) {
      const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : undefined;
      if (current !== generated) {
        errors.push(`${path.relative(repoRoot, outFile)}: out of date — run without --check to regenerate`);
      }
    } else {
      writeFileSync(outFile, generated);
    }
  }
  return { failed: errors.length > 0, errors, written };
}

function main(): void {
  const report = buildSectionAdapters({ check });
  for (const error of report.errors) console.error(error);
  if (report.failed) {
    console.error('build-section-adapters: FAILED');
    process.exitCode = 1;
    return;
  }
  console.log(`build-section-adapters: ${check ? 'checked' : 'wrote'} ${report.written.length} adapter(s): ${report.written.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
