/**
 * design-index CLI. A new file (not `cli.ts`) so this branch and the parent `feat/spine-router`
 * branch's own CLI edits merge cleanly. See `docs/plans/2026-09-19-design-profile-index-design.md`
 * section 6.
 *
 *   node --experimental-strip-types src/design-index-cli.ts profile <file> \
 *     [--kind prompt|brief|spec|html] [--id x] [--title t] [--out profile.json] \
 *     [--meta key=value ...]
 *   node --experimental-strip-types src/design-index-cli.ts profile --catalog-db <path> \
 *     --id <prompt-id> [--out ...]
 *   node --experimental-strip-types src/design-index-cli.ts add <profile.json ...> \
 *     [--index design-index.json]
 *   node --experimental-strip-types src/design-index-cli.ts find [--index f] \
 *     [--section s ...] [--component c ...] [--mechanic m ...] [--depth d ...] \
 *     [--skin k] [--spine S] [--archetype A] [--family f] [--format F] [--action a] \
 *     [--ground g] [--topology t] [--typography y] [--imagery i] \
 *     [--min 0.5] [--text substring] [--limit 25] [--json]
 *   node --experimental-strip-types src/design-index-cli.ts list [--index f] [--json]
 *
 * Exit codes: 0 success (including `find` with no matches, which prints "0 matches"); 1 usage or
 * runtime error. `profile` calls Jev and fails closed: a non-2xx response or a network failure
 * both throw, exactly like the ROUTE step in `cli.ts` — there is no advisory/skipped outcome
 * here. The TypeSafe key is read the same way as the rest of the package's Jev callers:
 * `zsvault get typesafe_api_key` into process memory at call time, never printed, never passed as
 * an argument or environment variable.
 *
 * `--catalog-db` opens the given SQLite file read-only (`new DatabaseSync(path, { readOnly: true
 * })`) and reads one prompt's `title`/`original_text` as the profile input; this CLI never writes
 * to that database and never prints or stores `original_text` beyond passing it in memory to the
 * profiler as the state `text`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { loadAtlasData } from './atlas.ts';
import { vaultSecret } from './deepseek.ts';
import { addProfile, findProfiles, loadDesignIndex, saveDesignIndex, type FindQuery } from './design-index.ts';
import { htmlFacts } from './html-facts.ts';
import { createJevProfiler, type DesignProfile, type ProfileSourceKind } from './profile.ts';
import { loadDesignTaxonomy } from './taxonomy.ts';

const DEFAULT_INDEX = 'design-index.json';
const SOURCE_KINDS: ProfileSourceKind[] = ['prompt', 'brief', 'spec', 'html'];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseMetaValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

function parseMetaArgs(pairs: string[]): Record<string, string | number | boolean> | undefined {
  if (pairs.length === 0) return undefined;
  const meta: Record<string, string | number | boolean> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) fail(`--meta expects key=value, received ${pair}`);
    meta[pair.slice(0, separator)] = parseMetaValue(pair.slice(separator + 1));
  }
  return meta;
}

async function runProfile(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      kind: { type: 'string', default: 'prompt' },
      id: { type: 'string' },
      title: { type: 'string' },
      out: { type: 'string' },
      meta: { type: 'string', multiple: true, default: [] },
      'catalog-db': { type: 'string' },
    },
  });

  const kind = values.kind as string;
  if (!SOURCE_KINDS.includes(kind as ProfileSourceKind)) fail(`--kind must be one of ${SOURCE_KINDS.join(', ')}`);

  let text: string;
  let facts: Record<string, unknown> | undefined;
  let sourceId = values.id;
  let sourceTitle = values.title;

  if (values['catalog-db']) {
    if (!values.id) fail('--catalog-db requires --id <prompt-id>');
    const db = new DatabaseSync(values['catalog-db'], { readOnly: true });
    try {
      const row = db.prepare('SELECT title, original_text FROM prompts WHERE id = ?').get(values.id) as
        | { title: string; original_text: string | null }
        | undefined;
      if (!row) fail(`no prompt with id ${values.id} in ${values['catalog-db']}`);
      if (!row.original_text) fail(`prompt ${values.id} has no original_text to profile`);
      text = row.original_text;
      sourceTitle = sourceTitle ?? row.title;
    } finally {
      db.close();
    }
  } else {
    const file = positionals[0] ?? fail('design-index profile <file> is required (or use --catalog-db --id)');
    const raw = await readFile(file, 'utf8');
    if (kind === 'html') {
      const extracted = htmlFacts(raw);
      facts = extracted;
      text = extracted.text;
    } else {
      text = raw;
    }
  }

  const { atlas, registry } = await loadAtlasData();
  const taxonomy = await loadDesignTaxonomy();
  const profiler = createJevProfiler({ apiKey: () => vaultSecret('typesafe_api_key') });
  const profile = await profiler.profile({
    text,
    facts,
    atlas,
    registry,
    taxonomy,
    source: { kind: kind as ProfileSourceKind, id: sourceId, title: sourceTitle },
    meta: parseMetaArgs(values.meta),
  });

  const json = `${JSON.stringify(profile, null, 2)}\n`;
  if (values.out) await writeFile(values.out, json);
  else process.stdout.write(json);
}

async function runAdd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { index: { type: 'string', default: DEFAULT_INDEX } },
  });
  if (positionals.length === 0) fail('design-index add <profile.json ...> is required');

  let index = await loadDesignIndex(values.index);
  for (const file of positionals) {
    const profile = JSON.parse(await readFile(file, 'utf8')) as DesignProfile;
    index = addProfile(index, profile);
  }
  await saveDesignIndex(values.index, index);
  console.log(`added ${positionals.length} profile(s); ${values.index} now has ${index.profiles.length} total`);
}

function parseNumberFlag(name: string, raw: string | undefined, check: (value: number) => boolean, message: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!check(value)) fail(`${name} ${message}`);
  return value;
}

async function runFind(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      index: { type: 'string', default: DEFAULT_INDEX },
      section: { type: 'string', multiple: true, default: [] },
      component: { type: 'string', multiple: true, default: [] },
      mechanic: { type: 'string', multiple: true, default: [] },
      depth: { type: 'string', multiple: true, default: [] },
      skin: { type: 'string' },
      spine: { type: 'string' },
      archetype: { type: 'string' },
      family: { type: 'string' },
      format: { type: 'string' },
      action: { type: 'string' },
      ground: { type: 'string' },
      topology: { type: 'string' },
      typography: { type: 'string' },
      imagery: { type: 'string' },
      min: { type: 'string' },
      text: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  const min = parseNumberFlag('--min', values.min, (value) => Number.isFinite(value) && value >= 0 && value <= 1, 'must be a number between 0 and 1');
  const limit = parseNumberFlag('--limit', values.limit, (value) => Number.isInteger(value) && value > 0, 'must be a positive integer');

  const taxonomy = await loadDesignTaxonomy();
  const index = await loadDesignIndex(values.index);

  const query: FindQuery = {
    ...(values.section.length > 0 ? { sections: values.section } : {}),
    ...(values.component.length > 0 ? { components: values.component } : {}),
    ...(values.mechanic.length > 0 ? { mechanics: values.mechanic } : {}),
    ...(values.depth.length > 0 ? { depths: values.depth } : {}),
    ...(values.skin !== undefined ? { skin: values.skin } : {}),
    ...(values.spine !== undefined ? { spine: values.spine } : {}),
    ...(values.archetype !== undefined ? { archetype: values.archetype } : {}),
    ...(values.family !== undefined ? { family: values.family } : {}),
    ...(values.format !== undefined ? { format: values.format } : {}),
    ...(values.action !== undefined ? { action: values.action } : {}),
    ...(values.ground !== undefined ? { ground: values.ground } : {}),
    ...(values.topology !== undefined ? { topology: values.topology } : {}),
    ...(values.typography !== undefined ? { typography: values.typography } : {}),
    ...(values.imagery !== undefined ? { imagery: values.imagery } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(values.text !== undefined ? { text: values.text } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };

  const results = findProfiles(index.profiles, query, taxonomy);

  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log('0 matches');
    return;
  }
  console.log(`${results.length} match(es)`);
  for (const profile of results) {
    const archetype = profile.route.archetype?.choice ?? profile.route.resolved.archetypeId ?? '-';
    console.log(
      `${profile.source.id ?? '(no id)'}\t${profile.source.title ?? ''}\t${profile.route.spine.choice}/${archetype}\tskin: ${profile.route.skin.choice}`,
    );
  }
}

async function runList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { index: { type: 'string', default: DEFAULT_INDEX }, json: { type: 'boolean', default: false } },
  });
  const index = await loadDesignIndex(values.index);
  if (values.json) {
    console.log(JSON.stringify(index.profiles, null, 2));
    return;
  }
  console.log(`${index.profiles.length} profile(s) in ${values.index}`);
  for (const profile of index.profiles) {
    console.log(`${profile.source.id ?? '(no id)'}\t${profile.source.title ?? ''}\t${profile.route.spine.choice}\tskin: ${profile.route.skin.choice}`);
  }
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case 'profile':
      await runProfile(rest);
      break;
    case 'add':
      await runAdd(rest);
      break;
    case 'find':
      await runFind(rest);
      break;
    case 'list':
      await runList(rest);
      break;
    default:
      fail(`usage: design-index <profile|add|find|list> ...${subcommand ? ` (unknown subcommand: ${subcommand})` : ''}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
