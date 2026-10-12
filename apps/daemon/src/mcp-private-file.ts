import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Replace a credential file without following an existing symlink or exposing a temp file. */
export async function writePrivateMcpFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let created = false;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(contents, 'utf8'); }
    finally { await handle.close(); }
    await rename(tmp, file);
  } catch (err) {
    if (created) await rm(tmp, { force: true });
    throw err;
  }
}

const CREDENTIAL_FILES = {
  config: 'mcp-config.json',
  tokens: 'mcp-tokens.json',
  'client-cache': 'mcp-oauth-clients.json',
} as const;
export type McpCredentialStore = keyof typeof CREDENTIAL_FILES;
export type McpOAuthCredentialStore = Exclude<McpCredentialStore, 'config'>;

export class McpCredentialFileError extends Error {
  readonly code = 'MCP_CREDENTIAL_FILE_UNSAFE';
  readonly store: McpCredentialStore | undefined;
  readonly file: string | undefined;
  constructor(file: string) {
    const store = (Object.keys(CREDENTIAL_FILES) as McpCredentialStore[]).find(key => CREDENTIAL_FILES[key] === path.basename(file));
    const basename = store ? CREDENTIAL_FILES[store] : undefined;
    super(`${basename ?? 'Saved MCP credentials'} cannot be read securely. Open Settings → External MCP servers. ${store === 'config'
      ? 'Replace the configuration with all connection values entered again, or restore a private file owned by this user.'
      : 'Restore a private file owned by this user or explicitly reset this saved OAuth store.'}`);
    this.name = 'McpCredentialFileError';
    this.store = store;
    this.file = basename;
  }
}

/** Check ownership/permissions without consuming credentials; also used to reject needless resets. */
async function openPrivateMcpFile(file: string) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw error;
    throw new McpCredentialFileError(file);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new McpCredentialFileError(file);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    return handle;
  } catch {
    await handle.close();
    throw new McpCredentialFileError(file);
  }
}

/** Tighten legacy credentials through the opened file; never follow or chmod a symlink target. */
export async function readPrivateMcpFile(file: string): Promise<string> {
  const handle = await openPrivateMcpFile(file);
  try { return await handle.readFile('utf8'); }
  catch { throw new McpCredentialFileError(file); }
  finally { await handle.close(); }
}

const credentialLocks = new Map<string, Promise<unknown>>();
/** Reads that lead to a token/cache mutation and explicit repair share one per-file lock. */
export async function withPrivateMcpFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(file) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  credentialLocks.set(file, task);
  try { return await task; }
  finally { if (credentialLocks.get(file) === task) credentialLocks.delete(file); }
}

export class McpCredentialResetError extends Error {
  constructor(readonly code: 'MCP_CREDENTIAL_RESET_NOT_NEEDED' | 'MCP_CREDENTIAL_RESET_FAILED') {
    super(code === 'MCP_CREDENTIAL_RESET_NOT_NEEDED'
      ? 'This OAuth store is missing or already securely readable. Nothing was reset.'
      : 'Could not reset the OAuth store. The original entry is preserved for owner repair.');
    this.name = 'McpCredentialResetError';
  }
}

/** Explicit repair preserves the entry itself; it never reads/follows an unsafe link target. */
export async function resetUnsafeMcpOAuthStore(dataDir: string, store: McpOAuthCredentialStore): Promise<void> {
  const file = path.join(dataDir, CREDENTIAL_FILES[store]);
  await withPrivateMcpFileLock(file, async () => {
    try {
      const handle = await openPrivateMcpFile(file);
      await handle.close();
      throw new McpCredentialResetError('MCP_CREDENTIAL_RESET_NOT_NEEDED');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') throw new McpCredentialResetError('MCP_CREDENTIAL_RESET_NOT_NEEDED');
      if (!(error instanceof McpCredentialFileError)) throw error;
    }
    let quarantine: string | undefined;
    let moved = false;
    try {
      const root = path.join(dataDir, 'mcp-credential-recovery');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
        || (process.getuid && rootInfo.uid !== process.getuid())
        || (process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0)) {
        throw new McpCredentialResetError('MCP_CREDENTIAL_RESET_FAILED');
      }
      quarantine = await mkdtemp(path.join(root, 'entry-'));
      const preserved = path.join(quarantine, CREDENTIAL_FILES[store]);
      await rename(file, preserved);
      moved = true;
      try {
        await writePrivateMcpFile(file, JSON.stringify(store === 'tokens' ? { servers: {} } : { clients: [] }, null, 2));
      } catch {
        // Never overwrite an entry created by another local writer during failed replacement.
        try {
          await lstat(file);
        } catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') {
            await rename(preserved, file);
            moved = false;
          }
        }
        throw new McpCredentialResetError('MCP_CREDENTIAL_RESET_FAILED');
      }
    } catch {
      if (quarantine && !moved) await rm(quarantine, { recursive: true, force: true }).catch(() => {});
      throw new McpCredentialResetError('MCP_CREDENTIAL_RESET_FAILED');
    }
  });
}
