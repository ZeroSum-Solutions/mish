/** Static local demo thumbnails, separate from the saved upstream CDN reference images. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Twenty1stItem } from '@mish/contracts';

export interface Twenty1stLiveThumbnail { file: string; revision: string; }
const SHA256 = /^[a-f0-9]{64}$/;
const FILE = /^[a-z0-9][a-z0-9-]*\.webp$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only advertise a thumbnail tied to the selected implementation and its exact current bytes. */
export function twenty1stLiveThumbnailIndex(generatedDir: string, items: readonly Twenty1stItem[]): Map<string, Twenty1stLiveThumbnail> {
  const index = new Map<string, Twenty1stLiveThumbnail>();
  const manifestPath = path.join(generatedDir, '21st-live-thumbnails.json');
  if (!existsSync(manifestPath)) return index;
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return index; }
  if (!isRecord(manifest) || manifest.schema !== '21st-live-thumbnails/1' || !isRecord(manifest.items)) return index;
  const base = path.resolve(generatedDir, '21st-live-thumbnails');
  for (const item of items) {
    const implementation = item.privateImplementation ?? item.ownedAlternative;
    const entry = manifest.items[item.id];
    if (!implementation || !isRecord(entry) || entry.sourceSha256 !== implementation.sourceSha256 || entry.provenance !== implementation.provenance
      || typeof entry.file !== 'string' || !FILE.test(entry.file) || entry.file !== `${item.slug}.webp`
      || typeof entry.revision !== 'string' || !SHA256.test(entry.revision) || typeof entry.bytes !== 'number') continue;
    const file = path.resolve(base, entry.file);
    try {
      if (path.dirname(realpathSync(file)) !== realpathSync(base)) continue;
      const bytes = readFileSync(file);
      if (bytes.length !== entry.bytes || bytes.length > 20480 || createHash('sha256').update(bytes).digest('hex') !== entry.revision) continue;
      index.set(item.id, { file, revision: entry.revision });
    } catch { /* Missing or stale generated artifacts retain the upstream reference image. */ }
  }
  return index;
}


/** A changed generated file must never be served under an older immutable cache revision. */
export function twenty1stLiveThumbnailBytes(thumbnail: Twenty1stLiveThumbnail): Buffer | null {
  try {
    const bytes = readFileSync(thumbnail.file);
    return bytes.length <= 20480 && createHash('sha256').update(bytes).digest('hex') === thumbnail.revision ? bytes : null;
  } catch { return null; }
}
