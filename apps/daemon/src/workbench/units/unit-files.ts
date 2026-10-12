import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { WORKBENCH_UNIT_LIMITS } from '@open-design/contracts';

export class UnitError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422,
    readonly code: string,
    message: string,
    readonly paths: string[] = [],
  ) { super(message); }
}

export interface UnitSourceFile { path: string; bytes: Buffer; sha256: string; mediaType: string }

const MEDIA: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain', '.md': 'text/markdown',
};
export const mediaTypeFor = (relPath: string) => MEDIA[path.extname(relPath).toLowerCase()] ?? 'application/octet-stream';
export const isEditableSource = (mediaType: string) => ['text/html', 'text/css', 'text/javascript'].includes(mediaType);

/** Test seam: run between the path check and the open, and after the open. */
export interface UnitReadRaceHooks { beforeOpen?: (relPath: string) => Promise<void>; afterOpen?: (relPath: string) => Promise<void> }

/**
 * The (dev, ino) the project-relative path names right now, or null when any
 * component is missing, is a symbolic link, or the real path leaves the root.
 * Every segment is lstat'ed so a symlinked directory is refused too.
 */
async function boundIdentity(realRoot: string, relPath: string, absolute: string): Promise<{ dev: number; ino: number } | 'missing' | 'unsafe'> {
  let cursor = realRoot;
  let last;
  for (const segment of relPath.split('/')) {
    cursor = path.join(cursor, segment);
    try { last = await lstat(cursor); } catch { return 'missing'; }
    if (last.isSymbolicLink()) return 'unsafe';
  }
  try { if (await realpath(absolute) !== absolute) return 'unsafe'; } catch { return 'missing'; }
  return { dev: last!.dev, ino: last!.ino };
}

/**
 * Read the listed project files for a unit save. Every path is resolved under
 * the project root; a symlink anywhere on the path, a non-regular file, or a
 * real path outside the root is refused, and sizes are bounded before the
 * bytes are read in full. The check is not trusted on its own: the file is
 * opened without following a final symlink, and the opened descriptor's
 * (dev, ino) must match the path's lstat'ed identity both before and after
 * the open, so a component swapped for a symlink in between (and possibly
 * swapped back) is refused rather than read.
 */
export async function readUnitSourceFiles(projectRoot: string, relPaths: readonly string[], hooks: UnitReadRaceHooks = {}): Promise<UnitSourceFile[]> {
  if (relPaths.length > WORKBENCH_UNIT_LIMITS.maxFiles) throw new UnitError(413, 'unit-too-many-files', `A unit has at most ${WORKBENCH_UNIT_LIMITS.maxFiles} files`);
  const realRoot = await realpath(projectRoot);
  const files: UnitSourceFile[] = [];
  let total = 0;
  for (const relPath of relPaths) {
    const absolute = path.resolve(realRoot, ...relPath.split('/'));
    if (!absolute.startsWith(`${realRoot}${path.sep}`)) throw new UnitError(422, 'unsafe-path', `${relPath} is outside the project`, [relPath]);
    const unsafe = () => new UnitError(422, 'unsafe-path', `${relPath} goes through a symbolic link or does not resolve inside the project`, [relPath]);
    const before = await boundIdentity(realRoot, relPath, absolute);
    if (before === 'missing') throw new UnitError(422, 'source-missing', `${relPath} does not exist in the project`, [relPath]);
    if (before === 'unsafe') throw unsafe();
    await hooks.beforeOpen?.(relPath);
    let handle;
    try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafe();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnitError(422, 'source-missing', `${relPath} does not exist in the project`, [relPath]);
      throw error;
    }
    try {
      await hooks.afterOpen?.(relPath);
      const info = await handle.stat();
      const after = await boundIdentity(realRoot, relPath, absolute);
      const same = (id: typeof after) => typeof id === 'object' && id.dev === info.dev && id.ino === info.ino;
      if (!same(before) || !same(after)) throw unsafe();
      if (!info.isFile()) throw new UnitError(422, 'unsafe-path', `${relPath} is not a regular file`, [relPath]);
      if (info.size > WORKBENCH_UNIT_LIMITS.maxFileBytes) throw new UnitError(413, 'unit-file-too-large', `${relPath} is larger than ${WORKBENCH_UNIT_LIMITS.maxFileBytes} bytes`, [relPath]);
      total += info.size;
      if (total > WORKBENCH_UNIT_LIMITS.maxTotalBytes) throw new UnitError(413, 'unit-too-large', `A unit is at most ${WORKBENCH_UNIT_LIMITS.maxTotalBytes} bytes`, [relPath]);
      const bytes = await handle.readFile();
      if (bytes.length !== info.size) throw new UnitError(409, 'source-changed', `${relPath} changed while it was read`, [relPath]);
      files.push({ path: relPath, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: mediaTypeFor(relPath) });
    } finally { await handle.close(); }
  }
  return files;
}
