// Flagship "client brief → working first draft" (docs/plans/2026-10-09-flagship/plan.md):
// the pure pieces behind POST /api/build-on-brand — the plan (with the Design Index route),
// the structure digest, the staged files and the post-build site check.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOnBrandRequestSchema, buildOnBrandPlanSchema } from '@open-design/contracts';
import type { SectionCatalogEntry } from '@open-design/contracts/api/section-catalog';

import { planBuildOnBrand } from '../src/build-on-brand/plan.js';
import { digestReferenceHtml, THIN_DIGEST_WARNING } from '../src/build-on-brand/structure-digest.js';
import { checkBuiltSite } from '../src/build-on-brand/site-check.js';
import { rolesCss, runMessage, stagedFiles } from '../src/build-on-brand/stage.js';
import { insertableCatalogEntries, renderCatalogInsert } from '../src/build-on-brand/catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = { id: 'neutral-product', title: 'Neutral Product', hasComponentsManifest: true };
const BRIEF = 'Bright Smile Family Dentistry: a three-dentist practice in Portland. Warm, calm, modern. Book online.';

function entry(id: string, sectionKind: SectionCatalogEntry['sectionKind'], spine: SectionCatalogEntry['spineAffinities'] = 'any'): SectionCatalogEntry {
  return { id, sectionKind, spineAffinities: spine, availability: 'insertable' } as SectionCatalogEntry;
}

describe('planBuildOnBrand', () => {
  it('plans exactly pageCount pages, index.html first, contact always present, every page ending in a footer', () => {
    for (const pageCount of [3, 4, 5]) {
      const request = buildOnBrandRequestSchema.parse({ brief: BRIEF, designSystemId: KIT.id, pageCount });
      const { plan } = planBuildOnBrand({ request, kit: KIT, catalog: [] });
      expect(plan.pages).toHaveLength(pageCount);
      expect(plan.pages[0]!.file).toBe('index.html');
      expect(plan.pages.map((page) => page.role)).toContain('contact');
      for (const page of plan.pages) expect(page.sections.at(-1)!.role).toBe('footer');
      expect(buildOnBrandPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it('applies the Design Index route: dropped family sections leave, kept ones join, picked entries are placed', () => {
    const request = buildOnBrandRequestSchema.parse({
      brief: BRIEF,
      designSystemId: KIT.id,
      route: { spine: 'PA', family: 'wrenfield', sections: { reviews: 'drop', trust: 'keep' }, catalogEntryIds: ['cult:faq-a', 'cult:missing'] },
    });
    const { plan, warnings } = planBuildOnBrand({ request, kit: KIT, catalog: [entry('cult:faq-a', 'faq')] });
    const allRoles = plan.pages.flatMap((page) => page.sections.map((section) => section.role));
    // Dropped: gone from every page. Kept: present somewhere (here on about.html), not doubled on home.
    expect(allRoles).not.toContain('testimonials');
    expect(allRoles.filter((role) => role === 'stats')).toHaveLength(1);
    const placed = plan.pages.flatMap((page) => page.sections).filter((section) => section.ref === 'cult:faq-a');
    expect(placed).toEqual([{ role: 'faq', source: 'catalog', ref: 'cult:faq-a' }]);
    expect(warnings.join('\n')).toContain('cult:missing');
    expect(plan.route?.family).toBe('wrenfield');
  });

  it('prefers a catalogue entry that matches the routed spine, and uses none when the library is off', () => {
    const catalog = [entry('cult:cta-z', 'cta-band', ['CO']), entry('cult:cta-b', 'cta-band', ['PA']), entry('cult:cta-a', 'cta-band', ['CO']), entry('cult:hero-a', 'hero', ['PA'])];
    const on = planBuildOnBrand({ request: buildOnBrandRequestSchema.parse({ brief: BRIEF, designSystemId: KIT.id, route: { spine: 'PA' } }), kit: KIT, catalog });
    expect(on.plan.pages[0]!.sections.find((section) => section.role === 'cta')).toEqual({ role: 'cta', source: 'catalog', ref: 'cult:cta-b' });
    // Hero stays with the kit unless the person picks a hero section.
    expect(on.plan.pages[0]!.sections[0]).toEqual({ role: 'hero', source: 'kit' });
    const off = planBuildOnBrand({ request: buildOnBrandRequestSchema.parse({ brief: BRIEF, designSystemId: KIT.id, useLibrary: false }), kit: KIT, catalog });
    expect(off.plan.pages.flatMap((page) => page.sections).every((section) => section.source === 'kit')).toBe(true);
  });
});

describe('digestReferenceHtml', () => {
  it('keeps order and roles of the reference fixture and holds none of its copy', async () => {
    const html = await readFile(path.join(HERE, 'fixtures', 'build-on-brand', 'reference-site.html'), 'utf8');
    const { digest, warnings } = digestReferenceHtml(html);
    expect(warnings).toEqual([]);
    expect(digest.pages[0]!.sections.map((section) => section.role)).toEqual(['hero', 'features', 'testimonials', 'pricing', 'faq', 'cta', 'footer']);
    expect(digest.pages[0]!.sections.find((section) => section.role === 'faq')!.layout).toBe('list');
    expect(digest.nav).toEqual({ itemCount: 5, hasCta: true });
    expect(digest.pages.map((page) => page.role)).toEqual(['home', 'pricing', 'about', 'contact']);
    expect(JSON.stringify(digest)).not.toMatch(/Harbor|quay|Bean Club|harbor-and-pine/u);
  });

  it('gives an empty digest and a warning for a JavaScript shell', () => {
    const { digest, warnings } = digestReferenceHtml('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
    expect(digest.pages).toEqual([]);
    expect(warnings).toEqual([THIN_DIGEST_WARNING]);
  });
});

describe('staging', () => {
  it('maps every --role-* onto the --brand-* tokens a brand-imported kit carries in system/variables.css', () => {
    // Lines from a real imported kit's system/variables.css (brands/engine/export.ts output).
    const variablesCss = [
      ':root {',
      '  --brand-color-primary: #f7c59c;',
      '  --brand-color-text: #5f302a;',
      '  --brand-color-text-secondary: #86625b;',
      '  --brand-color-bg-layout: #ece5dc;',
      '  --brand-color-bg-container: #f3eee4;',
      '  --brand-color-bg-elevated: #fbf8f3;',
      '  --brand-color-border: #d9cfc4;',
      "  --brand-font-family: 'Fraunces', Georgia, serif;",
      "  --brand-font-family-code: 'IBM Plex Mono', monospace;",
      '}',
      '.dark {',
      '  --brand-color-text: #f3eee4;',
      '}',
    ].join('\n');
    const roles = rolesCss(variablesCss);
    expect(roles).toContain('--role-background: var(--brand-color-bg-container, #ffffff);');
    expect(roles).toContain('--role-surface: var(--brand-color-bg-elevated, var(--brand-color-bg-layout, #f6f6f6));');
    expect(roles).toContain('--role-foreground: var(--brand-color-text, #111111);');
    expect(roles).toContain('--role-muted: var(--brand-color-text-secondary, #555555);');
    expect(roles).toContain('--role-accent: var(--brand-color-primary, #1e5a78);');
    expect(roles).toContain('--role-border: var(--brand-color-border, #dddddd);');
    expect(roles).toContain('--role-font-display: var(--brand-font-family, system-ui, sans-serif);');
    expect(roles).toContain('--role-font-body: var(--brand-font-family, system-ui, sans-serif);');
    expect(roles).toContain('--role-font-mono: var(--brand-font-family-code, ui-monospace, monospace);');
  });

  it('maps every --role-* onto kit tokens and inlines the plan in the run message', async () => {
    const tokensCss = await readFile(path.join(HERE, '..', '..', '..', 'design-systems', 'neutral-product', 'tokens.css'), 'utf8');
    const roles = rolesCss(tokensCss);
    for (const role of ['background', 'surface', 'foreground', 'muted', 'accent', 'on-accent', 'border']) {
      expect(roles).toMatch(new RegExp(`--role-${role}: var\\(--`));
    }
    const request = buildOnBrandRequestSchema.parse({ brief: BRIEF, designSystemId: KIT.id });
    const { plan } = planBuildOnBrand({ request, kit: KIT, catalog: [] });
    const input = { brief: BRIEF, plan, tokensCss, inserts: [], warnings: [] };
    const files = stagedFiles(input);
    expect(Object.keys(files).sort()).toEqual(['_brand-build/BUILD.md', '_brand-build/NOTICE.md', '_brand-build/base.css', '_brand-build/plan.json', '_brand-build/roles.css', 'tokens.css']);
    expect(files['_brand-build/base.css']).toContain('prefers-reduced-motion: reduce');
    const message = runMessage(input);
    expect(message).toContain(BRIEF);
    expect(message).toContain('--accent');
    for (const page of plan.pages) expect(message).toContain(page.file);
    expect(message).toContain('od-stand-in');
  });

  it('renders an insertable catalogue entry with {{slot}} placeholders and no literal colours', async () => {
    const hero = insertableCatalogEntries().find((candidate) => candidate.sectionKind === 'hero');
    expect(hero).toBeDefined();
    const insert = await renderCatalogInsert(hero!.id);
    expect(insert).not.toBeNull();
    expect(insert!.html).toMatch(/\{\{[a-zA-Z0-9.]+\}\}/u);
    expect(insert!.css).not.toMatch(/(?<![\w-])#[0-9a-fA-F]{6}\b/u);
    expect(await renderCatalogInsert('cult:not-a-real-entry')).toBeNull();
  });
});

describe('checkBuiltSite', () => {
  const page = (name: string, links: string[], extra = '') => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="_brand-build/base.css"></head>
<body><nav aria-label="Primary">${links.map((link) => `<a href="${link}">${link}</a>`).join('')}</nav>
<h1>${name}</h1><div class="od-stand-in" role="img" aria-label="Stand-in image: the clinic"></div>${extra}</body></html>`;
  const clean = () => ({
    'index.html': page('Home', ['index.html', 'services.html', 'contact.html']),
    'services.html': page('Services', ['index.html', 'services.html', 'contact.html']),
    'contact.html': page('Contact', ['index.html', 'services.html', 'contact.html', 'tel:+15555550100', '#top']),
    'tokens.css': ':root { --accent: #1e5a78; }',
    '_brand-build/base.css': '@media (prefers-reduced-motion: reduce) { * { animation: none; } }',
  });

  it('passes a clean three-page site', () => {
    const result = checkBuiltSite(clean());
    expect(result.rules.filter((rule) => !rule.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pages).toEqual(['index.html', 'contact.html', 'services.html']);
  });

  it.each([
    ['pages-present', (files: Record<string, string>) => { delete files['services.html']; }],
    ['nav-links-resolve', (files: Record<string, string>) => { files['index.html'] = page('Home', ['about.html', 'contact.html', 'services.html']); }],
    ['viewport-meta', (files: Record<string, string>) => { files['index.html'] = files['index.html']!.replace(/<meta name="viewport"[^>]*>/u, ''); }],
    ['reduced-motion', (files: Record<string, string>) => { files['_brand-build/base.css'] = '* { box-sizing: border-box; }'; }],
    ['kit-tokens-linked', (files: Record<string, string>) => { files['contact.html'] = files['contact.html']!.replace('href="tokens.css"', 'href="site.css"'); }],
    ['stand-ins-labelled', (files: Record<string, string>) => { files['index.html'] = page('Home', ['contact.html', 'services.html'], '<div class="od-stand-in"></div>'); }],
    ['no-remote-images', (files: Record<string, string>) => { files['index.html'] = page('Home', ['contact.html', 'services.html'], '<img src="https://cdn.example.com/a.jpg" alt="x">'); }],
  ])('fails %s', (ruleId, breakIt) => {
    const files = clean() as Record<string, string>;
    breakIt(files);
    const result = checkBuiltSite(files);
    expect(result.ok).toBe(false);
    expect(result.rules.find((rule) => rule.id === ruleId)?.ok).toBe(false);
  });
});
