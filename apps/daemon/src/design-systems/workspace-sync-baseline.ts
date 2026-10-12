import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DesignSystemWorkspaceSyncConflict } from '@open-design/contracts';

/**
 * The sync baseline of one file a design-system package materialised into
 * its `ds-<id>` workspace project. Stored in the daemon SQLite database
 * (`design_system_workspace_sync_baselines`), which lives under the resolved
 * daemon data root; rows cascade away with their project.
 *
 * - `packageSha256`: hash of the package file the project copy was last
 *   written from. Advanced only after a successful write.
 * - `projectSha256`: hash of the bytes that write produced. A project file
 *   whose hash differs has been edited by the user.
 */
export type DesignSystemWorkspaceSyncBaseline = {
  path: string;
  packageSha256: string;
  projectSha256: string;
};

/**
 * Per-project result of the last full sync, used by the fast path:
 * - `packageFingerprint`: hash of the sorted package `path, sha256` list.
 * - `observed`: `size:mtimeNs:ino` (or `missing`) of every project path the
 *   sync looked at — every package path and every baseline path.
 * - `conflicts`: the conflicts that sync computed. They are recomputed by
 *   every full sync and reused unchanged by the fast path, so the same
 *   conflicts return until the user resolves them.
 */
export type DesignSystemWorkspaceSyncState = {
  packageFingerprint: string;
  observed: Record<string, string>;
  conflicts: DesignSystemWorkspaceSyncConflict[];
};

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readDesignSystemWorkspaceSyncBaselines(
  db: Database.Database,
  projectId: string,
): Map<string, DesignSystemWorkspaceSyncBaseline> {
  const rows = db
    .prepare(
      `SELECT path, package_sha256 AS packageSha256, project_sha256 AS projectSha256
         FROM design_system_workspace_sync_baselines
        WHERE project_id = ?`,
    )
    .all(projectId) as DesignSystemWorkspaceSyncBaseline[];
  return new Map(rows.map((row) => [row.path, row]));
}

export function writeDesignSystemWorkspaceSyncBaseline(
  db: Database.Database,
  projectId: string,
  baseline: DesignSystemWorkspaceSyncBaseline,
  syncedAt: number,
): void {
  db.prepare(
    `INSERT INTO design_system_workspace_sync_baselines
       (project_id, path, package_sha256, project_sha256, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET
       package_sha256 = excluded.package_sha256,
       project_sha256 = excluded.project_sha256,
       synced_at = excluded.synced_at`,
  ).run(projectId, baseline.path, baseline.packageSha256, baseline.projectSha256, syncedAt);
}

export function deleteDesignSystemWorkspaceSyncBaseline(
  db: Database.Database,
  projectId: string,
  filePath: string,
): void {
  db.prepare(
    `DELETE FROM design_system_workspace_sync_baselines WHERE project_id = ? AND path = ?`,
  ).run(projectId, filePath);
}

/** Directories the sync created, project-relative. */
export function readDesignSystemWorkspaceSyncDirs(db: Database.Database, projectId: string): string[] {
  const rows = db
    .prepare(`SELECT path FROM design_system_workspace_sync_dirs WHERE project_id = ?`)
    .all(projectId) as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

export function recordDesignSystemWorkspaceSyncDir(
  db: Database.Database,
  projectId: string,
  dirPath: string,
  createdAt: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO design_system_workspace_sync_dirs (project_id, path, created_at)
     VALUES (?, ?, ?)`,
  ).run(projectId, dirPath, createdAt);
}

export function deleteDesignSystemWorkspaceSyncDir(
  db: Database.Database,
  projectId: string,
  dirPath: string,
): void {
  db.prepare(
    `DELETE FROM design_system_workspace_sync_dirs WHERE project_id = ? AND path = ?`,
  ).run(projectId, dirPath);
}

export function deleteDesignSystemWorkspaceSyncState(db: Database.Database, projectId: string): void {
  db.prepare(`DELETE FROM design_system_workspace_sync_state WHERE project_id = ?`).run(projectId);
}

export function readDesignSystemWorkspaceSyncState(
  db: Database.Database,
  projectId: string,
): DesignSystemWorkspaceSyncState | null {
  const row = db
    .prepare(
      `SELECT package_fingerprint AS packageFingerprint, observed_json AS observedJson,
              conflicts_json AS conflictsJson
         FROM design_system_workspace_sync_state
        WHERE project_id = ?`,
    )
    .get(projectId) as { packageFingerprint: string; observedJson: string; conflictsJson: string } | undefined;
  if (!row) return null;
  try {
    const observed = JSON.parse(row.observedJson) as unknown;
    const conflicts = JSON.parse(row.conflictsJson) as unknown;
    if (!observed || typeof observed !== 'object' || !Array.isArray(conflicts)) return null;
    return {
      packageFingerprint: row.packageFingerprint,
      observed: observed as Record<string, string>,
      conflicts: conflicts as DesignSystemWorkspaceSyncConflict[],
    };
  } catch {
    return null;
  }
}

export function writeDesignSystemWorkspaceSyncState(
  db: Database.Database,
  projectId: string,
  state: DesignSystemWorkspaceSyncState,
  syncedAt: number,
): void {
  db.prepare(
    `INSERT INTO design_system_workspace_sync_state
       (project_id, package_fingerprint, observed_json, conflicts_json, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       package_fingerprint = excluded.package_fingerprint,
       observed_json = excluded.observed_json,
       conflicts_json = excluded.conflicts_json,
       synced_at = excluded.synced_at`,
  ).run(
    projectId,
    state.packageFingerprint,
    JSON.stringify(state.observed),
    JSON.stringify(state.conflicts),
    syncedAt,
  );
}
