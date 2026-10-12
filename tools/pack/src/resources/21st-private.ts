import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const assetName = /^[a-z0-9][a-z0-9.-]*\.(?:js|css)$/;
const hash = /^[a-f0-9]{64}$/;

/** Only pinned preview assets and their source manifest enter an opted-in private Mac build.
 * Personal tool homes, dependencies, and unrelated files are never copied. */
export async function copyPrivate21stKit({ namespace, workspaceRoot, resourceRoot, env = process.env }: {
  namespace: string;
  workspaceRoot: string;
  resourceRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const destination = join(resourceRoot, 'data', 'component-kits', '21st-private');
  const directory = env.OD_TEAM_21ST_PREVIEW_DIR;
  if (!directory) {
    await rm(destination, { recursive: true, force: true });
    return;
  }
  try {
    if (namespace !== 'team-internal') throw new Error();
    const root = await realpath(directory);
    async function readPinned(name: string, limit: number): Promise<Buffer> {
      const file = join(root, name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > limit
        || dirname(await realpath(file)) !== root) throw new Error();
      const bytes = await readFile(file);
      if (bytes.length !== stat.size) throw new Error();
      return bytes;
    }
    const bytes = await readPinned('preview-manifest.json', 16 * 1024 * 1024);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const inventory = JSON.parse(await readFile(join(workspaceRoot, 'packages', '21st-catalog', 'generated', '21st-items.json'), 'utf8'));
    const known = new Set(inventory.rows.map((row: { id: string }) => row.id));
    if (manifest.schema !== '21st-private-previews/1' || !Array.isArray(manifest.items)
      || manifest.items.length !== known.size || manifest.items.length > 128) throw new Error();
    const ids = new Set<string>();
    const assets = new Map<string, Buffer>();
    const entries = [];
    for (const entry of manifest.items) {
      if (!known.has(entry.id) || ids.has(entry.id) || typeof entry.title !== 'string'
        || typeof entry.description !== 'string' || entry.sourceVerified !== true
        || typeof entry.slug !== 'string' || !/^[a-z0-9-]+$/.test(entry.slug) || !hash.test(entry.sourceSha256)
        || !Array.isArray(entry.sourceFiles) || !entry.sourceFiles.length || entry.sourceFiles.length > 128) throw new Error();
      ids.add(entry.id);
      const paths = new Set<string>();
      let sourceBytes = 0;
      for (const file of entry.sourceFiles) {
        if (typeof file.path !== 'string' || !file.path || file.path.length > 512
          || !/^[A-Za-z0-9_.@()+ -]+(?:\/[A-Za-z0-9_.@()+ -]+)*$/.test(file.path)
          || file.path.split('/').some((part: string) => part === '.' || part === '..' || part.trim() !== part || part.endsWith('.'))
          || paths.has(file.path) || typeof file.content !== 'string' || !hash.test(file.sha256)
          || digest(file.content) !== file.sha256) throw new Error();
        paths.add(file.path);
        const size = Buffer.byteLength(file.content, 'utf8'); sourceBytes += size;
        if (size > 2 * 1024 * 1024 || sourceBytes > 8 * 1024 * 1024) throw new Error();
      }
      if (digest(entry.sourceFiles.map((file: { path: string; sha256: string }) => `${file.path}\0${file.sha256}\n`).join('')) !== entry.sourceSha256) throw new Error();
      if (entry.primarySourcePath !== undefined && !paths.has(entry.primarySourcePath)) throw new Error();
      for (const kind of ['script', 'style'] as const) {
        const name = entry.assets?.[kind];
        if (typeof name !== 'string' || !assetName.test(name) || !name.endsWith(kind === 'script' ? '.js' : '.css')
          || !hash.test(entry.assetSha256?.[kind])) throw new Error();
        const content = assets.get(name) ?? await readPinned(name, 32 * 1024 * 1024);
        if (digest(content) !== entry.assetSha256[kind]) throw new Error();
        assets.set(name, content);
      }
      entries.push({ id: entry.id, slug: entry.slug, title: entry.title, description: entry.description,
        sourceVerified: true, sourceSha256: entry.sourceSha256,
        sourceFiles: entry.sourceFiles.map((file: { path: string; content: string; sha256: string }) => ({ path: file.path, content: file.content, sha256: file.sha256 })),
        ...(entry.primarySourcePath === undefined ? {} : { primarySourcePath: entry.primarySourcePath }),
        assets: { script: entry.assets.script, style: entry.assets.style },
        assetSha256: { script: entry.assetSha256.script, style: entry.assetSha256.style } });
    }
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'preview-manifest.json'), JSON.stringify({ schema: manifest.schema, items: entries }));
    for (const [name, content] of assets) await writeFile(join(destination, name), content);
  } catch {
    throw new Error('tools-pack: invalid or incomplete private 21st preview kit or namespace');
  }
}
