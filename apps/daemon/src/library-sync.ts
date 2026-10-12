// OD Library reconcile — mirror design systems and agent-produced project
// deliverables into the Library as *referenced* assets, so the Library is the
// single place a user sees everything they've made (clips, uploads, design
// systems, agent output) and can re-consume any of it.
//
// Why referenced (not owned): the bytes already live in a project / design
// system; copying them would duplicate potentially large files and go stale.
// `registerLibraryAsset({ storage: 'referenced', absPath })` stores only a
// pointer (an absolute filePath), and `resolveAssetBytesPath` already serves it.
//
// Idempotent by design. Each pass:
//   - verifies project reference bytes, refreshing edited metadata
//     without replacing their saved asset identity or source provenance,
//   - skips a design system that already has its one `design-system` card,
//   - and even if it didn't, content-hash dedup + source-row dedup collapse
//     repeats. So this is safe to run on every Library open.
//
// Best-effort: a single bad project / unreadable file must never abort the pass
// or throw into the caller (a route handler), so every unit is try-wrapped.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { LibraryAssetKind, LibrarySourceKind } from '@mish/contracts';
import { listConversations, listMessages, listProjects } from './db.js';
import { listDesignSystems } from './design-systems/index.js';
import { listFiles, resolveProjectDir } from './projects.js';
import { registerLibraryAsset, sniffImageDimensions, detectMime, preserveReferencedLibraryBytes } from './library.js';
import { findReferencedAssetByOrigin, findLibraryAssetByHash, hasDesignSystemSource, updateLibraryAsset } from './library-store.js';

type SqliteDb = Database.Database;

export interface ReconcileLibraryPaths {
  LIBRARY_DIR: string;
  PROJECTS_DIR: string;
  USER_DESIGN_SYSTEMS_DIR: string;
}

export interface ReconcileLibraryResult {
  /** Design-system cards newly registered this pass. */
  designSystems: number;
  /** Project deliverable assets newly registered this pass. */
  projectAssets: number;
  /** Referenced rows already indexed or refreshed without creating a new card. */
  deduped: number;
  /** designSystems + projectAssets. */
  total: number;
}

// Only the deliverable kinds the Library can faithfully render (image / html /
// video). pdf, presentation, audio, and document/spreadsheet/code/text are not
// modeled by LibraryAssetKind, so syncing them would produce broken thumbnails;
// they're intentionally left out of this slice. `sketch` covers .svg and
// sketch-*.png (renderable as images) — the OD-internal `.sketch.json` editable
// format is skipped explicitly below.
const DELIVERABLE_KINDS = new Set(['html', 'image', 'video', 'sketch']);

// Among agent-produced deliverables, visual media reads as "Generated"; authored
// pages/decks read as "Agent". The split is a single rule, easy to retune.
const GENERATED_MEDIA_KINDS = new Set(['image', 'video', 'sketch']);

// Cap the bytes we'll hash for one referenced asset. The origin short-circuit
// bounds reads on every reconciliation pass; a multi-hundred-MB video
// still shouldn't be slurped into memory. Above this it's skipped.
const MAX_SYNC_BYTES = 64 * 1024 * 1024;

interface ProjectFileLike {
  name: string;
  path?: string;
  type?: string;
  kind?: string;
  size?: number;
  mtime?: number;
  mime?: string;
}

/** The Library kind for a project file's inferred kind. */
function libraryKindFor(projectFileKind: string | undefined): LibraryAssetKind {
  if (projectFileKind === 'html') return 'html';
  if (projectFileKind === 'video') return 'video';
  return 'image'; // image + sketch (svg / sketch-*.png)
}

function isDeliverable(file: ProjectFileLike): boolean {
  if (file.type === 'dir') return false;
  if (!file.kind || !DELIVERABLE_KINDS.has(file.kind)) return false;
  // OD-internal editable sketch doc — not a flat, renderable deliverable.
  if (file.name.endsWith('.sketch.json')) return false;
  return true;
}

function classifySource(projectFileKind: string | undefined, produced: boolean): LibrarySourceKind {
  if (!produced) return 'manual-upload';
  return GENERATED_MEDIA_KINDS.has(projectFileKind ?? '') ? 'generated' : 'agent-task';
}

/** Best-effort unix-ms from an ISO timestamp, else undefined. */
function isoToMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isWithinRoot(absPath: string, root: string): boolean {
  const rel = path.relative(root, absPath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function resolveDesignSystemPreviewCandidate(
  dsRoot: string,
  dsRootReal: string,
  rel: string,
): Promise<{ abs: string; rel: string } | null> {
  const normalizedRel = rel.replace(/\\/g, '/').trim();
  if (!normalizedRel || normalizedRel.includes('\0') || path.isAbsolute(normalizedRel)) return null;
  const abs = path.resolve(dsRoot, normalizedRel);
  try {
    const linkInfo = await lstat(abs);
    if (linkInfo.isSymbolicLink()) return null;
    const absReal = await realpath(abs);
    if (!isWithinRoot(absReal, dsRootReal)) return null;
    const info = await stat(absReal);
    if (!info.isFile()) return null;
    return { abs: absReal, rel: normalizedRel };
  } catch {
    return null;
  }
}

// Candidate preview HTML files, in order of preference, for a user design
// system. The Library renders a `design-system` asset via an <iframe>, so we
// reference one representative self-contained-ish page. Mirrors the manifest
// shape used elsewhere (preview.pages / files.components).
async function resolveDesignSystemPreview(
  dsRoot: string,
): Promise<{ abs: string; rel: string } | null> {
  const candidates: string[] = [];
  let dsRootReal: string;
  try {
    dsRootReal = await realpath(dsRoot);
  } catch {
    return null;
  }
  try {
    const manifestRaw = await readFile(path.join(dsRoot, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      files?: { components?: string };
      preview?: { pages?: Array<{ path?: string; role?: string }> };
    };
    const pages = manifest.preview?.pages ?? [];
    // Prefer an overview/index-flavoured page, else the first listed.
    const overview = pages.find((p) => /index|overview|all|showcase|components/i.test(p.path ?? ''));
    if (overview?.path) candidates.push(overview.path);
    if (pages[0]?.path) candidates.push(pages[0].path);
    if (manifest.files?.components) candidates.push(manifest.files.components);
  } catch {
    // No / unreadable manifest — fall back to conventional locations.
  }
  candidates.push(
    'components.html',
    'ui_kits/app/index.html',
    'preview/brand-assets.html',
    'preview/components.html',
    'preview/colors-primary.html',
    'index.html',
  );
  const seen = new Set<string>();
  for (const rel of candidates) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const candidate = await resolveDesignSystemPreviewCandidate(dsRoot, dsRootReal, rel);
    if (candidate) return candidate;
  }
  return null;
}

/** Index every user design system as one `design-system` Library card. */
async function reconcileDesignSystems(
  db: SqliteDb,
  paths: ReconcileLibraryPaths,
  result: ReconcileLibraryResult,
): Promise<void> {
  let systems: Array<{ id: string; title?: string; createdAt?: string; updatedAt?: string }>;
  try {
    systems = (await listDesignSystems(paths.USER_DESIGN_SYSTEMS_DIR, {
      idPrefix: 'user:',
      source: 'user',
      isEditable: true,
      defaultStatus: 'draft',
    })) as typeof systems;
  } catch {
    return; // user DS dir may not exist yet
  }
  for (const ds of systems) {
    try {
      if (hasDesignSystemSource(db, ds.id)) {
        result.deduped += 1;
        continue;
      }
      const dirName = ds.id.startsWith('user:') ? ds.id.slice('user:'.length) : ds.id;
      const dsRoot = path.join(paths.USER_DESIGN_SYSTEMS_DIR, dirName);
      const preview = await resolveDesignSystemPreview(dsRoot);
      if (!preview) continue; // nothing renderable to reference yet
      const capturedAt = isoToMs(ds.updatedAt) ?? isoToMs(ds.createdAt);
      const res = await registerLibraryAsset({
        db,
        libraryDir: paths.LIBRARY_DIR,
        storage: 'referenced',
        absPath: preview.abs,
        kind: 'design-system',
        mime: 'text/html',
        filename: path.basename(preview.rel),
        sourceTitle: ds.title || dirName,
        capturedAt,
        relPath: preview.rel,
        tags: ['design-system'],
        source: { sourceKind: 'design-system', designSystemId: ds.id, relPath: preview.rel },
      });
      if (res.deduped) result.deduped += 1;
      else result.designSystems += 1;
    } catch {
      // best-effort per design system
    }
  }
}

/**
 * Map every file a project's agent runs reported producing to the conversation
 * that produced it. Presence in this map = "generated/authored by an agent";
 * absence = "the user dropped it in" (→ manual-upload).
 */
function buildProducedMap(db: SqliteDb, projectId: string): Map<string, string> {
  const produced = new Map<string, string>();
  let conversations: Array<{ id: string }>;
  try {
    conversations = listConversations(db, projectId) as Array<{ id: string }>;
  } catch {
    return produced;
  }
  for (const conv of conversations) {
    let messages: Array<{ producedFiles?: ProjectFileLike[] }>;
    try {
      messages = listMessages(db, conv.id) as Array<{ producedFiles?: ProjectFileLike[] }>;
    } catch {
      continue;
    }
    for (const msg of messages) {
      for (const pf of msg.producedFiles ?? []) {
        const rel = pf.path ?? pf.name;
        if (rel && !produced.has(rel)) produced.set(rel, conv.id);
      }
    }
  }
  return produced;
}

/** Keep mutable references current without replacing saved asset/source IDs. */
async function refreshProjectReference(
  db: SqliteDb,
  paths: ReconcileLibraryPaths,
  projectId: string,
  rel: string,
  absPath: string,
  file: ProjectFileLike,
): Promise<boolean> {
  const existing = findReferencedAssetByOrigin(db, projectId, rel);
  // Owned uploads are immutable content-addressed objects, even when they
  // originally came from this project. Register a new reference for new bytes.
  if (!existing || existing.storage !== 'referenced') return false;
  const bytes = await readFile(absPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== existing.contentHash) {
    const otherSources = existing.sources.filter(source => source.projectId && source.relPath
      && (source.projectId !== projectId || source.relPath !== rel));
    if (otherSources.length) {
      // A deduplicated card still represents the other project's old bytes.
      // Freeze verified old bytes as an owned object, retaining its ID and
      // provenance even if the other sources are edited on a later pass.
      for (const source of otherSources) {
        const project = listProjects(db).find(p => p.id === source.projectId);
        if (!project) continue;
        try {
          const otherRoot = resolveProjectDir(paths.PROJECTS_DIR, project.id, project.metadata);
          const otherPath = path.resolve(otherRoot, source.relPath!);
          const relative = path.relative(otherRoot, otherPath);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          const otherStat = await stat(otherPath);
          if (!otherStat.isFile() || otherStat.size > MAX_SYNC_BYTES) continue;
          const otherBytes = await readFile(otherPath);
          if (createHash('sha256').update(otherBytes).digest('hex') !== existing.contentHash) continue;
          await preserveReferencedLibraryBytes(db, paths.LIBRARY_DIR, existing, otherBytes, rel);
          return false;
        } catch { /* Try another preserved source. */ }
      }
      console.warn(`[library-sync] Cannot refresh shared reference ${existing.id}: no unchanged source remains`);
      return true;
    }
    const collision = findLibraryAssetByHash(db, hash);
    if (collision && collision.id !== existing.id) {
      // UNIQUE(content_hash) cannot represent both stable IDs. Do not merge or
      // delete saved cards/provenance implicitly; surface the bounded conflict.
      console.warn(`[library-sync] Cannot refresh reference ${existing.id}: content already belongs to ${collision.id}`);
      return true;
    }
  }
  const dimensions = existing.kind === 'image' ? sniffImageDimensions(bytes) : null;
  const mime = detectMime(bytes, file.name);
  if (hash === existing.contentHash && bytes.length === existing.size && mime === existing.mime
    && (existing.kind !== 'image' || ((existing.width ?? null) === (dimensions?.width ?? null)
      && (existing.height ?? null) === (dimensions?.height ?? null)))) return true;
  return updateLibraryAsset(db, existing.id, {
    ...(existing.kind === 'image' ? { width: dimensions?.width ?? null, height: dimensions?.height ?? null } : {}),
    contentHash: hash,
    size: bytes.length,
    mime,
  }, existing.contentHash);
}

/** Index each project's deliverable files as referenced Library assets. */
async function reconcileProjects(
  db: SqliteDb,
  paths: ReconcileLibraryPaths,
  result: ReconcileLibraryResult,
): Promise<void> {
  let projects: Array<{ id: string; metadata?: unknown }>;
  try {
    projects = listProjects(db) as Array<{ id: string; metadata?: unknown }>;
  } catch {
    return;
  }
  for (const project of projects) {
    let projectDir: string;
    let files: ProjectFileLike[];
    try {
      // Same resolution listFiles uses; both throw for unavailable sandbox
      // imported projects, which we simply skip.
      projectDir = resolveProjectDir(paths.PROJECTS_DIR, project.id, project.metadata);
      files = (await listFiles(paths.PROJECTS_DIR, project.id, {
        metadata: project.metadata,
      })) as ProjectFileLike[];
    } catch {
      continue;
    }
    const producedMap = buildProducedMap(db, project.id);
    for (const file of files) {
      try {
        if (!isDeliverable(file)) continue;
        const rel = file.path ?? file.name;
        if (!rel) continue;
        if (typeof file.size === 'number' && file.size > MAX_SYNC_BYTES) continue;
        const absPath = path.join(projectDir, rel);
        // Stat equality does not prove byte equality: editors can preserve timestamps.
        if (await refreshProjectReference(db, paths, project.id, rel, absPath, file)) {
          result.deduped += 1;
          continue;
        }
        const produced = producedMap.has(rel);
        const sourceKind = classifySource(file.kind, produced);
        const conversationId = produced ? producedMap.get(rel) : undefined;
        const res = await registerLibraryAsset({
          db,
          libraryDir: paths.LIBRARY_DIR,
          storage: 'referenced',
          absPath,
          kind: libraryKindFor(file.kind),
          mime: file.mime,
          filename: file.name,
          sourceTitle: file.name,
          capturedAt: file.mtime,
          originProjectId: project.id,
          relPath: rel,
          source: { sourceKind, projectId: project.id, conversationId, relPath: rel },
        });
        if (res.deduped) result.deduped += 1;
        else result.projectAssets += 1;
      } catch {
        // best-effort per file
      }
    }
  }
}

/**
 * Reconcile design systems + agent project deliverables into the Library as
 * referenced assets. Idempotent and best-effort; never throws. Returns what was
 * newly indexed this pass (counts the UI / CLI surface back to the user).
 */
export async function reconcileLibrary(
  db: SqliteDb,
  paths: ReconcileLibraryPaths,
): Promise<ReconcileLibraryResult> {
  const result: ReconcileLibraryResult = {
    designSystems: 0,
    projectAssets: 0,
    deduped: 0,
    total: 0,
  };
  try {
    await reconcileDesignSystems(db, paths, result);
  } catch {
    // best-effort
  }
  try {
    await reconcileProjects(db, paths, result);
  } catch {
    // best-effort
  }
  result.total = result.designSystems + result.projectAssets;
  return result;
}
