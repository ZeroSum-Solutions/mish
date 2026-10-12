import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_PREVIEW_FILE_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

/** A path segment the preview may expose: no dot segments, dotfiles/dot-directories, NUL, backslash or embedded slash. */
const isServedSegment = (segment: string) => segment !== '' && !segment.startsWith('.') && !/[\\\0/]/u.test(segment);

export type PreviewFile =
  | { status: 200; relPath: string; contentType: string; body: Buffer; sha256: string }
  | { status: 403 | 404 | 413; relPath: string | null; reason: string };

/**
 * Maps a preview-origin URL path to a file inside the project root. Refuses
 * dot segments, dotfiles/dot-directories, NUL/backslash tricks and symlinks
 * that resolve outside the root; directories serve their index.html.
 *
 * Invariant: the bytes served are those of a visible file. Both the requested
 * path and the path it resolves to after following symlinks must pass the
 * segment rule, so an alias such as public.txt -> a hidden file is refused.
 */
export async function readPreviewFile(projectRoot: string, urlPathname: string): Promise<PreviewFile> {
  let segments: string[];
  try { segments = urlPathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment)); } catch { return { status: 403, relPath: null, reason: 'Malformed path encoding' }; }
  if (!segments.every(isServedSegment)) return { status: 403, relPath: null, reason: 'Path segment is not served' };
  let root: string;
  try { root = await realpath(projectRoot); } catch { return { status: 404, relPath: null, reason: 'Project root is unavailable' }; }
  let relPath = segments.join('/');
  let candidate = path.join(root, ...segments);
  try {
    if ((await stat(candidate)).isDirectory()) { candidate = path.join(candidate, 'index.html'); relPath = relPath ? `${relPath}/index.html` : 'index.html'; }
    const real = await realpath(candidate);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) return { status: 403, relPath, reason: 'Path resolves outside the project' };
    if (real !== root && !path.relative(root, real).split(path.sep).every(isServedSegment)) return { status: 403, relPath, reason: 'Path resolves to a file that is not served' };
    const info = await stat(real);
    if (!info.isFile()) return { status: 404, relPath, reason: 'Not a file' };
    if (info.size > MAX_PREVIEW_FILE_BYTES) return { status: 413, relPath, reason: 'File exceeds the preview size limit' };
    const body = await readFile(real);
    return { status: 200, relPath, body, sha256: createHash('sha256').update(body).digest('hex'), contentType: CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream' };
  } catch {
    return { status: 404, relPath, reason: 'File not found' };
  }
}
