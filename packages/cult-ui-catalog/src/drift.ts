/**
 * Human-readable drift between the committed catalog and one rebuilt from the kit: snapshot
 * fields, added/removed rows, missing or new files, changed hashes, and changed classification.
 */

import { canonicalJson } from './canonical.ts';
import type { CultCatalog, CultCatalogRow } from './types.ts';

function rowDrift(before: CultCatalogRow, after: CultCatalogRow): string[] {
  const out: string[] = [];
  const at = before.id;
  // A row that was pending-fetch has no hashes yet; its first fetch is new content, not a changed
  // hash. Saying "changed" there made a completed fetch look like upstream rewrote pinned items.
  if (before.source.registrySha256 === null && after.source.registrySha256 !== null) {
    out.push(`${at}: newly fetched (was pending-fetch in the committed snapshot)`);
    const strip = (row: CultCatalogRow) => canonicalJson({ ...row, source: undefined });
    if (strip(before) !== strip(after)) out.push(`${at}: metadata or classification changed`);
    return out;
  }
  if (before.source.registrySha256 !== after.source.registrySha256) out.push(`${at}: registry item hash changed`);
  const beforeFiles = new Map(before.source.files.map((f) => [f.path, f]));
  const afterFiles = new Map(after.source.files.map((f) => [f.path, f]));
  for (const [path, file] of beforeFiles) {
    const next = afterFiles.get(path);
    if (!next) out.push(`${at}: missing file ${path}`);
    else {
      if (file.sha256 !== next.sha256) out.push(`${at}: changed hash for ${path}`);
      if (file.target !== next.target) out.push(`${at}: changed target for ${path}`);
      if (file.type !== next.type) out.push(`${at}: changed type for ${path}`);
      if (file.bytes !== next.bytes) out.push(`${at}: changed size for ${path}`);
    }
  }
  for (const path of afterFiles.keys()) if (!beforeFiles.has(path)) out.push(`${at}: new file ${path}`);
  const strip = (row: CultCatalogRow) => canonicalJson({ ...row, source: undefined });
  if (strip(before) !== strip(after)) out.push(`${at}: metadata or classification changed`);
  return out;
}

export function catalogDrift(committed: CultCatalog, fresh: CultCatalog): string[] {
  const out: string[] = [];
  for (const key of Object.keys(fresh.snapshot) as Array<keyof CultCatalog['snapshot']>) {
    if (committed.snapshot[key] !== fresh.snapshot[key]) {
      out.push(`snapshot.${key}: committed ${String(committed.snapshot[key])}, kit ${String(fresh.snapshot[key])}`);
    }
  }
  const before = new Map(committed.rows.map((r) => [r.id, r]));
  const after = new Map(fresh.rows.map((r) => [r.id, r]));
  for (const id of before.keys()) if (!after.has(id)) out.push(`${id}: row no longer in the kit`);
  for (const id of after.keys()) if (!before.has(id)) out.push(`${id}: row missing from catalog.json`);
  for (const [id, row] of before) {
    const next = after.get(id);
    if (next) out.push(...rowDrift({ ...row, source: { ...row.source, snapshotId: '' } }, { ...next, source: { ...next.source, snapshotId: '' } }));
  }
  return out;
}
