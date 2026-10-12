import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { designSystemRevisionMetadata, updateDesignSystemRevisionFile, type DesignSystemApproval } from '@open-design/contracts';
import { contentStats } from './listing-cache.js';

type Inspection = { revision: string; linkedFiles: string[]; invalidMetadata: boolean };
const revisionCache = new Map<string, { fingerprint: string; inspection: Inspection; time: number }>();

function directoryId(id: string): string {
  const dir = id.replace(/^user:/, '');
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(dir) || dir === '..') throw new Error('Invalid design system id');
  return dir;
}
/** Hash generation content. Root runtime bookkeeping does not change a kit. */
async function inspectRevision(dir: string, fresh = false, captured?: Map<string, Buffer>): Promise<Inspection> {
  const fingerprint = await contentStats(dir);
  const cached = revisionCache.get(dir);
  if (!fresh && fingerprint !== 'unreadable' && cached?.fingerprint === fingerprint && performance.now() - cached.time < 60_000) return cached.inspection;
  const hash = createHash('sha256');
  const linkedFiles: string[] = [];
  function add(relative: string, bytes: Buffer) {
    updateDesignSystemRevisionFile(chunk => { hash.update(chunk); }, relative, bytes);
    captured?.set(relative, bytes);
  }
  let metadataBytes: Buffer | undefined;
  try { metadataBytes = await readFile(path.join(dir, 'metadata.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const metadata = designSystemRevisionMetadata(metadataBytes, { encode: text => Buffer.from(text, 'utf8'), decode: bytes => Buffer.from(bytes).toString('utf8') });
  // Normal inspections stream assets; only staging needs to retain the capture.
  add('metadata.json', Buffer.from(metadata.bytes));
  const invalidMetadata = metadata.invalid;
  async function visit(base: string, prefix = ''): Promise<void> {
    const entries = (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (!prefix && ['.git', 'node_modules', 'metadata.json', 'revisions', '.od-team-resource.json'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) {
        linkedFiles.push(relative);
        add(relative, Buffer.from('symlink:' + await readlink(path.join(base, entry.name))));
      } else if (entry.isDirectory()) await visit(path.join(base, entry.name), relative + '/');
      else if (entry.isFile()) add(relative, await readFile(path.join(base, entry.name)));
    }
  }
  await visit(dir);
  const inspection = { revision: hash.digest('hex'), linkedFiles, invalidMetadata };
  // A change during hashing must never populate a reusable entry.
  if (fingerprint !== 'unreadable' && await contentStats(dir) === fingerprint) {
    if (revisionCache.size >= 512) revisionCache.delete(revisionCache.keys().next().value!);
    revisionCache.set(dir, { fingerprint, inspection, time: performance.now() });
  } else revisionCache.delete(dir);
  return inspection;
}
/** The revision and assets derive from one capture; later reads cannot replace its bytes. */
export async function readDesignSystemSnapshot(dir: string): Promise<{ revision: string; files: ReadonlyMap<string, Buffer> }> {
  const files = new Map<string, Buffer>();
  const inspection = await inspectRevision(dir, true, files);
  if (inspection.linkedFiles.length || inspection.invalidMetadata) throw new Error('Design kit contains linked files or invalid metadata');
  return { revision: inspection.revision, files };
}
export async function designSystemRevision(dir: string): Promise<string> {
  return (await inspectRevision(dir, true)).revision;
}
function receiptPath(root: string, id: string): string {
  return path.join(root, '.approvals', directoryId(id) + '.json');
}
export async function readDesignSystemApproval(root: string, id: string, receiptRoot = root, seedRevision?: string, fresh = false, packagedSeed = false): Promise<DesignSystemApproval> {
  const { revision, linkedFiles, invalidMetadata } = await inspectRevision(path.join(root, directoryId(id)), fresh);
  let approvedRevision: string | undefined = seedRevision;
  if (packagedSeed && receiptRoot !== root) {
    try {
      const seed = JSON.parse(await readFile(receiptPath(root, id), 'utf8'));
      if (seed.approved === true && typeof seed.revision === 'string') approvedRevision = seed.revision;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    const receipt = JSON.parse(await readFile(receiptPath(receiptRoot, id), 'utf8'));
    if (receipt.approved === true && typeof receipt.revision === 'string') {
      // A stale positive decision cannot veto a newly vetted seed. A negative
      // local decision remains authoritative across publication updates.
      if (receipt.revision === revision || approvedRevision !== revision) approvedRevision = receipt.revision;
    } else approvedRevision = undefined;
  } catch (error) {
    if (error instanceof SyntaxError) approvedRevision = undefined;
    else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { status: !invalidMetadata && !linkedFiles.length && revision === approvedRevision ? 'approved' : 'unreviewed', revision, ...(approvedRevision ? { approvedRevision } : {}) };
}
export async function setDesignSystemApproval(root: string, id: string, approved: boolean, expectedRevision: string, receiptRoot = root): Promise<DesignSystemApproval> {
  if (approved) {
    const inspection = await inspectRevision(path.join(root, directoryId(id)), true);
    if (inspection.linkedFiles.length) throw new Error('Materialize linked kit files before approval');
    if (inspection.invalidMetadata) throw new Error('Repair kit metadata before approval');
  }
  const current = await readDesignSystemApproval(root, id, receiptRoot, undefined, true);
  if (current.revision !== expectedRevision) throw new Error('DESIGN_SYSTEM_REVISION_CONFLICT');
  const target = receiptPath(receiptRoot, id);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ approved, revision: current.revision }) + '\n', { flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return readDesignSystemApproval(root, id, receiptRoot, undefined, true);
}

/** Only the authenticated Team publication path may supply this seed. Imported
 * kit files and metadata never grant approval. Local overrides stay separate. */
export async function syncPublishedDesignSystemApproval(root: string, id: string, publishedRevision?: string): Promise<void> {
  const current = await inspectRevision(path.join(root, directoryId(id)), true);
  const approved = typeof publishedRevision === 'string'
    && /^[a-f0-9]{64}$/.test(publishedRevision)
    && current.revision === publishedRevision
    && !current.invalidMetadata
    && current.linkedFiles.length === 0;
  await setDesignSystemApproval(root, id, approved, current.revision);
}
