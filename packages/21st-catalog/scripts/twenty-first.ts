/**
 * Builds `generated/21st-items.json` from the private 21st.dev source kit's `manifest.json`
 * (Devin's hand-picked bookmarks from https://21st.dev/@example — PRD Addendum 3 / G13).
 *
 *   node --experimental-strip-types scripts/twenty-first.ts          write generated/21st-items.json
 *   node --experimental-strip-types scripts/twenty-first.ts --check  write nothing; exit 1 on drift
 *
 * Metadata only: name, author, the item's own 21st.dev URL, licence status and, for the two mit
 * rows, the full upstream MIT notice (copyright line + permission text), a "MIT © <holder>" label
 * and the upstream LICENSE's own URL (which also serves as the link to the upstream source repo)
 * — what MIT requires when the code is reused, not the kit's internal research note (that stays in
 * the kit; nothing in this file quotes it). No source file from the kit's `registry/` is read or
 * copied — the kit is read-only input here, never a dependency of anything this repo builds or
 * ships. A row's `rights` is `mit` only when the kit's `licence` field says `MIT` (an explicit
 * grant with evidence); every other row, including one merely tagged `mit` by 21st.dev's own
 * `site_license` field (a self-reported category, not a grant), stays `reference-only`.
 * `copyable` mirrors `rights` and is informational only: it is NOT a switch that grants a copy or
 * upstream install action. Independently authored alternatives have a separate source/demo
 * bundle in generated/21st-originals.json and their own actions — see `apps/daemon/src/routes/twenty1st.ts` and
 * `apps/web/src/components/Twenty1stPanel.tsx`. Round 2 of the G13 audit (Sol, DO NOT LAND)
 * withheld even the mit rows' install command: Mishh shows the notice and a "Copy licence notice"
 * action, and links out to 21st.dev and the upstream repo, but never offers to copy or install
 * 21st.dev source itself, mit or not. `issues()` asserts no generated row carries an `api_key=`
 * value anywhere, in any field, so that decision cannot regress silently.
 *
 * The kit path is TWENTYFIRST_KIT_DIR (default ~/projects/mm-source-kits/21st-source-kit). `--check`
 * always validates the committed file's shape. It compares against the kit's manifest.json only
 * when the kit exists: a MISSING kit (CI has none) skips the comparison and says so; a kit
 * directory that EXISTS but whose manifest.json cannot be read or parsed is a hard failure (exit
 * 1) — a present, broken manifest is never silently treated as "no kit".
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(pkgDir, 'generated', '21st-items.json');
const kitDir = process.env.TWENTYFIRST_KIT_DIR ?? join(homedir(), 'projects', 'mm-source-kits', '21st-source-kit');
const manifestPath = join(kitDir, 'manifest.json');

export const TWENTY_FIRST_SCHEMA = '21st-catalog/1';

export interface TwentyFirstRow {
  id: string;
  slug: string;
  name: string;
  author: string;
  authorProfileUrl: string;
  itemUrl: string;
  rights: 'mit' | 'reference-only';
  /** "MIT © <holder>", set only for `rights === 'mit'`. */
  licenseLabel: string | null;
  /** The upstream LICENSE's own URL (also the link to the upstream source repo), set only for
   * `rights === 'mit'`. */
  licenseUrl: string | null;
  /** The full MIT notice (copyright line + permission text), set only for `rights === 'mit'`. */
  licenseNotice: string | null;
  /** Informational upstream rights only; original alternatives have a separate source bundle. */
  copyable: boolean;
}

export interface TwentyFirstCatalog {
  schema: typeof TWENTY_FIRST_SCHEMA;
  source: { profile: string; itemCount: number };
  rows: TwentyFirstRow[];
}

interface ManifestItem {
  name: string;
  author: string;
  profile_url: string;
  item_url: string;
  licence: string;
}
interface Manifest {
  profile: string;
  item_count: number;
  items: ManifestItem[];
}

/**
 * The upstream MIT licence text for each mit row's author, keyed by the manifest `author` field.
 * Fetched once (2026-09-28) from the GitHub LICENSE.md the kit's `licence_evidence` cites for
 * moumensoliman (https://github.com/moumen-soliman/uitripled/blob/master/LICENSE.md, raw:
 * https://raw.githubusercontent.com/moumen-soliman/uitripled/master/LICENSE.md) — the kit itself
 * carries no LICENSE file for a bookmarked item, only the citing URL. Pinned here, not fetched at
 * build time, so `twenty-first.ts` never makes a network call.
 */
const UPSTREAM_LICENSES: Readonly<Record<string, { holder: string; year: string; url: string; text: string }>> = {
  moumensoliman: {
    holder: 'uitripled',
    year: '2026',
    url: 'https://github.com/moumen-soliman/uitripled/blob/master/LICENSE.md',
    text: [
      'MIT License',
      '',
      'Copyright (c) 2026 uitripled',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this '
        + 'software and associated documentation files (the "Software"), to deal in the Software '
        + 'without restriction, including without limitation the rights to use, copy, modify, merge, '
        + 'publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons '
        + 'to whom the Software is furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all copies or '
        + 'substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, '
        + 'INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR '
        + 'PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE '
        + 'FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR '
        + 'OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER '
        + 'DEALINGS IN THE SOFTWARE.',
    ].join('\n'),
  },
};

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `author-name`, slugified — unique across the kit even when two authors both call an item "Card". */
function rowSlug(item: ManifestItem): string {
  return `${slugify(item.author)}-${slugify(item.name)}`;
}

function buildRow(item: ManifestItem): TwentyFirstRow {
  const rights: TwentyFirstRow['rights'] = item.licence === 'MIT' ? 'mit' : 'reference-only';
  const licence = rights === 'mit' ? UPSTREAM_LICENSES[item.author] : undefined;
  if (rights === 'mit' && !licence) {
    throw new Error(`${item.author}/${item.name}: rights is mit but UPSTREAM_LICENSES has no pinned text for author "${item.author}"`);
  }
  const slug = rowSlug(item);
  return {
    id: `21st:${slug}`,
    slug,
    name: item.name,
    author: item.author,
    authorProfileUrl: item.profile_url,
    itemUrl: item.item_url,
    rights,
    licenseLabel: licence ? `MIT © ${licence.holder}` : null,
    licenseUrl: licence ? licence.url : null,
    licenseNotice: licence ? licence.text : null,
    copyable: rights === 'mit',
  };
}

function buildFromManifest(manifest: Manifest): TwentyFirstCatalog {
  const rows = manifest.items.map(buildRow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: TWENTY_FIRST_SCHEMA, source: { profile: manifest.profile, itemCount: rows.length }, rows };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every `api_key=` value found in a row's own string fields — case-insensitive, wherever it
 * appears. Round 2 dropped the only field that ever carried one (`externalInstallCommand`), so
 * this must find none; kept as a live assertion (not a comment) so a future field can never
 * reintroduce a key value unnoticed. */
function apiKeyValuesInRow(row: TwentyFirstRow): string[] {
  const found: string[] = [];
  for (const value of Object.values(row)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/api_key=([^&"'\s]*)/gi)) found.push(match[1] ?? '');
  }
  return found;
}

function issues(catalog: TwentyFirstCatalog): string[] {
  const out: string[] = [];
  if (catalog.schema !== TWENTY_FIRST_SCHEMA) out.push(`schema must be ${TWENTY_FIRST_SCHEMA}`);
  const seen = new Set<string>();
  for (const row of catalog.rows) {
    if (seen.has(row.id)) out.push(`duplicate id ${row.id}`);
    seen.add(row.id);
    if (!row.id.startsWith('21st:')) out.push(`${row.id}: id must start with 21st:`);
    if (row.rights !== 'mit' && row.rights !== 'reference-only') out.push(`${row.id}: bad rights ${row.rights}`);
    if (row.copyable !== (row.rights === 'mit')) out.push(`${row.id}: copyable must equal (rights === 'mit')`);
    const mitFields = [row.licenseLabel, row.licenseUrl, row.licenseNotice];
    if (row.rights === 'mit' && mitFields.some((f) => !f)) out.push(`${row.id}: mit row needs licenseLabel, licenseUrl and licenseNotice`);
    if (row.rights === 'reference-only' && mitFields.some((f) => f !== null)) out.push(`${row.id}: reference-only row must not carry licence fields`);
    if (row.rights === 'mit' && row.licenseNotice && !/^MIT License\b/.test(row.licenseNotice)) out.push(`${row.id}: licenseNotice must be the full upstream MIT text`);
    if ('externalInstallCommand' in row) out.push(`${row.id}: rows must not carry an install command (round 2, withheld)`);
    for (const value of apiKeyValuesInRow(row)) out.push(`${row.id}: carries an api_key value ("${value}") — no row may embed one`);
  }
  return out;
}

function fail(title: string, lines: readonly string[]): never {
  console.error(`${title} (${lines.length})`);
  for (const line of lines.slice(0, 50)) console.error(`  - ${line}`);
  process.exit(1);
}

function runBuild(): void {
  if (!existsSync(manifestPath)) fail('Source kit missing', [manifestPath]);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const catalog = buildFromManifest(manifest);
  const problems = issues(catalog);
  if (problems.length > 0) fail('Generated 21st catalog is invalid', problems);
  const text = canonicalJson(catalog);
  if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== text) writeFileSync(outPath, text);
  console.log(`21st-items.json: ${catalog.rows.length} rows (mit ${catalog.rows.filter((r) => r.rights === 'mit').length}, reference-only ${catalog.rows.filter((r) => r.rights === 'reference-only').length})`);
}

function runCheck(): void {
  if (!existsSync(outPath)) fail('generated/21st-items.json is missing', [outPath]);
  const committed = JSON.parse(readFileSync(outPath, 'utf8')) as TwentyFirstCatalog;
  const problems = issues(committed);
  if (problems.length > 0) fail('generated/21st-items.json is invalid', problems);
  if (!existsSync(kitDir)) {
    console.log(`21st-items.json: shape OK, ${committed.rows.length} rows (kit not present at ${kitDir}; drift comparison skipped)`);
    return;
  }
  // The kit directory exists, so a broken manifest is a real failure, not "no kit": CI has no kit
  // at all (existsSync(kitDir) is false there), so this branch never masks CI's normal path.
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (err) {
    fail(`Source kit at ${kitDir} exists but its manifest.json could not be read or parsed`, [err instanceof Error ? err.message : String(err)]);
  }
  const fresh = canonicalJson(buildFromManifest(manifest));
  const committedText = readFileSync(outPath, 'utf8');
  if (fresh !== committedText) fail('generated/21st-items.json is stale', ['run `pnpm --filter @open-design/21st-catalog run 21st` to refresh it']);
  console.log(`21st-items.json: matches the source kit (${committed.rows.length} rows)`);
}

if (process.argv.includes('--check')) runCheck();
else runBuild();
