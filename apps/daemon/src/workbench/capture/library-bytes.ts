import { access, readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { registerLibraryAsset, resolveAssetBytesPath } from '../../library.js';
import { findLibraryAssetByHash, getLibraryAsset } from '../../library-store.js';
import type { CaptureBytesPort } from './capture-service.js';

type SqliteDb = Database.Database;

export const CAPTURE_LIBRARY_TAG = 'workbench-capture';
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Capture bytes become owned Library image assets (content-addressed under
 * LIBRARY_DIR, which derives from RUNTIME_DATA_DIR). Per-capture provenance
 * stays in the capture record; the deduplicated Library asset only gains a
 * project back-link and the capture tag.
 */
export function createLibraryCaptureBytes(input: { db: SqliteDb; libraryDir: string; projectsDir: string }): CaptureBytesPort {
  return {
    async put({ bytes, mediaType, projectId }) {
      const { asset } = await registerLibraryAsset({
        db: input.db, libraryDir: input.libraryDir, storage: 'owned', kind: 'image', bytes, mime: mediaType,
        filename: `capture.${EXTENSION[mediaType] ?? 'png'}`, tags: [CAPTURE_LIBRARY_TAG],
        source: { sourceKind: 'manual-upload', projectId },
      });
      return { assetId: asset.id };
    },
    async read(assetId) {
      const asset = getLibraryAsset(input.db, assetId);
      const file = asset ? resolveAssetBytesPath(asset, input.projectsDir) : null;
      if (!file) return null;
      try { return await readFile(file); } catch { return null; }
    },
    async has(assetId, contentHash) {
      const asset = getLibraryAsset(input.db, assetId);
      const file = asset && asset.contentHash === contentHash ? resolveAssetBytesPath(asset, input.projectsDir) : null;
      if (!file) return false;
      try { await access(file); return true; } catch { return false; }
    },
  };
}

/** True when the Library already holds these bytes as a capture or a web clip from another page. */
export function libraryHoldsCapturedBytes(db: SqliteDb, sha256: string): boolean {
  const asset = findLibraryAssetByHash(db, sha256);
  return Boolean(asset && (asset.tags.includes(CAPTURE_LIBRARY_TAG) || asset.sources.some(source => source.sourceKind === 'clipper')));
}
