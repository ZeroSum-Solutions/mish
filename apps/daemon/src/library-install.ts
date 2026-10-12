// @ts-nocheck
// Install/uninstall logic for user-managed skills and design systems.
// Installed items live in the daemon-managed skill and design-system roots
// (see the daemon data directory contract in the root AGENTS.md).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isBlocked } from './linked-dirs.js';
import { listSkills, findSkillById } from './skills.js';
import { listDesignSystems } from './design-systems/index.js';
import {
  DEFAULT_KIT_COPY_BUDGET,
  KitMaterializeError,
  isSameOrInside,
  materializeKitIntoManagedRoot,
} from './design-systems/kit-materialize.js';

/** @typedef {{ source: 'github', url: string } | { source: 'local', path: string }} InstallTarget */

export const GITHUB_URL_RE = /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/;
export const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function sanitizeRepoName(url) {
  const trimmed = url.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  const raw = segments[segments.length - 1] || 'unnamed';
  // Strip .git suffix
  const name = raw.replace(/\.git$/, '');
  // Allow only safe characters, truncate to 64 chars
  if (!SAFE_NAME_RE.test(name)) return 'skill-' + Date.now();
  return name.slice(0, 64);
}

/**
 * Recursively report whether `dir` contains any symbolic link at any depth.
 * Uses lstat-based dirents (readdir withFileTypes) so it detects symlinks
 * without following them and never descends through one.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function containsSymlink(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A missing dir has nothing to scan. Any other readdir failure on a tree we
    // just cloned is unexpected; fail closed so a partially-readable clone can't
    // slip a symlink past the scan.
    if (err && err.code === 'ENOENT') return false;
    return true;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await containsSymlink(path.join(dir, entry.name)))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {InstallTarget} target
 * @param {string} userDir - daemon-managed install root for this kind
 * @param {'skill' | 'design-system'} kind
 * @param {{ copyBudget?: import('./design-systems/kit-materialize.js').KitCopyBudget }} [options]
 * @returns {Promise<{ok: true, dir: string} | {ok: false, error: string}>}
 */
export async function installFromTarget(target, userDir, kind, options = {}) {
  const manifest = kind === 'skill' ? 'SKILL.md' : 'DESIGN.md';

  if (target.source === 'github') {
    return installFromGithub(target.url, userDir, manifest);
  }
  if (target.source === 'local') {
    return kind === 'design-system'
      ? installDesignSystemFromLocal(target.path, userDir, options.copyBudget ?? DEFAULT_KIT_COPY_BUDGET)
      : installFromLocal(target.path, userDir, manifest);
  }
  return { ok: false, error: 'Invalid install source' };
}

async function installFromGithub(url, userDir, manifest) {
  if (!GITHUB_URL_RE.test(url)) {
    return { ok: false, error: 'Invalid GitHub URL. Expected https://github.com/<owner>/<repo>' };
  }

  const dirName = sanitizeRepoName(url);
  const dest = path.join(userDir, dirName);

  // Check collision
  try {
    const stat = fs.statSync(dest);
    if (stat.isDirectory()) {
      return { ok: false, error: `A ${manifest === 'SKILL.md' ? 'skill' : 'design system'} named "${dirName}" is already installed` };
    }
  } catch {
    // Doesn't exist — good.
  }

  // Shallow clone
  try {
    await new Promise((resolve, reject) => {
      const cp = execFile('git', ['clone', '--depth', '1', url, dest], {
        timeout: 60_000,
      }, (err, _stdout, stderr) => {
        if (err) {
          // Clean up partial clone
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
          reject(new Error(stderr || err.message));
        } else {
          resolve(undefined);
        }
      });
    });
  } catch (err) {
    return { ok: false, error: `git clone failed: ${String(err).split('\n')[0]}` };
  }

  // Refuse a clone that contains symbolic links. The daemon's design-system and
  // skill file readers follow symlinks, so a committed in-tree symlink pointing
  // outside the install dir (e.g. `DESIGN.md -> /etc/passwd`) would let a
  // third-party repo exfiltrate any daemon-readable file. Extensions are
  // self-contained trees and never need symlinks.
  if (await containsSymlink(dest)) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return { ok: false, error: 'Repository contains symbolic links, which are not allowed' };
  }

  // Verify manifest exists
  if (!fs.existsSync(path.join(dest, manifest))) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      error: `Repository does not contain a ${manifest} file`,
    };
  }

  return { ok: true, dir: dest };
}

async function installFromLocal(localPath, userDir, manifest) {
  if (!path.isAbsolute(localPath)) {
    return { ok: false, error: 'Path must be absolute' };
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(localPath);
  } catch {
    return { ok: false, error: 'Directory does not exist or is not accessible' };
  }

  try {
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: 'Not a directory' };
    }
  } catch {
    return { ok: false, error: 'Directory does not exist or is not accessible' };
  }

  if (isBlocked(realPath)) {
    return { ok: false, error: 'System directory not allowed' };
  }

  if (!fs.existsSync(path.join(realPath, manifest))) {
    return { ok: false, error: `Directory does not contain a ${manifest} file` };
  }

  const dirName = path.basename(realPath);
  const linkPath = path.join(userDir, dirName);

  // Check collision
  try {
    fs.statSync(linkPath);
    return { ok: false, error: `A ${manifest === 'SKILL.md' ? 'skill' : 'design system'} named "${dirName}" is already installed` };
  } catch {
    // Doesn't exist — good.
  }

  // Create symlink
  try {
    fs.symlinkSync(realPath, linkPath, 'junction');
  } catch (err) {
    return { ok: false, error: `Failed to create symlink: ${err.message}` };
  }

  return { ok: true, dir: linkPath };
}

/**
 * A local design-system install copies the kit into the managed root instead
 * of symlinking it. The daemon writes install-owned files into the installed
 * entry (metadata.json with the Workspace claim and status, revisions/, the
 * derived README/SKILL.md set, edited DESIGN.md); with a symlink every one of
 * those writes landed in the user's source folder. The installed copy is a
 * snapshot: reinstall to pick up later edits to the source.
 */
async function installDesignSystemFromLocal(localPath, userDir, copyBudget) {
  const manifest = 'DESIGN.md';
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
    return { ok: false, error: 'Path must be absolute' };
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(localPath);
    if (!fs.statSync(realPath).isDirectory()) {
      return { ok: false, error: 'Not a directory' };
    }
  } catch {
    return { ok: false, error: 'Directory does not exist or is not accessible' };
  }

  if (isBlocked(realPath)) {
    return { ok: false, error: 'System directory not allowed' };
  }

  // lstat, not stat: a DESIGN.md symlink is not followed here, and the copy
  // below refuses it with the symbolic-link error.
  try {
    const manifestStats = fs.lstatSync(path.join(realPath, manifest));
    if (!manifestStats.isFile() && !manifestStats.isSymbolicLink()) {
      return { ok: false, error: `Directory does not contain a ${manifest} file` };
    }
  } catch {
    return { ok: false, error: `Directory does not contain a ${manifest} file` };
  }

  let realUserDir;
  try {
    fs.mkdirSync(userDir, { recursive: true });
    realUserDir = fs.realpathSync.native(userDir);
  } catch (err) {
    return { ok: false, error: `Design system install directory is not available: ${err.message}` };
  }
  if (isSameOrInside(realPath, realUserDir) || isSameOrInside(realUserDir, realPath)) {
    return {
      ok: false,
      error: 'Cannot install a folder that overlaps the managed design-system directory',
    };
  }

  const dirName = path.basename(realPath);
  try {
    const dir = await materializeKitIntoManagedRoot(realPath, userDir, dirName, copyBudget);
    return { ok: true, dir };
  } catch (err) {
    if (err instanceof KitMaterializeError) {
      return {
        ok: false,
        error: err.code === 'TARGET_EXISTS'
          ? `A design system named "${dirName}" is already installed`
          : err.message,
      };
    }
    return { ok: false, error: `Failed to install design system: ${err.message}` };
  }
}

/**
 * @param {string} id - skill or DS id to uninstall
 * @param {string} userDir - user-installed directory
 * @param {string} builtInDir - built-in directory
 * @param {'skill' | 'design-system'} kind
 * @returns {Promise<{ok: true} | {ok: false, error: string, status?: number}>}
 */
export async function uninstallById(id, userDir, builtInDir, kind) {
  const listFn = kind === 'skill' ? listSkills : listDesignSystems;

  // Check if it's a built-in item
  const builtIn = await listFn(builtInDir);
  if (builtIn.some((s) => s.id === id)) {
    return { ok: false, error: 'Cannot uninstall built-in items', status: 403 };
  }

  // Find in user directory
  const installed = await listFn(userDir);
  const item = installed.find((s) => s.id === id);
  if (!item) {
    return { ok: false, error: 'Not found in user-installed items', status: 404 };
  }

  // item.dir points to the filesystem directory
  const target = item.dir;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
    } else if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, error: `Failed to remove: ${err.message}` };
  }

  return { ok: true };
}
