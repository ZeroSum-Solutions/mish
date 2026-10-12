import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewRubricContent, ReviewRun } from '@mish/contracts';
import { readPreviewFile } from './preview-files.js';

export interface EntryVersion {
  /** Saved version id of the entry file, or null when the file has no version history. */
  versionId: string | null;
  /** SHA-256 of the entry file's current bytes; null when it cannot be read. */
  contentDigest: string | null;
  /** False when the requested saved version is no longer the file's current content. */
  current: boolean;
}

export interface CurrentProjectState {
  root: string;
  rubricRevision: number;
  contextRevision: number;
  entry: EntryVersion | null;
  /** B5-1: the daemon's current seed and checklist versions; omitted skips the comparison. */
  rubricContent?: ReviewRubricContent;
}

const MAX_REASONS = 50;
const MAX_CACHED = 5_000;

/**
 * Hash cache keyed by file identity (path, inode, size, mtime, ctime). A poll of
 * an unchanged project re-hashes nothing; any write changes mtime/ctime and is
 * re-read through the contained preview reader.
 */
const hashCache = new Map<string, { identity: string; sha256: string }>();

async function currentHash(root: string, relPath: string): Promise<{ status: number; sha256?: string }> {
  const absolute = path.join(root, ...relPath.split('/'));
  let identity: string | null = null;
  try { const info = await stat(absolute); identity = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; } catch { /* the reader reports the status */ }
  const cached = identity ? hashCache.get(absolute) : undefined;
  if (cached && cached.identity === identity) return { status: 200, sha256: cached.sha256 };
  const file = await readPreviewFile(root, `/${relPath.split('/').map(encodeURIComponent).join('/')}`);
  if (file.status !== 200) { hashCache.delete(absolute); return { status: file.status }; }
  if (identity) {
    if (hashCache.size >= MAX_CACHED) hashCache.clear();
    hashCache.set(absolute, { identity, sha256: file.sha256 });
  }
  return { status: 200, sha256: file.sha256 };
}

/**
 * AC-R03.1: a run is `outdated` once the project moved past what it froze — a
 * newer rubric or context revision, a newer saved entry revision, or any
 * rendered source file whose bytes changed or disappeared. Source files are
 * compared only once the run is terminal (before that it has no frozen source
 * set to compare), and through a stat-keyed hash cache, so polling is cheap.
 */
export async function reviewFreshness(run: ReviewRun, current: CurrentProjectState): Promise<{ state: 'current' | 'outdated'; reasons: string[] }> {
  const reasons: string[] = [];
  const frozen = run.frozen;
  if (current.rubricRevision !== frozen.rubricRevision) reasons.push(`The rubric is now at revision ${current.rubricRevision} (reviewed ${frozen.rubricRevision})`);
  if (current.contextRevision !== frozen.contextRevision) reasons.push(`The project context is now at revision ${current.contextRevision} (reviewed ${frozen.contextRevision})`);
  // AC-R06.5: a newer seed or checklist vocabulary is a visible refresh, never a silent re-reading of an older run.
  const content = frozen.rubricContent;
  if (!content && current.rubricContent) reasons.push('This run predates the judgment seeds and checklist criteria; review again to apply them');
  if (content && current.rubricContent) {
    if (content.judgmentSeeds !== current.rubricContent.judgmentSeeds) reasons.push(`The judgment seeds are now ${current.rubricContent.judgmentSeeds} (reviewed ${content.judgmentSeeds})`);
    if (content.checklistCriteria !== current.rubricContent.checklistCriteria) reasons.push(`The checklist criteria are now ${current.rubricContent.checklistCriteria} (reviewed ${content.checklistCriteria})`);
    if (content.checklistSource.revisionOrDigest !== current.rubricContent.checklistSource.revisionOrDigest) reasons.push(`The checklist source pin is now ${current.rubricContent.checklistSource.revisionOrDigest.slice(0, 12)} (reviewed ${content.checklistSource.revisionOrDigest.slice(0, 12)})`);
  }
  if (current.entry?.versionId !== frozen.snapshot.versionId && current.entry?.versionId) reasons.push(`${frozen.snapshot.entry} has a newer saved revision`);
  if (frozen.snapshot.contentDigest && current.entry?.contentDigest !== frozen.snapshot.contentDigest) reasons.push(`${frozen.snapshot.entry} changed since the review`);
  const terminal = run.operation.status === 'done' || run.operation.status === 'failed' || run.operation.status === 'interrupted';
  for (const source of terminal ? frozen.sourceHashes : []) {
    if (reasons.length >= MAX_REASONS) break;
    if (source.path === frozen.snapshot.entry && frozen.snapshot.contentDigest) continue;
    const file = await currentHash(current.root, source.path);
    if (file.status !== 200) reasons.push(`${source.path} is no longer available`);
    else if (file.sha256 !== source.sha256) reasons.push(`${source.path} changed since the review`);
  }
  return { state: reasons.length ? 'outdated' : 'current', reasons: reasons.slice(0, MAX_REASONS).map(reason => reason.slice(0, 500)) };
}
