/**
 * Verify the licensed component payload before producing an installer.
 *
 * The payload is a private pack: a public checkout has no `cult-ui-pro` directory at all, and the
 * packaged daemon then reports the kit as not installed. When the directory exists, every file must
 * match its manifest; a directory without a manifest is a broken payload and fails the build.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyBundledComponentKit(workspaceRoot: string): Promise<'absent' | 'verified'> {
  const root = join(workspaceRoot, 'data', 'component-kits', 'cult-ui-pro');
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    schemaVersion?: unknown; files?: Array<{ file: string; bytes: number; sha256: string }>;
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid bundled component manifest');
  const seen = new Set<string>();
  const allowed = /^(?:registry\/[a-z0-9][a-z0-9-]{0,127}\.json|converted\/[a-z0-9][a-z0-9-]{0,127}\/(?:template\.html|styles\.css|slots\.json)|previews\/(?:manifest\.json|[a-z0-9][a-z0-9-]{0,127}\.(?:light|dark)\.html\.gz))$/;
  async function validateTree(relative = ''): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await validateTree(file);
      else if (!entry.isFile() || (file !== 'manifest.json' && !seen.has(file))) {
        throw new Error(`Unlisted bundled component file: ${file}`);
      }
    }
  }
  for (const entry of manifest.files) {
    if (!allowed.test(entry.file) || seen.has(entry.file)) throw new Error('Invalid bundled component file');
    seen.add(entry.file);
    const file = join(root, entry.file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Bundled components must be regular files');
    const bytes = await readFile(file);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Bundled component checksum mismatch: ${entry.file}`);
  }
  await validateTree();
  return 'verified';
}
