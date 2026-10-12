/**
 * Profiles the 25 most-liked full-page prompt-catalog entries (nobody has built them yet) and
 * writes a design index plus a report — see
 * `docs/plans/2026-09-19-design-profile-index-design.md` section 7.
 *
 *   node --experimental-strip-types scripts/profile-catalog.ts                 # live run (Jev calls)
 *   node --experimental-strip-types scripts/profile-catalog.ts --from-profiles # rebuild only
 *   node --experimental-strip-types scripts/profile-catalog.ts --out <dir>     # write under <dir>
 *   node --experimental-strip-types scripts/profile-catalog.ts \
 *     --hydrate-previews-from-catalog <index.json> [--catalog-db <path>]       # previews only
 *
 * The default mode reads `~/projects/prompt-catalog/catalog.db` read-only
 * (`new DatabaseSync(path, { readOnly: true })`); never writes to that database or repo.
 * `original_text` (licence-restricted reference text) is read into memory as the profile input
 * only — never written to a file, never printed, never included in any output this script
 * produces. `--from-profiles` makes no Jev calls and touches no database: it reads the already-
 * written `profiles/<id>.json` files back and rebuilds `design-index.json` and `REPORT.md` from
 * them — for re-generating the report (new example queries, a new distribution breakdown, a new
 * column) without spending another $0.01 or re-reading the catalog.
 *
 * `--hydrate-previews-from-catalog <index.json>` is a third mode, and a narrow one: it makes no
 * Jev calls, opens the catalog read-only, and writes nothing into a profile but `meta`. It reads
 * three columns — `id`, `image_preview_url`, `video_preview_url` — and never `original_text` or
 * `our_text`, which is why it has its own SELECT rather than reusing the live run's. The profiles
 * directory is the sibling `profiles/` of the index file named on the command line, and both it
 * and the index file are rewritten in place, entry order untouched.
 *
 * Writes, by default under the agency workspace, never the product repo (`--out <dir>` moves all
 * three outputs under `<dir>` instead; `evals/genui/8-route-eval.mjs` uses it):
 *   work/genui-overnight-2026-09-18/route/catalog-25/design-index.json  (successful profiles)
 *   work/genui-overnight-2026-09-18/route/catalog-25/profiles/<id>.json (live mode only)
 *   work/genui-overnight-2026-09-18/route/catalog-25/REPORT.md
 *
 * On a Jev API error for one entry, that entry is retried up to twice (3 attempts total, with a
 * short backoff) before being recorded as a failure in REPORT.md; the run continues with the
 * remaining entries rather than aborting. A failure's recorded text is always `describeFailure`'s
 * output: the entry id, `error.message`, and the attempt count — never Jev's response body.
 * `ProfileError`'s own message is already redacted to `jev <status>` (see `profile.ts`), so a
 * Jev 4xx that echoes request content (which can include the licence-restricted `original_text`)
 * can never reach this script's console output or REPORT.md through that path.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAtlasData } from '../src/atlas.ts';
import { vaultSecret } from '../src/deepseek.ts';
import { addProfile, emptyDesignIndex, findProfiles, loadDesignIndex, saveDesignIndex, type FindQuery } from '../src/design-index.ts';
import { isPublicPreviewUrl } from '../src/preview-url.ts';
import { createJevProfiler, type DesignProfile } from '../src/profile.ts';
import { loadDesignTaxonomy, type DesignTaxonomy } from '../src/taxonomy.ts';

const CATALOG_DB = '~/projects/prompt-catalog/catalog.db';
const DEFAULT_OUT_DIR = '~/projects/Mishh-Agency-Restored-2026-09-16/workspace/work/genui-overnight-2026-09-18/route/catalog-25';
/** Where the live run and `--from-profiles` read and write; `--out <dir>` overrides it (set once
 * in `main`, before any mode runs). */
let outDir = DEFAULT_OUT_DIR;
const profilesDir = () => path.join(outDir, 'profiles');
const indexFile = () => path.join(outDir, 'design-index.json');
const reportFile = () => path.join(outDir, 'REPORT.md');

// The design doc's frozen selection, recorded 2026-09-19 — kept here only to verify the live
// query below still returns exactly this set; the run always profiles what the query returns,
// not this literal list, so the script stays correct if the catalog changes later.
const EXPECTED_SELECTION = [
  '3d-jack-portfolio-hero', 'aetheris-voyage-hero', 'prisma-landing', 'innovation-landing',
  'portfolio-cosmic-hero', 'dreamcore-landing', 'email-landing-page', 'urban-jungle-hero', '3d-story',
  'vortex-studio-hero', 'modern-agency', 'prompt-hero', 'mindloop-landing', 'art-landing', 'scroll-landing',
  'halo-usd-landing', 'pulse-3d', 'orbis-nft-landing', 'digital-experiences', 'neon-logic', 'bl',
  'luxury-real-estate', 'health-portal', 'mostar-guide', 'vision-reveal',
];

type CatalogRow = {
  id: string;
  title: string;
  category: string | null;
  vertical: string | null;
  use_case: string | null;
  niche: string | null;
  slot: string | null;
  action: string | null;
  motion_level: string | null;
  total_likes: number;
  likes_30d: number;
  source_url: string | null;
  original_chars: number | null;
  original_text: string | null;
};

type MediaRow = { kind: 'image' | 'video'; local_path: string | null };

/** The report/agreement-analysis fields, common to a fresh catalog row (live mode) and a
 * reconstruction from an already-written profile's `meta`/`source` (`--from-profiles` mode). */
export type ReportRow = { id: string; title: string; total_likes: number; action: string | null; motion_level: string | null; slot: string | null };

export type ReportEntry = { row: ReportRow; profile: DesignProfile };
export type FailedEntry = { id: string; message: string; attempts: number };

const MAX_ATTEMPTS = 3; // first try + two retries
const RETRY_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconstructs a `ReportRow` from a profile's own `source`/`meta` — everything `profile-catalog`
 * itself wrote there when the profile was first made — so `--from-profiles` never needs the
 * catalog database. */
export function rowFromProfile(profile: DesignProfile): ReportRow {
  const meta = profile.meta ?? {};
  return {
    id: profile.source.id ?? '(unknown)',
    title: profile.source.title ?? '',
    total_likes: typeof meta.total_likes === 'number' ? meta.total_likes : 0,
    action: typeof meta.catalog_action === 'string' ? meta.catalog_action : null,
    motion_level: typeof meta.motion_level === 'string' ? meta.motion_level : null,
    slot: typeof meta.slot === 'string' ? meta.slot : null,
  };
}

/** Always safe: `error.message` for a `ProfileError` is already redacted to `jev <status>` or a
 * `malformed answer <id>: <reason>` structural description — never Jev's response body (see
 * `profile.ts`'s header). Never logs or writes anything else about the error. */
export function describeFailure(id: string, error: unknown, attempts: number): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${id}: ${message} (after ${attempts} attempt(s))`;
}

/** Rough motion-level inference from a profile's own mechanics/components, so it can be compared
 * against the catalog's own `motion_level` column. This is a documented heuristic, not a claim
 * that either label is ground truth — see REPORT.md's caveat next to the agreement table. */
export function inferMotionLevel(profile: DesignProfile): string {
  if ((profile.components['3d-canvas-webgl'] ?? 0) >= 0.5) return 'webgl-3d';
  if ((profile.mechanics['static-only'] ?? 0) >= 0.5) return 'static';
  const activeIds = ['parallax', 'scroll-scrubbed', 'marquee-drift', 'velocity-linked', 'ambient-3d', 'looping-video', 'auto-cycle', 'horizontal-scroll'];
  const activeCount = Object.entries(profile.mechanics).filter(([id, p]) => id !== 'static-only' && id !== 'reduced-motion-branch' && p >= 0.5).length;
  const hasStrongActive = activeIds.some((id) => (profile.mechanics[id] ?? 0) >= 0.5);
  if (hasStrongActive || activeCount >= 3) return 'motion-led';
  if (activeCount >= 1) return 'micro';
  return 'static';
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

export function topLabels(record: Record<string, number>, threshold = 0.7): string {
  const ids = Object.entries(record)
    .filter(([, p]) => p >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return ids.length > 0 ? ids.join(', ') : '(none)';
}

export function qualityTotal(profile: DesignProfile): number {
  return Object.values(profile.quality).reduce((sum, dim) => sum + dim.score, 0);
}

export function previewFromMeta(profile: DesignProfile): string {
  const value = profile.meta?.preview;
  return typeof value === 'string' ? value : '(none)';
}

/** The second-highest-probability skin option (after the chosen one), so the report can show how
 * close the runner-up sat — useful given how often `skin` converges on one dominant choice for
 * this corpus (see the Distribution section). */
export function runnerUpSkin(skin: { choice: string; probabilities: Record<string, number> }): string {
  const runnerUp = Object.entries(skin.probabilities)
    .filter(([id]) => id !== skin.choice)
    .sort((a, b) => b[1] - a[1])[0];
  return runnerUp ? `${runnerUp[0]} (${fmt(runnerUp[1])})` : '(none)';
}

export function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyFn(item), (counts.get(keyFn(item)) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} (${count})`)
    .join(', ');
}

function previewPath(media: MediaRow[]): string {
  const image = media.find((m) => m.kind === 'image' && m.local_path);
  const video = media.find((m) => m.kind === 'video' && m.local_path);
  return image?.local_path ?? video?.local_path ?? '(none)';
}

/** Three queries picked to return real results on this corpus (a section+ground query, a
 * component+mechanic query, a topology+skin query), plus one honest zero-match example. The
 * query shapes are fixed data (chosen by inspecting the corpus once), but `zeroMatchNote` is
 * computed from the actual entries at report-generation time — never a hardcoded figure — so a
 * probability quoted in the note can never go stale against whichever profiles are on disk. */
const EXAMPLE_QUERIES: { label: string; query: FindQuery; zeroMatchNote?: (entries: ReportEntry[]) => string }[] = [
  { label: '--section hero --ground near-black', query: { sections: ['hero'], ground: 'near-black' } },
  { label: '--component video-background --mechanic looping-video', query: { components: ['video-background'], mechanics: ['looping-video'] } },
  { label: '--topology full-bleed-anchored-type --skin "Cinematic and immersive"', query: { topology: 'full-bleed-anchored-type', skin: 'Cinematic and immersive' } },
  {
    label: '--component marquee-ticker --mechanic velocity-linked',
    query: { components: ['marquee-ticker'], mechanics: ['velocity-linked'] },
    zeroMatchNote: (entries) => {
      const maxVelocity = Math.max(0, ...entries.map((e) => e.profile.mechanics['velocity-linked'] ?? 0));
      const strongDriftCount = entries.filter((e) => (e.profile.mechanics['marquee-drift'] ?? 0) >= 0.9).length;
      return `Zero matches, and correctly so: this corpus's marquee mechanics register as \`marquee-drift\` (${strongDriftCount} entries at p >= 0.9), never as \`velocity-linked\` (the highest any entry reaches is p = ${fmt(maxVelocity)}). The two mechanics describe different things (a continuous sideways drift vs. scroll-speed-linked motion) and this corpus's marquees are the former.`;
    },
  },
];

// ---------------------------------------------------------------------------
// Shared report/index writer — used by both the live run and --from-profiles
// ---------------------------------------------------------------------------

async function writeIndexAndReport(entries: ReportEntry[], failed: FailedEntry[], totalSelected: number, taxonomy: DesignTaxonomy, selectionMatchesDoc: boolean | undefined): Promise<void> {
  let index = emptyDesignIndex();
  for (const { profile } of entries) index = addProfile(index, profile);
  await saveDesignIndex(indexFile(), index);

  // --- agreement with the catalog's own labels ---------------------------------------------
  let actionAgree = 0;
  let motionAgree = 0;
  let formatAgree = 0; // slot === 'full-page', which every selected row is by construction
  const disagreements: string[] = [];
  for (const { row, profile } of entries) {
    const routeAction = profile.route.action.choice;
    if (row.action && row.action === routeAction) actionAgree += 1;
    else disagreements.push(`${row.id}: action catalog=${row.action ?? '(none)'} vs route.action=${routeAction}`);

    const inferred = inferMotionLevel(profile);
    if (row.motion_level && row.motion_level === inferred) motionAgree += 1;
    else disagreements.push(`${row.id}: motion_level catalog=${row.motion_level ?? '(none)'} vs inferred=${inferred}`);

    if (row.slot === 'full-page') formatAgree += 1;
  }

  // --- distribution ----------------------------------------------------------------------
  const spineCounts = countBy(entries, (e) => e.profile.route.spine.choice);
  const archetypeCounts = countBy(entries, (e) => e.profile.route.archetype?.choice ?? '(none)');
  const skinCounts = countBy(entries, (e) => e.profile.route.skin.choice);
  const formatCountsBy = countBy(entries, (e) => e.profile.route.format.choice);
  const topologyCounts = countBy(entries, (e) => e.profile.style.topology.choice);
  const groundCounts = countBy(entries, (e) => e.profile.style.ground.choice);
  const familyCounts = countBy(entries, (e) => e.profile.route.resolved.familyId ?? '(unrouted)');

  const dominantSkin = [...skinCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantSkinConfidences = dominantSkin
    ? entries.filter((e) => e.profile.route.skin.choice === dominantSkin[0]).map((e) => e.profile.route.skin.confidence)
    : [];
  const dominantSkinMeanConfidence = dominantSkinConfidences.length > 0 ? dominantSkinConfidences.reduce((a, b) => a + b, 0) / dominantSkinConfidences.length : 0;
  const skinCoarsenessSentence = dominantSkin
    ? `Skin is coarse for this corpus: ${dominantSkin[1]}/${entries.length} entries land on "${dominantSkin[0]}" at mean confidence ${fmt(dominantSkinMeanConfidence)}, so style search on this index should lean on topology, ground, typography, imagery and depth rather than skin.`
    : '';

  // --- example find queries -----------------------------------------------------------------
  const exampleResults = EXAMPLE_QUERIES.map(({ label, query, zeroMatchNote }) => ({
    label,
    zeroMatchNote: zeroMatchNote?.(entries),
    results: findProfiles(index.profiles, query, taxonomy).map((p) => `${p.source.id} (${p.source.title ?? ''})`),
  }));

  // --- cost and latency (recorded on each profile at the time it was made) -----------------
  const totalInputTokens = entries.reduce((sum, e) => sum + (e.profile.usage?.input_tokens ?? 0), 0);
  const totalMs = entries.reduce((sum, e) => sum + e.profile.ms, 0);

  // --- REPORT.md -----------------------------------------------------------------------------
  const lines: string[] = [];
  lines.push('# Design profile and index — catalog-25 run');
  lines.push('');
  lines.push(`Run at ${new Date().toISOString()}. ${entries.length}/${totalSelected} entries profiled successfully, ${failed.length} failed.`);
  lines.push('');
  if (selectionMatchesDoc !== undefined) {
    lines.push(`Selection matches the design doc's frozen 2026-09-19 list of 25 ids: **${selectionMatchesDoc}**.`);
  } else {
    lines.push("Rebuilt from `profiles/*.json` (`--from-profiles`): no new Jev calls, no catalog database read.");
  }
  lines.push('');
  lines.push('## Profiles');
  lines.push('');
  lines.push('| id | title | likes | spine | archetype | skin | runner-up skin (p) | format | action | family (basis, transfer) | sections p>=0.7 | components p>=0.7 | mechanics p>=0.7 | topology | ground | quality /28 | truth-risk | preview |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { row, profile } of entries) {
    const familyCell = profile.route.resolved.familyId
      ? `${profile.route.resolved.familyId} (${profile.route.resolved.basis}, ${profile.route.resolved.transfer})`
      : '(unrouted)';
    lines.push(
      `| ${row.id} | ${row.title} | ${row.total_likes} | ${profile.route.spine.choice} | ${profile.route.archetype?.choice ?? '-'} | ${profile.route.skin.choice} | ${runnerUpSkin(profile.route.skin)} | ${profile.route.format.choice} | ${profile.route.action.choice} | ${familyCell} | ${topLabels(profile.sections)} | ${topLabels(profile.components)} | ${topLabels(profile.mechanics)} | ${profile.style.topology.choice} | ${profile.style.ground.choice} | ${fmt(qualityTotal(profile), 1)} | ${fmt(profile.truthRisk)} | ${previewFromMeta(profile)} |`,
    );
  }
  lines.push('');
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failed) lines.push(`- ${failure.id}: ${failure.message} (after ${failure.attempts} attempt(s))`);
    lines.push('');
  }
  lines.push('## Distribution');
  lines.push('');
  lines.push(`Spine: ${formatCounts(spineCounts)}.`);
  lines.push(`Archetype: ${formatCounts(archetypeCounts)}.`);
  lines.push(`Skin: ${formatCounts(skinCounts)}.`);
  lines.push(`Format: ${formatCounts(formatCountsBy)}.`);
  lines.push(`Topology: ${formatCounts(topologyCounts)}.`);
  lines.push(`Ground: ${formatCounts(groundCounts)}.`);
  lines.push(`Routed family: ${formatCounts(familyCounts)}.`);
  lines.push('');
  lines.push(skinCoarsenessSentence);
  lines.push('');
  lines.push("## Agreement with the catalog's own labels");
  lines.push('');
  lines.push(`Action (catalog \`action\` vs \`route.action\`): ${actionAgree}/${entries.length} agree.`);
  lines.push(`Motion level (catalog \`motion_level\` vs a mechanics/components-derived inference — a heuristic, not a second ground truth): ${motionAgree}/${entries.length} agree.`);
  lines.push(`Slot/format (catalog \`slot = full-page\` vs any atlas format, all of which are full-page formats): ${formatAgree}/${entries.length} agree (trivial for this selection — see caveat below).`);
  lines.push('');
  lines.push('Every disagreement:');
  lines.push('');
  for (const line of disagreements) lines.push(`- ${line}`);
  lines.push('');
  lines.push(
    "Caveat: every one of the 25 selected rows already has `slot = 'full-page'` (the selection query filters `kind = 'page'`), and every one of the atlas's 8 cross-cutting formats is itself a full-page-level format, so the format/slot agreement check above cannot fail for this particular selection — it would only discriminate on a mixed selection that also included component/hero/pricing-slot rows.",
  );
  lines.push('');
  lines.push('## Example find queries');
  lines.push('');
  for (const { label, results, zeroMatchNote } of exampleResults) {
    lines.push(`\`design-index find ${label}\``);
    lines.push('');
    lines.push(results.length > 0 ? results.map((r) => `- ${r}`).join('\n') : '- 0 matches');
    if (zeroMatchNote) {
      lines.push('');
      lines.push(zeroMatchNote);
    }
    lines.push('');
  }
  lines.push('## Cost and latency');
  lines.push('');
  lines.push(`Total input tokens across ${entries.length} successful profiles: ${totalInputTokens}.`);
  lines.push(`Average ms per profile: ${entries.length > 0 ? Math.round(totalMs / entries.length) : 0}.`);
  lines.push('');

  await writeFile(reportFile(), `${lines.join('\n')}\n`);
  console.log(`wrote ${indexFile()}`);
  console.log(`wrote ${reportFile()}`);
  console.log(`${entries.length}/${totalSelected} succeeded, ${failed.length} failed`);
}

// ---------------------------------------------------------------------------
// Live mode: catalog DB read + real Jev calls
// ---------------------------------------------------------------------------

async function runLive(catalogDb: string): Promise<void> {
  await mkdir(profilesDir(), { recursive: true });

  const db = new DatabaseSync(catalogDb, { readOnly: true });
  let rows: CatalogRow[];
  let selectionMatchesDoc: boolean;
  const mediaByPrompt = new Map<string, MediaRow[]>();
  try {
    rows = db
      .prepare(
        `SELECT id, title, category, vertical, use_case, niche, slot, action, motion_level,
                total_likes, likes_30d, source_url, original_chars, original_text
         FROM prompts
         WHERE kind = 'page' AND id NOT IN ('neo-museum', 'oyla')
         ORDER BY total_likes DESC, likes_30d DESC
         LIMIT 25`,
      )
      .all() as unknown as CatalogRow[];
    selectionMatchesDoc = rows.length === EXPECTED_SELECTION.length && rows.every((row, index) => row.id === EXPECTED_SELECTION[index]);

    const mediaStmt = db.prepare(`SELECT prompt_id, kind, local_path FROM media WHERE prompt_id IN (${rows.map(() => '?').join(',')})`);
    const mediaRows = (rows.length > 0 ? mediaStmt.all(...rows.map((r) => r.id)) : []) as unknown as { prompt_id: string; kind: 'image' | 'video'; local_path: string | null }[];
    for (const media of mediaRows) {
      const list = mediaByPrompt.get(media.prompt_id) ?? [];
      list.push({ kind: media.kind, local_path: media.local_path });
      mediaByPrompt.set(media.prompt_id, list);
    }
  } finally {
    db.close();
  }

  console.log(`selection: ${rows.length} entries; matches the design doc's frozen 2026-09-19 list: ${selectionMatchesDoc}`);
  if (!selectionMatchesDoc) console.log('  live query ids:', rows.map((r) => r.id).join(', '));

  const { atlas, registry } = await loadAtlasData();
  const taxonomy = await loadDesignTaxonomy();
  const profiler = createJevProfiler({ apiKey: () => vaultSecret('typesafe_api_key') });

  const entries: ReportEntry[] = [];
  const failed: FailedEntry[] = [];

  for (const row of rows) {
    if (!row.original_text) {
      failed.push({ id: row.id, message: 'no original_text in catalog', attempts: 0 });
      continue;
    }
    const media = mediaByPrompt.get(row.id) ?? [];
    const meta: Record<string, string | number | boolean> = {
      total_likes: row.total_likes,
      likes_30d: row.likes_30d,
      ...(row.category ? { category: row.category } : {}),
      ...(row.vertical ? { vertical: row.vertical } : {}),
      ...(row.use_case ? { use_case: row.use_case } : {}),
      ...(row.niche ? { niche: row.niche } : {}),
      ...(row.slot ? { slot: row.slot } : {}),
      ...(row.action ? { catalog_action: row.action } : {}),
      ...(row.motion_level ? { motion_level: row.motion_level } : {}),
      ...(row.original_chars ? { original_chars: row.original_chars } : {}),
      preview: previewPath(media),
    };

    let lastError: unknown;
    let attempts = 0;
    let profile: DesignProfile | undefined;
    while (attempts < MAX_ATTEMPTS && !profile) {
      attempts += 1;
      try {
        profile = await profiler.profile({
          text: row.original_text,
          atlas,
          registry,
          taxonomy,
          source: { kind: 'prompt', id: row.id, title: row.title, ref: row.source_url ?? undefined },
          meta,
        });
      } catch (error) {
        lastError = error;
        // `describeFailure` never carries Jev's response body — see its own docblock.
        console.log(`  ${describeFailure(row.id, error, attempts)}`);
        if (attempts < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }

    if (!profile) {
      failed.push({ id: row.id, message: lastError instanceof Error ? lastError.message : String(lastError), attempts });
      continue;
    }

    entries.push({ row: { id: row.id, title: row.title, total_likes: row.total_likes, action: row.action, motion_level: row.motion_level, slot: row.slot }, profile });
    await writeFile(path.join(profilesDir(), `${row.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
    console.log(`  ${row.id}: profiled in ${profile.ms} ms (attempt ${attempts}) — spine ${profile.route.spine.choice}, family ${profile.route.resolved.familyId ?? '(unrouted)'}`);
  }

  await writeIndexAndReport(entries, failed, rows.length, taxonomy, selectionMatchesDoc);
}

// ---------------------------------------------------------------------------
// --from-profiles mode: rebuild the index/report from profiles/*.json, no Jev calls
// ---------------------------------------------------------------------------

async function runFromProfiles(): Promise<void> {
  const taxonomy = await loadDesignTaxonomy();
  const files = (await readdir(profilesDir())).filter((f) => f.endsWith('.json')).sort();
  const entries: ReportEntry[] = [];
  const failed: FailedEntry[] = [];
  for (const file of files) {
    try {
      const profile = JSON.parse(await readFile(path.join(profilesDir(), file), 'utf8')) as DesignProfile;
      entries.push({ row: rowFromProfile(profile), profile });
    } catch (error) {
      failed.push({ id: file, message: error instanceof Error ? error.message : String(error), attempts: 0 });
    }
  }
  console.log(`--from-profiles: read ${entries.length} profile(s) from ${profilesDir()}, ${failed.length} unreadable`);
  await writeIndexAndReport(entries, failed, entries.length + failed.length, taxonomy, undefined);
}

// ---------------------------------------------------------------------------
// --hydrate-previews-from-catalog mode: meta preview URLs only, no Jev calls
// ---------------------------------------------------------------------------

/** The only three columns this mode reads. `original_text` and `our_text` are not among them and
 * never are: the licence-restricted text has no business in a preview hydration. */
export type CatalogPreviewRow = { id: string; image_preview_url: string | null; video_preview_url: string | null };

export type PreviewHydrationCounts = {
  profiles: number;
  previewImage: number;
  previewVideo: number;
  neither: number;
  /**
   * Catalog preview values that were present but are not public preview URLs (an `http:` link, a
   * relative path, an over-long blob). Counted per value, not per profile, and cleared rather than
   * written — see `hydratePreviewMeta`.
   */
  rejected: number;
  /** Profiles whose `source.id` has no row in the catalog; left exactly as they were. */
  unmatched: string[];
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * A copy of `profile` whose `meta` carries the catalog's two preview URLs and the catalog row id,
 * and whose every other field is untouched. A profile with no catalog row comes back as it went
 * in — no `catalogId` is invented for a row that does not exist.
 *
 * The catalog owns all three keys, so an empty column clears a previously hydrated value rather
 * than leaving a stale URL behind, and all three are removed before being written so they land in
 * the same order every time: a second run produces a byte-identical file. Every other `meta` key
 * the profile already carried is kept where it was.
 *
 * A value that is not a public preview URL is treated exactly as an empty column: the daemon's
 * `POST /api/design-index` parser refuses one, and a hydrated file never goes through that parser,
 * so writing it here would be the way around the rule. `isPublicPreviewUrl` is that one rule.
 */
export function hydratePreviewMeta(profile: DesignProfile, row: CatalogPreviewRow | undefined): DesignProfile {
  if (!row) return profile;
  const meta: Record<string, string | number | boolean> = { ...(profile.meta ?? {}) };
  delete meta.previewImage;
  delete meta.previewVideo;
  delete meta.catalogId;
  if (isPublicPreviewUrl(row.image_preview_url)) meta.previewImage = row.image_preview_url;
  if (isPublicPreviewUrl(row.video_preview_url)) meta.previewVideo = row.video_preview_url;
  meta.catalogId = row.id;
  return { ...profile, meta };
}

/**
 * How many of a row's two preview columns carried something that is not a public preview URL —
 * the values `hydratePreviewMeta` clears instead of writing, reported in the summary line so a
 * run that silently dropped a URL is visible rather than merely correct.
 */
function rejectedPreviewValues(row: CatalogPreviewRow | undefined): number {
  if (!row) return 0;
  return [row.image_preview_url, row.video_preview_url].filter(
    (value) => nonEmptyString(value) !== undefined && !isPublicPreviewUrl(value),
  ).length;
}

/**
 * The exact projection the hydration SELECT names, pinned as a constant so a test can read it.
 * `original_text` and `our_text` are not in it and never are: the licence-restricted text has no
 * business in a preview hydration, and a `SELECT *` that merely discarded it afterwards would
 * still have read it.
 */
export const CATALOG_PREVIEW_PROJECTION = 'id, image_preview_url, video_preview_url';

/** Opens the catalog read-only for one SELECT of three columns, then closes it. */
function readPreviewRows(catalogDb: string, ids: readonly string[]): Map<string, CatalogPreviewRow> {
  const byId = new Map<string, CatalogPreviewRow>();
  if (ids.length === 0) return byId;
  const db = new DatabaseSync(catalogDb, { readOnly: true });
  try {
    const rows = db
      .prepare(`SELECT ${CATALOG_PREVIEW_PROJECTION} FROM prompts WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as unknown as CatalogPreviewRow[];
    for (const row of rows) byId.set(row.id, row);
  } finally {
    db.close();
  }
  return byId;
}

/**
 * Writes the catalog's preview URLs into `indexFile` and into each `profiles/<id>.json` beside it.
 * Entry order in the index is the order it already had — the file is rewritten, not rebuilt — so
 * a `git diff` of either output shows `meta` lines and nothing else.
 */
export async function hydratePreviewsFromCatalog(indexFile: string, catalogDb: string): Promise<PreviewHydrationCounts> {
  const profilesDir = path.join(path.dirname(indexFile), 'profiles');
  const index = await loadDesignIndex(indexFile);
  const ids = [...new Set(index.profiles.map((profile) => profile.source.id).filter((id): id is string => nonEmptyString(id) !== undefined))];
  const rows = readPreviewRows(catalogDb, ids);

  const hydrated = index.profiles.map((profile) => hydratePreviewMeta(profile, profile.source.id ? rows.get(profile.source.id) : undefined));
  await saveDesignIndex(indexFile, { ...index, profiles: hydrated });

  // The per-profile files are hydrated from their own content rather than from the index, so a
  // file that has drifted from the index keeps everything but `meta` it had on disk.
  const files = (await readdir(profilesDir)).filter((file) => file.endsWith('.json')).sort();
  for (const file of files) {
    const filePath = path.join(profilesDir, file);
    const profile = JSON.parse(await readFile(filePath, 'utf8')) as DesignProfile;
    const next = hydratePreviewMeta(profile, profile.source.id ? rows.get(profile.source.id) : undefined);
    if (next !== profile) await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }

  const counts: PreviewHydrationCounts = {
    profiles: hydrated.length,
    previewImage: hydrated.filter((profile) => typeof profile.meta?.previewImage === 'string').length,
    previewVideo: hydrated.filter((profile) => typeof profile.meta?.previewVideo === 'string').length,
    neither: hydrated.filter((profile) => profile.meta?.previewImage === undefined && profile.meta?.previewVideo === undefined).length,
    rejected: index.profiles.reduce((total, profile) => total + rejectedPreviewValues(profile.source.id ? rows.get(profile.source.id) : undefined), 0),
    unmatched: ids.filter((id) => !rows.has(id)),
  };
  console.log(`hydrated ${counts.profiles} profile(s) in ${indexFile} and ${files.length} file(s) in ${profilesDir}`);
  console.log(`  previewImage: ${counts.previewImage}; previewVideo: ${counts.previewVideo}; neither: ${counts.neither}; rejected: ${counts.rejected}`);
  if (counts.unmatched.length > 0) console.log(`  no catalog row: ${counts.unmatched.join(', ')}`);
  return counts;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const catalogDb = flagValue(argv, '--catalog-db') ?? CATALOG_DB;
  if (argv.includes('--out')) {
    const out = flagValue(argv, '--out');
    if (!out) throw new Error('--out needs a directory');
    outDir = path.resolve(out);
  }

  if (argv.includes('--hydrate-previews-from-catalog')) {
    const indexFile = flagValue(argv, '--hydrate-previews-from-catalog');
    if (!indexFile) throw new Error('--hydrate-previews-from-catalog needs the path of a design-index.json');
    await hydratePreviewsFromCatalog(path.resolve(indexFile), catalogDb);
    return;
  }
  if (argv.includes('--from-profiles')) {
    await runFromProfiles();
    return;
  }
  await runLive(catalogDb);
}

// Only runs when this file is the process's actual entry point (`node .../profile-catalog.ts`),
// never when another module imports it — `tests/profile-catalog.test.ts` imports this file for
// its pure exported helpers, and must not trigger a live run (real Jev calls, a real catalog DB
// read) merely by importing it. Same pattern as `scripts/import-shape-atlas.ts`.
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
