import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { demoDocument, genuiCatalog } from '@mish/genui-catalog/data';
import { convertedPreviewHtml } from '../../src/cult-live-preview.js';
import { CULT_CONVERTED_DOCUMENT_CSP } from '../../src/routes/cult-live-preview.js';
import { BundledCultPreviews } from '../../src/services/bundled-cult-previews.js';
import { GSAP_RECIPE_IDS, GSAP_RECIPES } from '../../src/workbench/recipes/gsap/recipes.js';
import { loadGsapRuntime } from '../../src/workbench/recipes/gsap/runtime.js';
import { renderGsapPreview } from '../../src/workbench/recipes/gsap/materials.js';
import { renderSectionPreview } from '../../src/workbench/section-previews.js';
import { publicCultEntry } from '../../src/routes/sections.js';
import type { SectionCatalogEntry } from '@mish/contracts/api/section-catalog';
import sectionCatalogJson from '@mish/section-catalog/catalog.json' with { type: 'json' };

/**
 * AC-R07 preamble: "no CDN Tailwind". Every document an Enlarge preview can open is checked here
 * at its source, so a regression is caught before any browser runs it: no Tailwind runtime (Play
 * CDN script, `@tailwindcss/browser`, an in-page `tailwind.config`), no `<script src>` and no
 * module import from another origin. The Enlarge host also enforces a no-network policy at run
 * time (web `workbench-preview-adapters` spec); this spec keeps the documents themselves honest,
 * because a CDN script blocked at run time is a preview that silently renders unstyled.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const pluginsRoot = path.join(repoRoot, 'plugins', '_official');
const cultKit = path.join(repoRoot, 'data', 'component-kits', 'cult-ui-pro');

const REMOTE = String.raw`(?:https?:)?\/\/`;
const CHECKS: Array<[string, RegExp]> = [
  ['Tailwind Play CDN', /cdn\.tailwindcss\.com/i],
  ['Tailwind browser runtime', /@tailwindcss\/browser|tailwindcss(?:@[\w.-]+)?\/(?:dist\/)?(?:lib|tailwind)(?:\.min)?\.js/i],
  ['in-page Tailwind config', /\btailwind\.config\s*=/],
  ['remote <script src>', new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*["']?${REMOTE}`, 'i')],
  ['remote module import', new RegExp(String.raw`\bimport\s*(?:\(\s*|[\w*{}\s,]+\bfrom\s*)["']${REMOTE}`, 'i')],
  ['remote modulepreload', new RegExp(String.raw`<link\b[^>]*\brel\s*=\s*["']?(?:modulepreload|preload)["']?[^>]*\bhref\s*=\s*["']?${REMOTE}[^"'\s>]*\.m?js`, 'i')],
];

const REMOTE_URL = /^\s*["']?((?:https?:)?\/\/([^/"'\s)]+)[^"'\s)]*)/iu;
const hostOf = (value: string) => REMOTE_URL.exec(value)?.[2]?.toLowerCase() ?? null;
/** Sol r07 WARN: remote CSS and fonts count too — a blocked font stylesheet silently changes typography. */
function remoteStyleViolations(html: string): string[] {
  const found = new Set<string>();
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/iu.exec(tag)?.[1]?.toLowerCase() ?? '';
    const as = /\bas\s*=\s*["']?([^"'\s>]+)/iu.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*(["']?[^"'\s>]+)/iu.exec(tag)?.[1] ?? '';
    const host = hostOf(href);
    if (!host) continue;
    if (/\bstylesheet\b/u.test(rel) || (/\bpreload\b/u.test(rel) && /^(?:style|font)$/u.test(as))) found.add(`remote stylesheet: ${host}`);
  }
  for (const match of html.matchAll(/@import\s+(?:url\()?([^;)]+)/giu)) { const host = hostOf(match[1]!); if (host) found.add(`remote @import: ${host}`); }
  for (const block of html.match(/@font-face\s*\{[^}]*\}/giu) ?? []) {
    for (const match of block.matchAll(/url\(([^)]+)\)/giu)) { const host = hostOf(match[1]!); if (host) found.add(`remote font: ${host}`); }
  }
  return [...found];
}

function cdnViolations(html: string): string[] {
  return [...CHECKS.filter(([, pattern]) => pattern.test(html)).map(([label]) => label), ...remoteStyleViolations(html)];
}

/**
 * The only remote CSS a bundled preview may still name: Google Fonts stylesheets, pending R11 font
 * bytes (owner decision on bundling font files). Each stays blocked at run time by the Enlarge
 * floor policy, so these previews render with fallback fonts and load nothing remote. An entry
 * must match exactly; a file that no longer needs its entry fails as stale, and no other host or
 * kind of remote load may be listed.
 */
const GOOGLE_FONTS_STYLESHEET = 'remote stylesheet: fonts.googleapis.com';
const GOOGLE_FONTS_IMPORT = 'remote @import: fonts.googleapis.com';
const REMOTE_FONT_ALLOWLIST: ReadonlySet<string> = new Set([
  `plugins/_official/examples/mockup-device-3d/example.html: ${GOOGLE_FONTS_STYLESHEET}`,
]);

function findFiles(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === name) out.push(file);
    }
  };
  walk(root);
  return out;
}

function report(documents: Array<[string, string]>, allowlist: ReadonlySet<string> = new Set()): string[] {
  const all = documents.flatMap(([id, html]) => cdnViolations(html).map(label => `${id}: ${label}`));
  // Every entry must match an observed violation; an entry whose document is no longer scanned
  // (removed or renamed) observes nothing, so it is stale too.
  const stale = [...allowlist].filter(entry => !all.includes(entry)).map(entry => `stale allowlist entry: ${entry}`);
  return [...all.filter(entry => !allowlist.has(entry)), ...stale];
}

describe('the CDN detector', () => {
  it('flags the Tailwind Play CDN, remote scripts and remote module imports but not local or inline ones', () => {
    expect(cdnViolations('<script src="https://cdn.tailwindcss.com"></script>')).toEqual(expect.arrayContaining(['Tailwind Play CDN', 'remote <script src>']));
    expect(cdnViolations('<script src="//unpkg.com/react"></script>')).toEqual(['remote <script src>']);
    expect(cdnViolations('<script type="module">import x from "https://esm.sh/x";</script>')).toEqual(['remote module import']);
    expect(cdnViolations('<script>tailwind.config = {}</script>')).toEqual(['in-page Tailwind config']);
    expect(cdnViolations('<script src="./app.js"></script><script>window.ok = 1</script><style>.x{}</style>')).toEqual([]);
  });
  it('flags remote stylesheets, @import and @font-face sources, but not local ones', () => {
    expect(cdnViolations('<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">')).toEqual(['remote stylesheet: fonts.googleapis.com']);
    expect(cdnViolations('<link rel="preload" as="font" href="//cdn.example/f.woff2">')).toEqual(['remote stylesheet: cdn.example']);
    expect(cdnViolations('<style>@import url("https://cdn.example/a.css");</style>')).toEqual(['remote @import: cdn.example']);
    expect(cdnViolations('<style>@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)}</style>')).toEqual(['remote font: fonts.gstatic.com']);
    expect(cdnViolations('<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="fixture.css"><style>@font-face{src:url(fonts/x.woff2)}@import "local.css";</style>')).toEqual([]);
  });
});

describe('the allow-list check (R07 round 3 WARN)', () => {
  const entry = `plugins/_official/examples/renamed/example.html: ${GOOGLE_FONTS_STYLESHEET}`;
  it('fails an entry whose document is no longer scanned (removed or renamed), not only one whose document stopped needing it', () => {
    expect(report([['plugins/_official/examples/other/example.html', '<p>local only</p>']], new Set([entry]))).toEqual([`stale allowlist entry: ${entry}`]);
    expect(report([['plugins/_official/examples/renamed/example.html', '<p>local only</p>']], new Set([entry]))).toEqual([`stale allowlist entry: ${entry}`]);
    expect(report([['plugins/_official/examples/renamed/example.html', '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">']], new Set([entry]))).toEqual([]);
  });
});

describe('no CDN Tailwind, remote script, stylesheet or font in any Enlarge preview document', () => {
  it('lists only Google Fonts entries, pending R11 font bytes', () => {
    for (const entry of REMOTE_FONT_ALLOWLIST) expect(entry).toMatch(/^plugins\/_official\/examples\/[a-z0-9-]+\/example\.html: remote (?:stylesheet|@import): fonts\.googleapis\.com$/u);
  });
  it('bundled plugin previews', () => {
    const documents: Array<[string, string]> = [];
    for (const manifestFile of findFiles(pluginsRoot, 'mish.json')) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { od?: { preview?: { entry?: string } } };
      const entry = manifest.od?.preview?.entry;
      if (!entry) continue;
      const file = path.resolve(path.dirname(manifestFile), entry);
      if (!existsSync(file) || !/\.html?$/i.test(file)) continue;
      documents.push([path.relative(repoRoot, file), readFileSync(file, 'utf8')]);
    }
    expect(documents).toHaveLength(18);
    expect(report(documents, REMOTE_FONT_ALLOWLIST)).toEqual([]);
  });

  it('GenUI component demos', () => {
    const documents = genuiCatalog.manifest.components.flatMap((entry): Array<[string, string]> => {
      const html = demoDocument(entry.id);
      return html ? [[`genui:${entry.id}`, html]] : [];
    });
    expect(documents.length).toBeGreaterThan(20);
    expect(report(documents)).toEqual([]);
  });

  it('GSAP recipe previews', () => {
    const runtime = loadGsapRuntime();
    const documents = GSAP_RECIPE_IDS.map((id): [string, string] => [`gsap:${id}`, renderGsapPreview(GSAP_RECIPES[id], runtime)]);
    expect(report(documents)).toEqual([]);
  });

  it('compiled HTML section previews (HyperUI blocks and Cult layouts)', () => {
    const catalog = (sectionCatalogJson as { entries: SectionCatalogEntry[] }).entries;
    const roots = { hyperuiRoot: path.join(pluginsRoot, 'shared', 'ui-kits', 'hyperui'), cultKitDir: cultKit };
    const documents = catalog.flatMap((raw): Array<[string, string]> => {
      const entry = publicCultEntry(raw);
      const preview = entry ? renderSectionPreview(entry, catalog, roots) : null;
      return preview?.status === 200 ? [[`section:${entry!.id}`, preview.html]] : [];
    });
    expect(documents.length).toBe(catalog.filter(entry => entry.content.kind === 'vendored-block').length);
    expect(report(documents)).toEqual([]);
  });

  it('does not expose converted or bundled Cult previews without the private kit', () => {
    expect(existsSync(cultKit)).toBe(false);
    expect(BundledCultPreviews.installed(cultKit)).toBe(false);
    expect(convertedPreviewHtml(cultKit, 'owned-fixture', 'light', CULT_CONVERTED_DOCUMENT_CSP)).toBeNull();
  });
});
