import { updateDesignSystemRevision } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, join, sep } from 'node:path';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
  return value as RecordValue;
}
function relativeFile(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || /[\\\x00-\x1f\x7f:]/.test(value)
    || value.split('/').some((part) => !part || part.startsWith('.') || part !== part.trim() || part.endsWith('.'))) {
    throw new Error('invalid path');
  }
  const rootFiles = [
    'manifest.json',
    'DESIGN.md',
    'USAGE.md',
    'tokens.css',
    'components.html',
    'components.manifest.json',
    'design-tokens.json',
    'tailwind-v4.css',
  ];
  const directories = ['assets', 'preview', 'source', 'system', 'fonts'];
  const extensions = ['.md', '.json', '.html', '.css', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.otf'];
  if (value.split('/').some((part) => /(?:^|[-_])(?:oauth\d*|auth\d*|credentials?|secrets?|personal-auth|service[-_]account|token|session)(?:[-_.]|$)/i.test(part))) throw new Error('auth data');
  const fontLicense = value.startsWith('fonts/') && extname(value) === '.txt';
  if (!rootFiles.includes(value) && !(directories.includes(value.split('/')[0]!) && (extensions.includes(extname(value)) || fontLicense))) {
    throw new Error('unrelated file');
  }
  return value;
}
async function pinnedBytes(root: string, file: string): Promise<Buffer> {
  let current = root;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error('invalid file type');
  }
  const canonical = await realpath(current);
  if (!canonical.startsWith(`${root}${sep}`)) throw new Error('outside root');
  const info = await lstat(current);
  if (info.size > 16 * 1024 * 1024) throw new Error('oversized file');
  const bytes = await readFile(current);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('oversized file');
  return bytes;
}

/** Private, pinned study packets become read-only design systems in both UI and od. */
export async function copyTeamDesignSystems({ namespace, resourceRoot, env = process.env }: {
  namespace: string;
  resourceRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const configured = env.OD_TEAM_DESIGN_SYSTEMS_DIR?.trim();
  if (!configured) return;
  try {
    if (namespace !== 'team-internal') throw new Error('private namespace required');
    const root = await realpath(configured);
    const manifest = record(JSON.parse((await pinnedBytes(root, 'team-design-systems.json')).toString('utf8')));
    if (manifest.schema !== 'team-design-systems/1' || !Array.isArray(manifest.packages)
      || !manifest.packages.length || manifest.packages.length > 256) throw new Error('invalid inventory');
    const destination = join(resourceRoot, 'design-systems');
    const ids = new Set<string>();
    const pending: Array<{ id: string; files: Map<string, Buffer> }> = [];
    let totalBytes = 0;
    for (const input of manifest.packages) {
      const entry = record(input);
      const id = entry.id;
      if (typeof id !== 'string' || !/^study-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 120 || ids.has(id)
        || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 1024) throw new Error('invalid package');
      ids.add(id);
      try {
        await lstat(join(destination, id));
        throw new Error('existing system collision');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const packageRoot = join(root, id);
      const packageInfo = await lstat(packageRoot);
      if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error('invalid package directory');
      const files = new Map<string, Buffer>();
      for (const inputFile of entry.files) {
        const file = record(inputFile);
        const name = relativeFile(file.path);
        if (files.has(name) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0
          || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid pinned file');
        const bytes = await pinnedBytes(packageRoot, name);
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('changed file');
        // Original screenshot metadata can retain bearer tokens in capture URLs.
        if (['.json', '.md', '.html', '.css', '.svg'].includes(extname(name)) && /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(bytes.toString('utf8'))) throw new Error('capture token');
        totalBytes += bytes.length;
        if (totalBytes > 512 * 1024 * 1024) throw new Error('oversized kit');
        files.set(name, bytes);
      }
      for (const required of ['manifest.json', 'DESIGN.md', 'tokens.css']) {
        if (!files.has(required)) throw new Error('incomplete package');
      }
      const nativeManifest = record(JSON.parse(files.get('manifest.json')!.toString('utf8')));
      const nativeFiles = record(nativeManifest.files);
      if (nativeManifest.schemaVersion !== 'od-design-system-project/v1' || nativeManifest.id !== id
        || nativeFiles.design !== 'DESIGN.md' || nativeFiles.tokens !== 'tokens.css'
        || (nativeFiles.components !== undefined && nativeFiles.components !== 'components.html')) throw new Error('invalid native manifest');
      const references: unknown[] = [nativeFiles.components, nativeManifest.usage, nativeManifest.componentsManifest];
      if (nativeManifest.preview !== undefined) {
        const preview = record(nativeManifest.preview);
        if (preview.dir !== 'preview' || !Array.isArray(preview.pages)) throw new Error('invalid preview manifest');
        references.push(...preview.pages.map((page) => record(page).path));
      }
      if (nativeManifest.sourceFiles !== undefined) references.push(...Object.values(record(nativeManifest.sourceFiles)));
      if (nativeManifest.fonts !== undefined) {
        if (!Array.isArray(nativeManifest.fonts)) throw new Error('invalid font manifest');
        references.push(...nativeManifest.fonts.map((font) => record(font).file));
      }
      for (const file of references) {
        if (file !== undefined && !files.has(relativeFile(file))) throw new Error('missing referenced file');
      }
      pending.push({ id, files });
    }
    // Validate the complete collection before materializing any package.
    for (const entry of pending) {
      const hash = createHash('sha256');
      updateDesignSystemRevision(chunk => { hash.update(chunk); }, entry.files, { encode: text => Buffer.from(text, 'utf8'), decode: bytes => Buffer.from(bytes).toString('utf8') });
      const revision = hash.digest('hex');
      for (const [file, bytes] of entry.files) {
        const output = join(destination, entry.id, file);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, bytes);
      }
      // Seed only the complete, pinned collection admitted above, never runtime edits.
      const approvals = join(destination, '.approvals');
      await mkdir(approvals, { recursive: true });
      await writeFile(join(approvals, entry.id + '.json'), JSON.stringify({ approved: true, revision }) + '\n');
    }
  } catch {
    // Build logs must never echo private source contents or local collection paths.
    throw new Error('tools-pack: invalid private design-system kit or namespace');
  }
}
