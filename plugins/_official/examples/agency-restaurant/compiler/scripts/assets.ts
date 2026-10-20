import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export type AssetKind = 'image' | 'font' | 'video';
export interface AssetRequirement { id: string; kind: AssetKind }
export interface ApprovedAsset extends AssetRequirement { file: string; sha256?: string; mediaType?: string; bytes?: number }
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', mp4: 'video/mp4' };
const EXTENSIONS: Record<AssetKind, RegExp> = { image: /\.(png|jpe?g|webp|avif)$/, font: /\.woff2?$/, video: /\.mp4$/ };
const LIMIT = 10 * 1024 * 1024;
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Approved asset manifest requires plain objects');
  return input as Record<string, unknown>;
}

/** The roster is an external approval input, never a field in model recipe JSON. */
export function resolveApprovedAssets(input: unknown, requirements: AssetRequirement[], revision: string) {
  const root = object(input);
  if (root.version !== 1 || Object.keys(root).some((key) => !['version', 'assets'].includes(key)) || !Array.isArray(root.assets) || root.assets.length > 128) throw new Error('Expected approved asset manifest version 1 with at most 128 assets');
  const roster = new Map<string, ApprovedAsset>();
  const filenames = new Set<string>();
  for (const raw of root.assets) {
    const item = object(raw);
    if (Object.keys(item).some((key) => !['id', 'file', 'kind', 'sha256', 'mediaType', 'bytes'].includes(key))
      || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(item.id) || roster.has(item.id)
      || typeof item.file !== 'string' || item.file.length > 120 || !/^[a-z0-9][a-z0-9-]*\.(png|jpe?g|webp|avif|woff2?|mp4)$/.test(item.file) || filenames.has(item.file)
      || typeof item.kind !== 'string' || !Object.hasOwn(EXTENSIONS, item.kind) || !EXTENSIONS[item.kind as AssetKind].test(item.file)) throw new Error('Invalid, duplicate or unsupported approved asset descriptor');
    const expectedMime = MIME[path.extname(item.file).slice(1)]!;
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('Approved asset SHA-256 must be lowercase hex');
    if (item.mediaType !== undefined && item.mediaType !== expectedMime) throw new Error('Approved asset media type does not match its suffix');
    if (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1 || (item.bytes as number) > LIMIT)) throw new Error('Approved asset byte size must be 1–10 MB');
    roster.set(item.id, item as unknown as ApprovedAsset);
    filenames.add(item.file);
  }
  const paths: Record<string, string> = Object.create(null);
  const assets = requirements.map(({ id, kind }) => {
    const approved = roster.get(id);
    if (!approved) throw new Error(`Unknown or missing approved asset: ${id}`);
    if (approved.kind !== kind) throw new Error(`Approved asset ${id} has the wrong role`);
    const file = `assets/agency-site/${revision}/${approved.file}`;
    paths[id] = file;
    return { ...approved, destination: file };
  });
  return { paths, assets };
}

export async function readRegularFile(file: string, limit: number, verifyLocation?: () => Promise<void>): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error(`Expected a regular non-symlink file within ${limit} bytes: ${path.basename(file)}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || stat.dev !== info.dev || stat.ino !== info.ino) throw new Error('Input file changed or exceeds its limit');
    await verifyLocation?.();
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Input file grew beyond its limit');
    await verifyLocation?.();
    return bytes;
  } finally { await handle.close(); }
}

// File signatures stop an approved descriptor from disguising executable text as media.
// These are format checks, not a full decoder or a license/content assessment.
function matchesSignature(bytes: Buffer, suffix: string): boolean {
  if (suffix === 'png') return bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (suffix === 'jpg' || suffix === 'jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (suffix === 'webp') return bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (suffix === 'woff' || suffix === 'woff2') return bytes.length >= (suffix === 'woff' ? 44 : 48) && bytes.toString('ascii', 0, 4) === (suffix === 'woff' ? 'wOFF' : 'wOF2') && bytes.readUInt32BE(8) === bytes.length;
  if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length || boxSize > 4096) return false;
  const brands = [bytes.toString('ascii', 8, 12)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
  if (suffix === 'avif') return brands.some((brand) => brand === 'avif' || brand === 'avis');
  return suffix === 'mp4' && !brands.some((brand) => brand === 'avif' || brand === 'avis') && brands.some((brand) => /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(brand));
}

export async function readApprovedAsset(root: string, asset: ApprovedAsset): Promise<Buffer> {
  // Canonicalize the parent first: a later realpath must not redefine the approved root.
  const resolvedRoot = path.resolve(root);
  const pinnedRoot = path.join(await realpath(path.dirname(resolvedRoot)), path.basename(resolvedRoot));
  const directory = await lstat(pinnedRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Approved asset root must be a non-symlink directory');
  const verifyLocation = async () => {
    if (await realpath(pinnedRoot) !== pinnedRoot) throw new Error('Approved asset root changed location');
    const current = await lstat(pinnedRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('Approved asset root changed identity');
  };
  await verifyLocation();
  const bytes = await readRegularFile(path.join(pinnedRoot, asset.file), LIMIT, verifyLocation);
  verifyApprovedAssetBytes(asset, bytes);
  return bytes;
}

/**
 * The checks every approved asset's bytes pass, wherever they came from: within the size limit,
 * a file signature that matches the suffix, and the descriptor's byte size and SHA-256 when it
 * names them. `readApprovedAsset` runs it on a file; the publisher library runs it on the bytes a
 * caller's asset resolver returns. Throws on the first failure.
 */
export function verifyApprovedAssetBytes(asset: ApprovedAsset, input: Uint8Array): void {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > LIMIT) throw new Error(`Asset ${asset.id} exceeds ${LIMIT} bytes`);
  if (!matchesSignature(bytes, path.extname(asset.file).slice(1))) throw new Error(`Asset ${asset.id} bytes do not match its media type`);
  if (asset.bytes !== undefined && asset.bytes !== bytes.length) throw new Error(`Asset ${asset.id} byte size mismatch`);
  if (asset.sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Asset ${asset.id} SHA-256 mismatch`);
}
