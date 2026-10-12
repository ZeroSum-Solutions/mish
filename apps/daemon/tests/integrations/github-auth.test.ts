// P1-3 spec 5: the pack GitHub token resolver and its pasted-token store.
//
// No real token appears here. Every token-shaped value is assembled at runtime
// from repeated characters, so no committed line matches a token pattern.

import type { ExecFileOptions } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPackGithubAccess,
  GH_AUTH_TOKEN_TIMEOUT_MS,
  packGithubCredentialPath,
  PackGithubAccessError,
} from '../../src/integrations/github-auth.js';
import type { BufferedCommandResult } from '../../src/services/login-shell.js';

const STORED = `ghp_${'S'.repeat(36)}`;
const FINE_GRAINED = `github_pat_${'F'.repeat(22)}_${'f'.repeat(59)}`;
const GH_TOKEN_VALUE = `ghp_${'E'.repeat(36)}`;
const GITHUB_TOKEN_VALUE = `ghs_${'G'.repeat(36)}`;
const GH_CLI_VALUE = `gho_${'C'.repeat(36)}`;

type ExecGh = (args: readonly string[], opts?: ExecFileOptions) => Promise<BufferedCommandResult>;

function ghResult(partial: Partial<BufferedCommandResult>): BufferedCommandResult {
  return { ok: true, code: 0, stdout: '', stderr: '', error: null, ...partial };
}

function fakeGh(result: BufferedCommandResult | (() => Promise<BufferedCommandResult>)) {
  const calls: { args: readonly string[]; opts: ExecFileOptions | undefined }[] = [];
  const execGh: ExecGh = async (args, opts) => {
    calls.push({ args: [...args], opts });
    return typeof result === 'function' ? result() : result;
  };
  return { execGh, calls };
}

let packsDir: string;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p1-3-auth-'));
  packsDir = path.join(root, 'packs');
});

afterEach(async () => {
  await rm(path.dirname(packsDir), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveGithubToken (P1-3 spec 5)', () => {
  it('prefers the stored paste, then GH_TOKEN, then GITHUB_TOKEN, then gh auth token', async () => {
    const gh = fakeGh(ghResult({ stdout: GH_CLI_VALUE }));
    const env: NodeJS.ProcessEnv = { GH_TOKEN: GH_TOKEN_VALUE, GITHUB_TOKEN: GITHUB_TOKEN_VALUE };
    const access = createPackGithubAccess({ packsDir, execGh: gh.execGh, env });

    await access.storePastedToken(STORED);
    expect(await access.resolveToken()).toEqual({ token: STORED, source: 'stored' });

    await access.clearStoredToken();
    expect(await access.resolveToken()).toEqual({ token: GH_TOKEN_VALUE, source: 'env' });

    delete env.GH_TOKEN;
    expect(await access.resolveToken()).toEqual({ token: GITHUB_TOKEN_VALUE, source: 'env' });

    delete env.GITHUB_TOKEN;
    expect(await access.resolveToken()).toEqual({ token: GH_CLI_VALUE, source: 'gh-cli' });
    // gh is consulted only once every earlier source is empty.
    expect(gh.calls).toHaveLength(1);
  });

  it('returns null when no source has a token, and never throws on a failing gh', async () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: '   ', GITHUB_TOKEN: '' };
    const failing = fakeGh(ghResult({ ok: false, code: 1, stderr: 'not logged in', error: new Error('exit 1') }));
    expect(await createPackGithubAccess({ packsDir, execGh: failing.execGh, env }).resolveToken()).toBeNull();

    const empty = fakeGh(ghResult({ stdout: '' }));
    expect(await createPackGithubAccess({ packsDir, execGh: empty.execGh, env }).resolveToken()).toBeNull();

    const garbage = fakeGh(ghResult({ stdout: 'line one\nline two' }));
    expect(await createPackGithubAccess({ packsDir, execGh: garbage.execGh, env }).resolveToken()).toBeNull();

    const rejecting = fakeGh(() => Promise.reject(new Error('spawn failed')));
    expect(await createPackGithubAccess({ packsDir, execGh: rejecting.execGh, env }).resolveToken()).toBeNull();
  });

  it('spawns gh with the static argv [auth, token, --hostname, github.com] and a 5 s timeout', async () => {
    const gh = fakeGh(ghResult({ stdout: GH_CLI_VALUE }));
    // Sol #191: pinned to github.com, so a GH_HOST enterprise token never goes to api.github.com.
    await createPackGithubAccess({ packsDir, execGh: gh.execGh, env: { GH_HOST: 'ghe.example.test' } }).resolveToken();
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(GH_AUTH_TOKEN_TIMEOUT_MS).toBe(5_000);
    expect(gh.calls[0]?.opts?.timeout).toBe(GH_AUTH_TOKEN_TIMEOUT_MS);
  });

  it('ignores a stored file that is malformed, has the wrong schema, or holds a malformed token', async () => {
    const gh = fakeGh(ghResult({ ok: false, code: 1 }));
    const access = createPackGithubAccess({ packsDir, execGh: gh.execGh, env: {} });
    const file = packGithubCredentialPath(packsDir);
    await mkdir(path.dirname(file), { recursive: true });

    for (const body of [
      'not json',
      JSON.stringify([STORED]),
      JSON.stringify({ schemaVersion: 2, token: STORED, updatedAt: 'x' }),
      JSON.stringify({ schemaVersion: 1, token: 'short', updatedAt: 'x' }),
      JSON.stringify({ schemaVersion: 1, token: 42, updatedAt: 'x' }),
    ]) {
      await writeFile(file, body);
      expect(await access.resolveToken()).toBeNull();
      expect(await access.status()).toEqual({ configured: false, source: 'none' });
    }
  });
});

describe('status() (P1-3 spec 5)', () => {
  it('names the source in effect and never contains the token or any part of it', async () => {
    const gh = fakeGh(ghResult({ stdout: GH_CLI_VALUE }));
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: GITHUB_TOKEN_VALUE };
    const access = createPackGithubAccess({ packsDir, execGh: gh.execGh, env });

    await access.storePastedToken(STORED);
    const stored = await access.status();
    expect(stored).toEqual({ configured: true, source: 'stored' });

    await access.clearStoredToken();
    const fromEnv = await access.status();
    expect(fromEnv).toEqual({ configured: true, source: 'env' });

    delete env.GITHUB_TOKEN;
    const fromGh = await access.status();
    expect(fromGh).toEqual({ configured: true, source: 'gh-cli' });

    const none = await createPackGithubAccess({
      packsDir,
      execGh: fakeGh(ghResult({ ok: false, code: 1 })).execGh,
      env: {},
    }).status();
    expect(none).toEqual({ configured: false, source: 'none' });

    const serialized = JSON.stringify([stored, fromEnv, fromGh, none]);
    for (const token of [STORED, GITHUB_TOKEN_VALUE, GH_CLI_VALUE]) {
      // No prefix and no tail of any token, not even six characters.
      const body = token.slice(4);
      expect(serialized).not.toContain(body.slice(0, 6));
      expect(serialized).not.toContain(body.slice(-6));
    }
  });
});

describe('storePastedToken / clearStoredToken (P1-3 spec 5)', () => {
  it('writes <packsDir>/.credentials/github.json with 0600 under a 0700 dir, atomically', async () => {
    const access = createPackGithubAccess({ packsDir, execGh: fakeGh(ghResult({ ok: false })).execGh, env: {} });
    await access.storePastedToken(`  ${FINE_GRAINED}\n`);

    const file = packGithubCredentialPath(packsDir);
    expect(file).toBe(path.join(packsDir, '.credentials', 'github.json'));
    const dirMode = (await stat(path.dirname(file))).mode & 0o777;
    const fileMode = (await stat(file)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(record.schemaVersion).toBe(1);
    expect(record.token).toBe(FINE_GRAINED);
    expect(typeof record.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(record.updatedAt as string))).toBe(false);
    // Temp-file-then-rename leaves no temp file behind.
    expect(await readdir(path.dirname(file))).toEqual(['github.json']);

    // Replacing the token keeps the same modes.
    await access.storePastedToken(STORED);
    expect((JSON.parse(await readFile(file, 'utf8')) as { token: string }).token).toBe(STORED);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('tightens a pre-existing .credentials dir to 0700', async () => {
    if (process.platform === 'win32') return;
    await mkdir(path.join(packsDir, '.credentials'), { recursive: true, mode: 0o755 });
    const access = createPackGithubAccess({ packsDir, execGh: fakeGh(ghResult({ ok: false })).execGh, env: {} });
    await access.storePastedToken(STORED);
    expect((await stat(path.join(packsDir, '.credentials'))).mode & 0o777).toBe(0o700);
  });

  it('refuses a malformed token with INVALID_TOKEN_FORMAT without echoing it, and writes nothing', async () => {
    const access = createPackGithubAccess({ packsDir, execGh: fakeGh(ghResult({ ok: false })).execGh, env: {} });
    const malformed = [
      'not-a-token-value-1234567890',
      `ghp_${'A'.repeat(35)}`,
      `ghx_${'A'.repeat(36)}`,
      `ghp_${'A'.repeat(36)}\r\nX-Injected: 1`,
      `github_pat_${'A'.repeat(21)}`,
      `ghp_${'A'.repeat(18)}-${'A'.repeat(18)}`,
      '',
    ];
    for (const value of malformed) {
      const error = await access.storePastedToken(value).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PackGithubAccessError);
      expect((error as PackGithubAccessError).code).toBe('INVALID_TOKEN_FORMAT');
      const text = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
      if (value.length > 0) expect(text).not.toContain(value.trim().slice(0, 12));
    }
    // A non-string from an untyped caller (P1-2's route body) is refused the same way.
    await expect(access.storePastedToken(42 as unknown as string)).rejects.toMatchObject({
      code: 'INVALID_TOKEN_FORMAT',
    });
    await expect(stat(path.join(packsDir, '.credentials', 'github.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clearStoredToken removes the file and is a no-op when nothing is stored', async () => {
    const access = createPackGithubAccess({ packsDir, execGh: fakeGh(ghResult({ ok: false })).execGh, env: {} });
    await access.clearStoredToken();
    await access.storePastedToken(STORED);
    await access.clearStoredToken();
    await expect(stat(packGithubCredentialPath(packsDir))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await access.status()).toEqual({ configured: false, source: 'none' });
  });

  it('never prints the token on any path', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const gh = fakeGh(ghResult({ ok: false, code: 1, stdout: GH_CLI_VALUE, stderr: GH_CLI_VALUE }));
    const access = createPackGithubAccess({ packsDir, execGh: gh.execGh, env: {} });
    await access.storePastedToken(STORED);
    await access.status();
    await access.resolveToken();
    await access.clearStoredToken();
    await access.storePastedToken(`${STORED}!`).catch(() => undefined);
    await access.resolveToken();
    vi.restoreAllMocks();
    const joined = lines.join('\n');
    expect(joined).not.toContain(STORED.slice(4, 16));
    expect(joined).not.toContain(GH_CLI_VALUE.slice(4, 16));
  });

  it('requires packsDir explicitly', () => {
    expect(() =>
      createPackGithubAccess({ packsDir: '', execGh: fakeGh(ghResult({})).execGh, env: {} }),
    ).toThrow();
    expect(() =>
      createPackGithubAccess({ packsDir: 'relative/packs', execGh: fakeGh(ghResult({})).execGh, env: {} }),
    ).toThrow();
  });
});

describe('credential store hardening (P1-3 review NITs 1 and 2)', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;
  const noGh = () => fakeGh(ghResult({ ok: false, code: 1 })).execGh;

  async function writeStoredRecord(file: string, mode: number) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, token: STORED, updatedAt: 'x' }), { mode });
    await chmod(file, mode);
  }

  posixOnly('NIT 1: storePastedToken refuses a .credentials that is a symlink, and never writes through it', async () => {
    const elsewhere = path.join(path.dirname(packsDir), 'elsewhere');
    await mkdir(elsewhere, { mode: 0o755 });
    await mkdir(packsDir, { recursive: true });
    await symlink(elsewhere, path.join(packsDir, '.credentials'));
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });

    await expect(access.storePastedToken(STORED)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' });
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await stat(elsewhere)).mode & 0o777).toBe(0o755);
  });

  posixOnly('NIT 1: storePastedToken refuses a .credentials dir owned by another uid', async () => {
    await mkdir(path.join(packsDir, '.credentials'), { recursive: true, mode: 0o700 });
    const realLstat = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, 'lstat').mockImplementation(async (...args: Parameters<typeof fsp.lstat>) => {
      const real = await realLstat(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as typeof real, real, {
        uid: (process.getuid?.() ?? 0) + 1,
      });
    });
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    await expect(access.storePastedToken(STORED)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' });
    vi.restoreAllMocks();
    await expect(stat(packGithubCredentialPath(packsDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  posixOnly('NIT 1: a stored github.json that is a symlink counts as no token', async () => {
    const target = path.join(path.dirname(packsDir), 'target.json');
    await writeStoredRecord(target, 0o600);
    const file = packGithubCredentialPath(packsDir);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await symlink(target, file);
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    expect(await access.resolveToken()).toBeNull();
    expect(await access.status()).toEqual({ configured: false, source: 'none' });
  });

  posixOnly('NIT 1: a stored github.json that is not 0600 counts as no token; 0600 counts', async () => {
    const file = packGithubCredentialPath(packsDir);
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    for (const mode of [0o644, 0o640, 0o604, 0o700]) {
      await writeStoredRecord(file, mode);
      expect(await access.resolveToken()).toBeNull();
    }
    await writeStoredRecord(file, 0o600);
    expect(await access.resolveToken()).toEqual({ token: STORED, source: 'stored' });
  });

  async function symlinkedCredentials(): Promise<string> {
    const elsewhere = path.join(path.dirname(packsDir), 'elsewhere');
    await writeStoredRecord(path.join(elsewhere, 'github.json'), 0o600);
    await chmod(elsewhere, 0o700);
    await mkdir(packsDir, { recursive: true });
    await symlink(elsewhere, path.join(packsDir, '.credentials'));
    return elsewhere;
  }

  function otherUidLstat() {
    const realLstat = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, 'lstat').mockImplementation(async (...args: Parameters<typeof fsp.lstat>) => {
      const real = await realLstat(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as typeof real, real, {
        uid: (process.getuid?.() ?? 0) + 1,
      });
    });
  }

  posixOnly('Sol #191: a symlinked .credentials counts as no token on read', async () => {
    await symlinkedCredentials();
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    expect(await access.resolveToken()).toBeNull();
    expect(await access.status()).toEqual({ configured: false, source: 'none' });
  });

  posixOnly('Sol #191: a .credentials dir that is not 0700, or owned by another uid, counts as no token on read', async () => {
    const file = packGithubCredentialPath(packsDir);
    await writeStoredRecord(file, 0o600);
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    for (const mode of [0o755, 0o750, 0o711]) {
      await chmod(path.dirname(file), mode);
      expect(await access.resolveToken()).toBeNull();
    }
    await chmod(path.dirname(file), 0o700);
    otherUidLstat();
    expect(await access.resolveToken()).toBeNull();
    vi.restoreAllMocks();
    expect(await access.resolveToken()).toEqual({ token: STORED, source: 'stored' });
  });

  posixOnly('Sol #191: clearStoredToken refuses a symlinked .credentials and deletes nothing through it', async () => {
    const elsewhere = await symlinkedCredentials();
    await writeFile(path.join(elsewhere, '.github.json.0123456789abcdef.tmp'), 'partial');
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    await expect(access.clearStoredToken()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' });
    expect((await readdir(elsewhere)).sort()).toEqual(['.github.json.0123456789abcdef.tmp', 'github.json']);
  });

  posixOnly('Sol #191: clearStoredToken refuses a .credentials dir that is not 0700 or owned by another uid', async () => {
    const file = packGithubCredentialPath(packsDir);
    await writeStoredRecord(file, 0o600);
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    await chmod(path.dirname(file), 0o755);
    await expect(access.clearStoredToken()).rejects.toBeInstanceOf(PackGithubAccessError);
    await expect(access.clearStoredToken()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' });
    await chmod(path.dirname(file), 0o700);
    otherUidLstat();
    await expect(access.clearStoredToken()).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE' });
    vi.restoreAllMocks();
    expect((await stat(file)).isFile()).toBe(true);
    await access.clearStoredToken();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('NIT 2: clearStoredToken also deletes leftover .github.json.*.tmp files and nothing else', async () => {
    const access = createPackGithubAccess({ packsDir, execGh: noGh(), env: {} });
    await access.storePastedToken(STORED);
    const dir = path.dirname(packGithubCredentialPath(packsDir));
    await writeFile(path.join(dir, '.github.json.0123456789abcdef.tmp'), 'partial');
    await writeFile(path.join(dir, '.github.json.fedcba9876543210.tmp'), 'partial');
    await writeFile(path.join(dir, 'unrelated.json'), 'keep');
    await access.clearStoredToken();
    expect(await readdir(dir)).toEqual(['unrelated.json']);
  });
});
