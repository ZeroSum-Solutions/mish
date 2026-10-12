// GitHub access for licensed-pack downloads (Licensed Pack plan, Phase 1 item 3).
//
// Resolves the token the pack fetcher (`packs/github-fetcher.ts`) sends to
// api.github.com, and owns the one-time pasted-token store that P1-2's routes
// and `od pack auth` call. Four sources, first available wins:
//
//   1. the token the user pasted once (Settings → Licensed packs, or the CLI),
//      stored at `<packsDir>/.credentials/github.json`;
//   2. `GH_TOKEN`, then 3. `GITHUB_TOKEN` (gh's own order);
//   4. `gh auth token --hostname github.com`, spawned through the canonical
//      `execGhBuffered` with a static argv, so no token is ever in argv and a
//      GH_HOST enterprise token is never sent to api.github.com.
//
// A pasted token wins over a `gh` login because it is the user's explicit
// choice, and the `gh` account may have no pack access. There is no
// fall-through after a 401/404: the first available token is the one used.
//
// Invariants:
//   - No function here logs, and no return value or error carries a token,
//     a prefix of one, or a tail of one. `status()` reports only the source.
//   - `resolveToken()` and `status()` never throw; a broken source counts as
//     "no token from that source".
//   - The store matches the connector credential store's bar
//     (`connectors/service.ts` `FileConnectorCredentialStore`): plaintext JSON,
//     directory 0700, file 0600, temp file then rename. No at-rest encryption.
//   - The store never follows a symlink: `.credentials` must be a real
//     directory owned by this uid before it is written, and a real directory
//     owned by this uid with mode 0700 before it is read or cleared (a read
//     treats any other layout as "no token"; a clear refuses with
//     CREDENTIAL_STORE_UNSAFE). Every open uses
//     O_NOFOLLOW, and a stored file that is a symlink, not a regular file, or
//     not mode 0600 counts as "no token" (POSIX; Windows has no such modes).

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';

import { execGhBuffered } from '../services/login-shell.js';

export type PackGithubTokenSource = 'stored' | 'env' | 'gh-cli';

export interface PackGithubAccessStatus {
  configured: boolean;
  source: PackGithubTokenSource | 'none';
}

export interface ResolvedPackGithubToken {
  token: string;
  source: PackGithubTokenSource;
}

export interface PackGithubAccess {
  /** Which source is in effect. Never includes the token or any part of it. */
  status(): Promise<PackGithubAccessStatus>;
  /** Validates the shape, then stores it. Rejects with `INVALID_TOKEN_FORMAT`, never echoing the input. */
  storePastedToken(token: string): Promise<void>;
  /** Removes the stored paste. A no-op when nothing is stored. */
  clearStoredToken(): Promise<void>;
  /** The token the fetcher sends, or null when no source has one. Never throws. */
  resolveToken(): Promise<ResolvedPackGithubToken | null>;
}

export type PackGithubAccessErrorCode = 'INVALID_TOKEN_FORMAT' | 'CREDENTIAL_STORE_UNSAFE';

/** The only error this module throws to callers. The message is a fixed template. */
export class PackGithubAccessError extends Error {
  readonly code: PackGithubAccessErrorCode;

  constructor(code: PackGithubAccessErrorCode) {
    super(PACK_GITHUB_ACCESS_MESSAGES[code]);
    this.name = 'PackGithubAccessError';
    this.code = code;
  }
}

const PACK_GITHUB_ACCESS_MESSAGES: Record<PackGithubAccessErrorCode, string> = {
  INVALID_TOKEN_FORMAT:
    'not a GitHub token: paste a fine-grained token (github_pat_…) or a classic token (ghp_…)',
  CREDENTIAL_STORE_UNSAFE: 'the pack credential folder is not a private directory owned by this user',
};

/** Shapes GitHub issues today: classic/OAuth/app tokens and fine-grained PATs. */
export const GITHUB_TOKEN_PATTERN = /^(gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,255})$/;

/** Env and `gh` tokens are not shape-checked (older formats still work), only made header-safe. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]{1,1024}$/;

export const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;
/**
 * Pinned to github.com: the fetcher only talks to api.github.com, so a
 * `GH_HOST` (GitHub Enterprise) login must never supply the token.
 */
const GH_AUTH_TOKEN_ARGV = ['auth', 'token', '--hostname', 'github.com'] as const;

const CREDENTIALS_DIR = '.credentials';
const CREDENTIALS_FILE = 'github.json';
const TEMP_FILE_RE = /^\.github\.json\.[0-9a-f]+\.tmp$/;
const IS_POSIX = process.platform !== 'win32';
/** 0 on Windows, where O_NOFOLLOW does not exist. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const STORED_FILE_MODE = 0o600;

interface StoredGithubCredential {
  schemaVersion: 1;
  token: string;
  updatedAt: string;
}

export function packGithubCredentialPath(packsDir: string): string {
  return path.join(packsDir, CREDENTIALS_DIR, CREDENTIALS_FILE);
}

export function createPackGithubAccess(deps: {
  /** P1-1's PACKS_DIR (derived from RUNTIME_DATA_DIR). Required, absolute; there is no default. */
  packsDir: string;
  execGh?: typeof execGhBuffered;
  env?: NodeJS.ProcessEnv;
}): PackGithubAccess {
  if (typeof deps.packsDir !== 'string' || !path.isAbsolute(deps.packsDir)) {
    throw new TypeError('createPackGithubAccess needs an absolute packsDir');
  }
  const credentialPath = packGithubCredentialPath(deps.packsDir);
  const credentialDir = path.dirname(credentialPath);
  const execGh = deps.execGh ?? execGhBuffered;
  const env = deps.env ?? process.env;

  async function readStored(): Promise<string | null> {
    let raw: string;
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      if ((await credentialDirState(credentialDir)) !== 'private') return null;
      // O_NOFOLLOW: a symlinked github.json fails to open (ELOOP) and counts as no token.
      handle = await fsp.open(credentialPath, fsConstants.O_RDONLY | O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) return null;
      if (IS_POSIX && (info.mode & 0o777) !== STORED_FILE_MODE) return null;
      raw = await handle.readFile('utf8');
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== 1) return null;
      if (typeof record.token !== 'string' || !GITHUB_TOKEN_PATTERN.test(record.token)) return null;
      return record.token;
    } catch {
      return null;
    }
  }

  function readEnv(): string | null {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      const value = env[name]?.trim();
      if (value && HEADER_SAFE_TOKEN.test(value)) return value;
    }
    return null;
  }

  async function readGhCli(): Promise<string | null> {
    try {
      const result = await execGh(GH_AUTH_TOKEN_ARGV, { timeout: GH_AUTH_TOKEN_TIMEOUT_MS });
      if (!result.ok) return null;
      const value = result.stdout.trim();
      return HEADER_SAFE_TOKEN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function resolveToken(): Promise<ResolvedPackGithubToken | null> {
    const stored = await readStored();
    if (stored) return { token: stored, source: 'stored' };
    const fromEnv = readEnv();
    if (fromEnv) return { token: fromEnv, source: 'env' };
    const fromGh = await readGhCli();
    if (fromGh) return { token: fromGh, source: 'gh-cli' };
    return null;
  }

  return {
    resolveToken,

    async status() {
      const resolved = await resolveToken();
      return resolved ? { configured: true, source: resolved.source } : { configured: false, source: 'none' };
    },

    async storePastedToken(token: string) {
      const value = typeof token === 'string' ? token.trim() : '';
      if (!GITHUB_TOKEN_PATTERN.test(value)) throw new PackGithubAccessError('INVALID_TOKEN_FORMAT');

      await fsp.mkdir(credentialDir, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(credentialDir);
      // mkdir's mode does not touch a directory that already exists.
      await fsp.chmod(credentialDir, 0o700);
      const record: StoredGithubCredential = { schemaVersion: 1, token: value, updatedAt: new Date().toISOString() };
      const tempPath = path.join(credentialDir, `.${CREDENTIALS_FILE}.${randomBytes(8).toString('hex')}.tmp`);
      let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
      try {
        handle = await fsp.open(
          tempPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
          STORED_FILE_MODE,
        );
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.chmod(STORED_FILE_MODE);
        await handle.close();
        handle = undefined;
        await fsp.rename(tempPath, credentialPath);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async clearStoredToken() {
      const state = await credentialDirState(credentialDir);
      if (state === 'missing') return;
      if (state === 'unsafe') throw new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE');
      await fsp.rm(credentialPath, { force: true });
      // Temp files a crash left between write and rename.
      let names: string[];
      try {
        names = await fsp.readdir(credentialDir);
      } catch {
        return;
      }
      await Promise.all(
        names.filter((name) => TEMP_FILE_RE.test(name)).map((name) => fsp.rm(path.join(credentialDir, name), { force: true })),
      );
    },
  };
}

/** `.credentials` must be a real directory (not a symlink) owned by the daemon's uid. */
async function assertPrivateDirectory(dir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    info = await fsp.lstat(dir);
  } catch {
    throw new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE');
  }
  if (!info.isDirectory()) throw new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE');
  const uid = process.getuid?.();
  if (IS_POSIX && uid !== undefined && info.uid !== uid) throw new PackGithubAccessError('CREDENTIAL_STORE_UNSAFE');
}

/**
 * Read and clear accept `.credentials` only as a real directory (lstat, so a
 * symlink fails) owned by the daemon's uid with mode 0700. Windows has no such
 * owner or modes, so there it only has to exist.
 */
async function credentialDirState(dir: string): Promise<'private' | 'missing' | 'unsafe'> {
  if (!IS_POSIX) return 'private';
  let info: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    info = await fsp.lstat(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (!info.isDirectory()) return 'unsafe';
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return 'unsafe';
  if ((info.mode & 0o777) !== 0o700) return 'unsafe';
  return 'private';
}
