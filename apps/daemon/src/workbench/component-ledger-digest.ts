import { createHash } from 'node:crypto';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const digestOf = (value: unknown): string => sha256(canonical(value));

/** Core and installed overlays hash the same metadata and ordered file tuples.
 * Missing manifest digests stay explicit, so an incomplete overlay cannot equal core. */
type GenuiDigestFile = readonly [string, string | null] | { file: string; sha256: string | null };
export function genuiComponentDigest(entry: unknown, files: readonly GenuiDigestFile[]): string {
  const tuples = files.map(file => 'file' in file ? [file.file, file.sha256] as const : file);
  return digestOf({ entry, files: tuples.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
}
