/**
 * Loads the daemon's bundled owner-authored local prompt corpus (see
 * `@mish/section-catalog`'s `src/local-corpus.ts` for the importer/validator and the
 * 2026-09-24 phase-C coordination note this implements). The data ships with the package at
 * `@mish/section-catalog/data/zerosum-local-corpus.json` — it is NOT fetched over the
 * network and is NOT the same thing as the federated `motionsites-mcp` source in `catalog.ts`.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { importLocalCorpus, resolveLocalCorpusText, type LocalCorpusRow } from '@mish/section-catalog/local-corpus';
import type { SectionCatalogEntry } from '@mish/contracts/api/section-catalog';

const require = createRequire(import.meta.url);

let cachedRows: LocalCorpusRow[] | null = null;

/** Resolves the bundled data file's absolute path via Node's own package resolution (honors the
 * package's `exports` map), rather than a relative `../../../` walk that breaks the moment this
 * file moves. */
function resolveDataFilePath(): string {
  return require.resolve('@mish/section-catalog/data/zerosum-local-corpus.json');
}

async function loadRows(): Promise<LocalCorpusRow[]> {
  if (cachedRows) return cachedRows;
  const path = resolveDataFilePath();
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array of local-corpus rows`);
  cachedRows = parsed as LocalCorpusRow[];
  return cachedRows;
}

/** Test-only escape hatch: force the next `getLocalCorpusEntries`/`getLocalCorpusText` call to
 * re-read the file (or a test-supplied row set) instead of the module-level cache. */
export function resetLocalCorpusCache(rows: LocalCorpusRow[] | null = null): void {
  cachedRows = rows;
}

/** Normalized `local-corpus` catalog entries — never carries `our_text`, see
 * `importLocalCorpus`'s own guarantee. */
export async function getLocalCorpusEntries(): Promise<SectionCatalogEntry[]> {
  const rows = await loadRows();
  // `@mish/section-catalog`'s `SectionCatalogEntry` and `@mish/contracts`'s mirror
  // it (section-catalog.ts's file header) are kept structurally identical on purpose — this plain
  // return is itself the compile-time check that they still agree, the same role
  // `packages/section-catalog/src/motionsites.ts`'s header describes for phase D's catalog route.
  return importLocalCorpus(rows).entries;
}

/** The local-corpus analogue of a transient `get_prompt` — resolves one row's text by its
 * `content.corpusId`, or `null` if the id is unknown or the row would be refused by the importer's
 * own rules. Never logs or persists the returned text; the caller (design-reference.ts) must not
 * either. */
export async function getLocalCorpusText(corpusId: string): Promise<string | null> {
  const rows = await loadRows();
  return resolveLocalCorpusText(rows, corpusId);
}
