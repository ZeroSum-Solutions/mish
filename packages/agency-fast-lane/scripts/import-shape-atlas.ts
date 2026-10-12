/**
 * Re-imports the Website Shape Atlas from its static HTML into `src/atlas/shape-atlas.json`.
 *
 *   node --experimental-strip-types scripts/import-shape-atlas.ts <file-or-https-url> [--out src/atlas/shape-atlas.json]
 *   npm run import-atlas -- <path-or-url>
 *
 * The atlas page is static HTML, so this is a regex parse rather than a DOM parse: spine cards
 * (`article.spine-card`), archetype cards (`article.archetype-card`, reading `data-family` and
 * `data-search`), the compatibility matrix (`table.matrix`, `tr[data-row]`, `td[data-score]`),
 * the skin strip (`.skin-strip span`), the "Cross-cutting formats" panel (`<b>`/`<span>` pairs),
 * and the page's own `familyDetails` script object for the per-spine transfer notes. HTML
 * entities are unescaped. `version` comes from the page's "v1.0" composition-ledger badge;
 * `fetched` is today's date, unless the caller overrides both via `parseAtlasHtml`'s `meta`.
 *
 * `familyDetails`'s array literals are matched with `\s*\]` rather than `"\]`, because the real
 * page's MI entry carries a trailing space before its closing bracket — a plain `"\]` match would
 * silently drop that one spine's transfer note (see `docs/plans/2026-09-19-spine-router-design.md`).
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateShapeAtlas, type Archetype, type Format, type ShapeAtlas, type Spine, type TransferNote } from '../src/atlas.ts';

/** The atlas's own canonical URL, used as `source` when importing from a local HTML snapshot
 * rather than fetching it live — a snapshot file's path is not itself a useful provenance record. */
const CANONICAL_ATLAS_URL = 'https://mishmash-website-shape-atlas.netlify.app/website-shape-atlas.html';

function unescapeEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

const clean = (text: string): string => unescapeEntities(text).trim();
const splitList = (text: string, separator: string): string[] => clean(text).split(separator).map((part) => part.trim()).filter(Boolean);

const SPINE_CARD_RE =
  /<article class="spine-card"><div class="spine-top"><span class="spine-code">([^<]*)<\/span><span class="spine-family">([^<]*)<\/span><\/div><h3>([^<]*)<\/h3><p>([^<]*)<\/p><div class="spine-flow">([^<]*)<\/div><div class="spine-cta">CTA:\s*([^<]*)<\/div><\/article>/g;

function parseSpines(html: string): Spine[] {
  return [...html.matchAll(SPINE_CARD_RE)].map((m) => ({
    code: clean(m[1]!),
    kind: clean(m[2]!),
    name: clean(m[3]!),
    intent: clean(m[4]!),
    steps: splitList(m[5]!, ' → '),
    ctas: splitList(m[6]!, ', '),
  }));
}

const ARCHETYPE_CARD_RE =
  /<article class="archetype-card paper" data-family="([^"]*)" data-search="([^"]*)"><div class="archetype-card-head"><h4>([^<]*)<\/h4><span class="family-tag">([^<]*)<\/span><\/div><p class="intent">([^<]*)<\/p><div><span class="mini-label">Spine<\/span><p class="spine-line">([^<]*)<\/p><\/div><div><span class="mini-label">Sections<\/span><p class="section-line">([^<]*)<\/p><\/div><div class="card-bottom"><div><span class="mini-label">Primary CTA<\/span><span class="primary-cta">([^<]*)<\/span><\/div><div><span class="mini-label">Closest transfers<\/span><p class="reuse-copy">([^<]*)<\/p><\/div><\/div><\/article>/g;

function parseArchetypes(html: string): Archetype[] {
  return [...html.matchAll(ARCHETYPE_CARD_RE)].map((m) => ({
    id: clean(m[4]!),
    spine: clean(m[1]!),
    name: clean(m[3]!),
    intent: clean(m[5]!),
    steps: splitList(m[6]!, ' → '),
    // The sections paragraph ends in a period the atlas never lists as its own section.
    sections: splitList(clean(m[7]!).replace(/\.$/, ''), ', '),
    primaryCta: clean(m[8]!),
    closestTransfers: splitList(m[9]!, ' · '),
    // The atlas's own search terms (data-search), whitespace-separated.
    keywords: clean(m[2]!).split(/\s+/).filter(Boolean),
  }));
}

function parseMatrix(html: string): Record<string, Record<string, number>> {
  const table = html.match(/<table class="matrix"[^>]*>([\s\S]*?)<\/table>/);
  if (!table) throw new Error('shape atlas: no compatibility matrix table found');
  const head = table[1]!.match(/<thead>([\s\S]*?)<\/thead>/);
  if (!head) throw new Error('shape atlas: matrix has no <thead>');
  // The corner cell (`<th class="corner">...`) carries an attribute, so it never matches this
  // bare `<th>` pattern; only the plain per-spine header cells do.
  const headerCodes = [...head[1]!.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => clean(m[1]!));
  if (headerCodes.length === 0) throw new Error('shape atlas: matrix header has no spine columns');

  const matrix: Record<string, Record<string, number>> = {};
  for (const rowMatch of table[1]!.matchAll(/<tr data-row="([^"]*)">([\s\S]*?)<\/tr>/g)) {
    const rowCode = clean(rowMatch[1]!);
    const scores = [...rowMatch[2]!.matchAll(/data-score="(\d+)"/g)].map((m) => Number(m[1]));
    if (scores.length !== headerCodes.length) {
      throw new Error(`shape atlas: matrix row ${rowCode} has ${scores.length} score(s), expected ${headerCodes.length}`);
    }
    const row: Record<string, number> = {};
    headerCodes.forEach((code, index) => {
      row[code] = scores[index]!;
    });
    matrix[rowCode] = row;
  }
  return matrix;
}

function parseSkins(html: string): string[] {
  const panel = html.match(/<article class="index-panel paper"><h3>Visual skins<\/h3>[\s\S]*?<div class="skin-strip">([\s\S]*?)<\/div>/);
  if (!panel) throw new Error('shape atlas: no visual skins panel found');
  return [...panel[1]!.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => clean(m[1]!));
}

function parseFormats(html: string): Format[] {
  const panel = html.match(/<article class="index-panel paper"><h3>Cross-cutting formats<\/h3>[\s\S]*?<div class="index-list">([\s\S]*?)<\/div><\/article>/);
  if (!panel) throw new Error('shape atlas: no cross-cutting formats panel found');
  return [...panel[1]!.matchAll(/<div class="index-item"><b>([^<]*)<\/b><span>([^<]*)<\/span><\/div>/g)].map((m) => ({ name: clean(m[1]!), summary: clean(m[2]!) }));
}

function parseTransferNotes(html: string): Record<string, TransferNote> {
  const block = html.match(/var familyDetails = \{([\s\S]*?)\};/);
  if (!block) throw new Error('shape atlas: no familyDetails script object found');
  const notes: Record<string, TransferNote> = {};
  // `\s*\]` (not `"\]`) on purpose: the real page's MI entry has a trailing space before its
  // closing bracket, and a strict match would silently drop that one spine's transfer note.
  const entryRe = /(\w+):\s*\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\]/g;
  for (const m of block[1]!.matchAll(entryRe)) {
    notes[m[1]!] = { headline: clean(m[2]!), transfer: clean(m[3]!) };
  }
  return notes;
}

function parseVersion(html: string): string {
  const m = html.match(/class="sheet-meta"><span>Composition ledger<\/span><span>v([\d.]+)<\/span>/);
  if (!m) throw new Error('shape atlas: no composition ledger version badge found');
  return m[1]!;
}

export function parseAtlasHtml(html: string, meta: { source: string; fetched: string }): ShapeAtlas {
  const atlas: ShapeAtlas = {
    source: meta.source,
    version: parseVersion(html),
    fetched: meta.fetched,
    spines: parseSpines(html),
    archetypes: parseArchetypes(html),
    compatibility: parseMatrix(html),
    transferNotes: parseTransferNotes(html),
    skins: parseSkins(html),
    formats: parseFormats(html),
  };
  validateShapeAtlas(atlas);
  return atlas;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const source = args[0];
  if (!source) {
    console.error('usage: import-shape-atlas.ts <file-or-https-url> [--out src/atlas/shape-atlas.json]');
    process.exitCode = 1;
    return;
  }
  let out = 'src/atlas/shape-atlas.json';
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--out' && args[i + 1]) {
      out = args[i + 1]!;
      i += 1;
    }
  }
  const isUrl = /^https?:\/\//.test(source);
  const html = isUrl ? await (await fetch(source)).text() : await readFile(source, 'utf8');
  const fetched = new Date().toISOString().slice(0, 10);
  const atlas = parseAtlasHtml(html, { source: isUrl ? source : CANONICAL_ATLAS_URL, fetched });
  await writeFile(out, `${JSON.stringify(atlas, null, 2)}\n`);
  console.log(`wrote ${out}: ${atlas.spines.length} spines, ${atlas.archetypes.length} archetypes, ${atlas.skins.length} skins, ${atlas.formats.length} formats, ${Object.keys(atlas.transferNotes).length} transfer notes`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
