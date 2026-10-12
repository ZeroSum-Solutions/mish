import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import type { ArtifactManifest } from '@open-design/contracts';
import { agencyPublicationScope } from './deploy-scope.js';
import type { PlacementFinalIO } from '../workbench/placement/project-writes.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class AgencyImageError extends Error {}

async function regularBytes(file: string, maxBytes: number): Promise<Buffer> {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new AgencyImageError('Agency image file must not be a symlink.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new AgencyImageError('Agency image file is invalid or too large.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

// Determine the stored suffix from bytes, never a submitted filename or MIME.
function rasterExtension(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 24 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'avif';
  throw new AgencyImageError('Agency image replacement requires PNG, JPEG, WebP or AVIF bytes.');
}

async function readManifest(projectRoot: string, entry: string): Promise<ArtifactManifest> {
  if (!/^[a-z][a-z0-9-]*\.html$/.test(entry)) throw new AgencyImageError('Agency image owner must be a root HTML artifact.');
  try {
    const entryInfo = await lstat(path.join(projectRoot, entry));
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('invalid entry');
    const bytes = await regularBytes(path.join(projectRoot, `${entry}.artifact.json`), 256 * 1024);
    const manifest = JSON.parse(bytes.toString('utf8')) as ArtifactManifest;
    agencyPublicationScope(manifest, entry, true);
    return manifest;
  } catch {
    throw new AgencyImageError('Agency Site image replacement requires a valid persisted publication manifest.');
  }
}

function revisionDirectory(manifest: ArtifactManifest): string {
  // readManifest validated this marker with the publication boundary.
  return `assets/agency-site/${(manifest.metadata!.agencySite as { revision: string }).revision}`;
}

async function safeDirectory(root: string, relative: string, create: boolean, finalIO?: PlacementFinalIO): Promise<string> {
  let current = await realpath(root);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (create) finalIO?.assertCurrent();
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AgencyImageError('Agency image directory must not contain symlinks.');
  }
  return current;
}

/**
 * Called only after the route verifies write authority and persisted agency-site identity.
 * `finalIO` is the route's trusted placement check, run before each project mutation.
 */
export async function stageAgencyImage(projectRoot: string, entry: string, uploadedPath: string, finalIO?: PlacementFinalIO) {
  const manifest = await readManifest(projectRoot, entry);
  const bytes = await regularBytes(uploadedPath, MAX_IMAGE_BYTES);
  const extension = rasterExtension(bytes);
  const relativeDir = revisionDirectory(manifest);
  const directory = await safeDirectory(projectRoot, relativeDir, true, finalIO);
  const filename = `image-${randomUUID()}.${extension}`;
  const destination = path.join(directory, filename);
  finalIO?.assertCurrent();
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    finalIO?.assertCurrent();
    await handle.writeFile(bytes);
  } catch (error) {
    finalIO?.assertCurrent();
    await unlink(destination).catch(() => {});
    throw error;
  } finally { await handle.close(); }
  // No manifest write yet: the image is declared only with the successful HTML save.
  return { name: `${relativeDir}/${filename}`, path: `${relativeDir}/${filename}`, size: bytes.length };
}

/** Under the existing HTML version lock, preserve the latest manifest on manual saves. */
export async function agencyManifestForManualSave(projectRoot: string, entry: string, html: string, imagePath?: unknown, initialManifest?: unknown): Promise<ArtifactManifest> {
  // The same native endpoint creates new artifacts. Only an initial save may
  // supply its manifest; later manual edits use the persisted authority.
  if (!/^[a-z][a-z0-9-]*\.html$/.test(entry)) throw new AgencyImageError('Agency image owner must be a root HTML artifact.');
  const exists = await lstat(path.join(projectRoot, entry)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!exists && imagePath === undefined) {
    try { agencyPublicationScope(initialManifest, entry, true); } catch { throw new AgencyImageError('A new Agency Site artifact requires its publication manifest.'); }
    return initialManifest as ArtifactManifest;
  }
  const manifest = await readManifest(projectRoot, entry);
  if (imagePath === undefined) return manifest;
  const prefix = `${revisionDirectory(manifest)}/`;
  if (typeof imagePath !== 'string' || !imagePath.startsWith(prefix)
    || !/^[a-z0-9][a-z0-9-]*\.(png|jpe?g|webp|avif)$/.test(imagePath.slice(prefix.length))) {
    throw new AgencyImageError('Agency replacement image must belong to the current artifact revision.');
  }
  const $ = load(html);
  if (!$('img').toArray().some((image) => $(image).attr('src') === imagePath)) {
    throw new AgencyImageError('Agency replacement image is not referenced by the saved HTML.');
  }
  const directory = await safeDirectory(projectRoot, revisionDirectory(manifest), false);
  const bytes = await regularBytes(path.join(directory, imagePath.slice(prefix.length)), MAX_IMAGE_BYTES);
  const extension = rasterExtension(bytes);
  if (path.extname(imagePath).slice(1).replace('jpeg', 'jpg') !== extension) throw new AgencyImageError('Agency image extension does not match its bytes.');
  const updated = { ...manifest, supportingFiles: [...new Set([...(manifest.supportingFiles ?? []), imagePath])] };
  try { agencyPublicationScope(updated, entry, true); } catch { throw new AgencyImageError('Agency image exceeds the publication asset limit.'); }
  return updated;
}
