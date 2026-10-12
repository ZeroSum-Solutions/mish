/** Canonical D16 package-revision stream, shared by runtime and packaging.
 * I/O, UTF-8 encoding and SHA-256 stay with the caller. */
const bookkeeping = new Set(['status', 'createdAt', 'updatedAt', 'projectId', 'workspaceId', 'teamSynced', 'userSet']);
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stableValue(item)]));
  return value;
}
function comparePaths(a: string, b: string): number {
  const left = a.split('/'); const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}
type Utf8 = { encode(text: string): Uint8Array; decode(bytes: Uint8Array): string };
export function designSystemRevisionMetadata(raw: Uint8Array | undefined, utf8: Utf8): { bytes: Uint8Array; invalid: boolean } {
  let metadata: Record<string, unknown> = {};
  let invalid = false;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(utf8.decode(raw));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid = true;
      else metadata = parsed as Record<string, unknown>;
    } catch { invalid = true; }
  }
  if (invalid) return { bytes: raw!, invalid };
  const content = Object.fromEntries(Object.entries(metadata).filter(([key]) => !bookkeeping.has(key)));
  content.surface ??= 'web';
  return { bytes: utf8.encode(JSON.stringify(stableValue(content))), invalid };
}
export function updateDesignSystemRevisionFile(update: (chunk: string | Uint8Array) => void, name: string, bytes: Uint8Array): void {
  update(JSON.stringify([name, bytes.length]));
  update(bytes);
}
export function updateDesignSystemRevision(
  update: (chunk: string | Uint8Array) => void,
  files: ReadonlyMap<string, Uint8Array>,
  utf8: Utf8,
): void {
  updateDesignSystemRevisionFile(update, 'metadata.json', designSystemRevisionMetadata(files.get('metadata.json'), utf8).bytes);
  for (const name of [...files.keys()].sort(comparePaths)) {
    if (['metadata.json', '.git', 'node_modules', 'revisions', '.od-team-resource.json'].includes(name.split('/')[0]!)) continue;
    updateDesignSystemRevisionFile(update, name, files.get(name)!);
  }
}
