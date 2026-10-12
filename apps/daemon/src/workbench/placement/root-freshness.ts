import { WORKBENCH_ADOPTION_HELPER_LAYOUT, WORKBENCH_ADOPTION_ROOT_RECORD } from '@open-design/contracts';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { OWNER_FILE_NAME } from './owner-binding.js';

/**
 * B4-1: proof that an existing data root is still fresh. The supported
 * `tools-dev --placement-adoption-executor` path creates the data root to
 * build the adoption helper into it before the daemon boots, so the
 * coordinated bootstrap's own mkdir finds it existing. tools-dev records its
 * creation (`WORKBENCH_ADOPTION_ROOT_RECORD`, bound to the root's device and
 * inode). A recorded root counts as created by this boot only while it holds
 * nothing but that record and the helper tree: no database, no projects and
 * no native owner lock, so no earlier daemon (ordinary or coordinated) has
 * used it and no predecessor's children can be writing under it. Everything
 * is read without following symlinks. The record is consumed by the boot that
 * accepts it, so it never vouches for a later boot.
 */
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
const privateEntry = (stat: { uid: number; mode: number }) => stat.uid === currentUid() && (stat.mode & 0o022) === 0;

/** Entries of a real, private directory, or null. */
function privateDirectory(directory: string): string[] | null {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || !privateEntry(stat)) return null;
    return readdirSync(directory);
  } catch { return null; }
}
function isPrivateFile(file: string): boolean {
  try { const stat = lstatSync(file); return stat.isFile() && privateEntry(stat) && stat.nlink === 1; } catch { return false; }
}
function readRecord(file: string): unknown {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateEntry(stat) || stat.nlink !== 1 || stat.size > 4096) return null;
    const bytes = Buffer.alloc(stat.size); let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch { return null; }
  finally { closeSync(fd); }
}
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(value);

/**
 * The recorded identity when `root` is a recorded, still-pristine root;
 * otherwise null. The caller compares it with the identity it observed.
 */
export function proveRecordedFreshRoot(root: string, options: { ownerLockFromThisBoot?: boolean } = {}): { device: string; inode: string } | null {
  const rootEntries = privateDirectory(root);
  if (!rootEntries) return null;
  const [toolParent, toolLeaf] = WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir;
  // The owner lock is accepted only on the re-check right after this boot acquired it; the
  // proof taken before acquisition must already hold without it (an earlier boot leaves one).
  const allowedRoot = new Set([WORKBENCH_ADOPTION_ROOT_RECORD.name, toolParent, ...(options.ownerLockFromThisBoot ? [OWNER_FILE_NAME] : [])]);
  if (!rootEntries.includes(WORKBENCH_ADOPTION_ROOT_RECORD.name) || !rootEntries.every(entry => allowedRoot.has(entry))) return null;
  if (rootEntries.includes(toolParent)) {
    const parentEntries = privateDirectory(path.join(root, toolParent));
    if (!parentEntries || !parentEntries.every(entry => entry === toolLeaf)) return null;
    if (parentEntries.includes(toolLeaf)) {
      const toolDir = path.join(root, toolParent, toolLeaf);
      const toolEntries = privateDirectory(toolDir);
      const allowedTool = new Set<string>([WORKBENCH_ADOPTION_HELPER_LAYOUT.binary, WORKBENCH_ADOPTION_HELPER_LAYOUT.record]);
      if (!toolEntries || !toolEntries.every(entry => allowedTool.has(entry) && isPrivateFile(path.join(toolDir, entry)))) return null;
    }
  }
  const record = readRecord(path.join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name));
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const fields = record as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'creator,device,inode,schema' || fields.schema !== WORKBENCH_ADOPTION_ROOT_RECORD.schema
    || fields.creator !== 'tools-dev' || !decimal(fields.device) || !decimal(fields.inode)) return null;
  try {
    const stat = lstatSync(root, { bigint: true });
    if (String(stat.dev) !== fields.device || String(stat.ino) !== fields.inode) return null;
  } catch { return null; }
  return { device: fields.device, inode: fields.inode };
}

/** Removes the record so it cannot vouch for a later boot. True only when this call removed a regular file. */
export function consumeRootCreationRecord(root: string): boolean {
  const file = path.join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name);
  try {
    if (!lstatSync(file).isFile()) return false;
    unlinkSync(file);
    return true;
  } catch { return false; }
}
