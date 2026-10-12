import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
import {
  clearToken,
  getToken,
  isTokenExpired,
  readAllTokens,
  readTokensFile,
  refreshMcpTokenSingleFlight,
  sanitizeTokensFile,
  setToken,
  type StoredMcpToken,
} from '../src/mcp-tokens.js';

describe('mcp-tokens storage', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mcptokens-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('treats prototype-member server ids as ordinary keys', async () => {
    expect(await getToken(dataDir, 'toString')).toBeNull();
    expect((await readAllTokens(dataDir))['valueOf']).toBeUndefined();
    const tok: StoredMcpToken = { accessToken: 'a', tokenType: 'Bearer', savedAt: 1 };
    await setToken(dataDir, 'constructor', tok);
    expect(await getToken(dataDir, 'constructor')).toEqual(tok);
    await clearToken(dataDir, 'constructor');
    expect(await getToken(dataDir, 'constructor')).toBeNull();
  });

  describe('refreshMcpTokenSingleFlight', () => {
    const endpointA = 'https://a.example.test/mcp';
    const endpointB = 'https://b.example.test/mcp';
    const expired: StoredMcpToken = {
      accessToken: 'old', refreshToken: 'rt-1', tokenType: 'Bearer', savedAt: 1, expiresAt: 1,
      tokenEndpoint: 'https://auth.example/token', clientId: 'cid',
      endpointFingerprint: mcpEndpointFingerprint(endpointA),
    };
    const tokenForB: StoredMcpToken = {
      accessToken: 'b-access', refreshToken: 'b-refresh', tokenType: 'Bearer', savedAt: 2,
      expiresAt: Date.now() + 3_600_000, tokenEndpoint: 'https://auth.b.example/token', clientId: 'b-cid',
      endpointFingerprint: mcpEndpointFingerprint(endpointB),
    };

    it('shares one network refresh between concurrent callers', async () => {
      await setToken(dataDir, 's1', expired);
      let calls = 0;
      const refresh = async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { access_token: 'new', refresh_token: 'rt-2', expires_in: 3600 };
      };
      const [a, b] = await Promise.all([
        refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, refresh),
        refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, refresh),
      ]);
      expect(calls).toBe(1);
      expect(a?.accessToken).toBe('new');
      expect(b?.accessToken).toBe('new');
      // A later caller sees a fresh token and does not refresh again.
      await refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, refresh);
      expect(calls).toBe(1);
    });

    it('does not overwrite a token replaced while the refresh was in flight', async () => {
      await setToken(dataDir, 's1', expired);
      const replacement: StoredMcpToken = { ...expired, accessToken: 'signed-in', refreshToken: 'rt-new', expiresAt: Date.now() + 3_600_000 };
      const result = await refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, async () => {
        await setToken(dataDir, 's1', replacement);
        return { access_token: 'stale-refresh' };
      });
      expect(result?.accessToken).toBe('signed-in');
      expect((await getToken(dataDir, 's1'))?.accessToken).toBe('signed-in');
    });

    it('does not restore a token cleared while the refresh was in flight', async () => {
      await setToken(dataDir, 's1', expired);
      const result = await refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, async () => {
        await clearToken(dataDir, 's1');
        return { access_token: 'stale-refresh' };
      });
      expect(result).toBeNull();
      expect(await getToken(dataDir, 's1')).toBeNull();
    });

    it('never returns a token saved for another endpoint during the refresh', async () => {
      await setToken(dataDir, 's1', expired);
      const result = await refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, async () => {
        // The same server id is reconnected to endpoint B while A's refresh is on the wire.
        await setToken(dataDir, 's1', tokenForB);
        return { access_token: 'a-refreshed' };
      });
      expect(result).toBeNull();
      // B's sign-in survives untouched; A's stale refresh is discarded.
      expect(await getToken(dataDir, 's1')).toEqual(tokenForB);
    });

    it('returns null without network I/O when the stored token belongs to another endpoint', async () => {
      await setToken(dataDir, 's1', { ...tokenForB, expiresAt: 1 });
      let calls = 0;
      const result = await refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, async () => {
        calls += 1;
        return { access_token: 'never' };
      });
      expect(result).toBeNull();
      expect(calls).toBe(0);
    });

    it('does not let a caller expecting endpoint B join endpoint A\'s flight', async () => {
      await setToken(dataDir, 's1', expired);
      let releaseA!: () => void;
      const gate = new Promise<void>((resolve) => { releaseA = resolve; });
      let reconnectedToB!: () => void;
      const reconnected = new Promise<void>((resolve) => { reconnectedToB = resolve; });
      const flightA = refreshMcpTokenSingleFlight(dataDir, 's1', endpointA, async () => {
        await setToken(dataDir, 's1', tokenForB);
        reconnectedToB();
        await gate;
        return { access_token: 'a-refreshed' };
      });
      // A's refresh is on the wire and B has signed in under the same server id.
      await reconnected;
      const flightB = refreshMcpTokenSingleFlight(dataDir, 's1', endpointB, async () => ({ access_token: 'never' }));
      releaseA();
      const [resultA, resultB] = await Promise.all([flightA, flightB]);
      expect(resultB?.accessToken).toBe('b-access');
      expect(resultA).toBeNull();
    });
  });

  it('returns no servers when the file is missing', async () => {
    expect(await readTokensFile(dataDir)).toEqual({ servers: {} });
    expect(await getToken(dataDir, 'higgsfield')).toBeNull();
  });

  it('persists, re-reads, and overwrites a token', async () => {
    const tok: StoredMcpToken = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      scope: 'openid email',
      expiresAt: Date.now() + 60_000,
      savedAt: Date.now(),
    };
    await setToken(dataDir, 'higgsfield', tok);

    const got = await getToken(dataDir, 'higgsfield');
    expect(got?.accessToken).toBe('access-1');
    expect(got?.refreshToken).toBe('refresh-1');
    expect(got?.scope).toBe('openid email');

    // Overwrite with a rotated token.
    await setToken(dataDir, 'higgsfield', {
      ...tok,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
    const got2 = await getToken(dataDir, 'higgsfield');
    expect(got2?.accessToken).toBe('access-2');
    expect(got2?.refreshToken).toBe('refresh-2');
  });

  it('isolates tokens per server', async () => {
    await setToken(dataDir, 'github', {
      accessToken: 'gh-token',
      tokenType: 'Bearer',
      savedAt: Date.now(),
    });
    await setToken(dataDir, 'higgsfield', {
      accessToken: 'hg-token',
      tokenType: 'Bearer',
      savedAt: Date.now(),
    });
    const all = await readAllTokens(dataDir);
    expect(Object.keys(all).sort()).toEqual(['github', 'higgsfield']);
    expect(all.github?.accessToken).toBe('gh-token');
    expect(all.higgsfield?.accessToken).toBe('hg-token');
  });

  it('clearToken removes only the requested entry', async () => {
    await setToken(dataDir, 'github', {
      accessToken: 'gh-token',
      tokenType: 'Bearer',
      savedAt: Date.now(),
    });
    await setToken(dataDir, 'higgsfield', {
      accessToken: 'hg-token',
      tokenType: 'Bearer',
      savedAt: Date.now(),
    });
    await clearToken(dataDir, 'github');
    expect(await getToken(dataDir, 'github')).toBeNull();
    expect(await getToken(dataDir, 'higgsfield')).not.toBeNull();
  });

  it('clearToken on an absent server is a no-op', async () => {
    await expect(clearToken(dataDir, 'never')).resolves.toBeUndefined();
  });

  it('writes the tokens file with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return; // mode bits are advisory on win32
    await setToken(dataDir, 'higgsfield', {
      accessToken: 'tok',
      tokenType: 'Bearer',
      savedAt: Date.now(),
    });
    const s = await stat(path.join(dataDir, 'mcp-tokens.json'));
    // Mask off file-type bits — only the permission bits are interesting.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('survives a corrupt tokens file by returning empty', async () => {
    await writeFile(path.join(dataDir, 'mcp-tokens.json'), '{not valid');
    const all = await readAllTokens(dataDir);
    expect(all).toEqual({});
  });

  it('sanitizes incoming JSON, dropping malformed entries', () => {
    const out = sanitizeTokensFile({
      servers: {
        good: {
          accessToken: '   abc   ',
          tokenType: 'Bearer',
          savedAt: 123,
          scope: 'a b c',
        },
        bad_no_token: { tokenType: 'Bearer', savedAt: 123 },
        bad_shape: 'not an object',
        __proto__: { accessToken: 'evil', tokenType: 'Bearer', savedAt: 1 },
      },
    });
    expect(out.servers.good?.accessToken).toBe('abc');
    expect(out.servers.bad_no_token).toBeUndefined();
    expect(out.servers.bad_shape).toBeUndefined();
    // __proto__ is reserved — sanitizer must NOT have set it as a real
    // own property (which would be a prototype-pollution vector). The
    // implicit access via `.__proto__` returns Object.prototype, so we
    // check Object.hasOwn instead of toBeUndefined.
    expect(Object.hasOwn(out.servers, '__proto__')).toBe(false);
    expect(Object.keys(out.servers)).toEqual(['good']);
  });

  it('round-trips JSON disk format', async () => {
    await setToken(dataDir, 'higgsfield', {
      accessToken: 'tok',
      tokenType: 'Bearer',
      savedAt: 1234,
    });
    const raw = await readFile(path.join(dataDir, 'mcp-tokens.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.servers.higgsfield.accessToken).toBe('tok');
  });

  it('persists OAuth client context fields with the token', async () => {
    const tok: StoredMcpToken = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      savedAt: Date.now(),
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-xyz',
      clientSecret: 'secret-xyz',
      authServerIssuer: 'https://auth.example.com',
      redirectUri: 'https://app.example.com/api/mcp/oauth/callback',
      resourceUrl: 'https://mcp.example.com/mcp',
    };
    await setToken(dataDir, 'higgsfield', tok);
    const got = await getToken(dataDir, 'higgsfield');
    expect(got).toMatchObject({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-xyz',
      clientSecret: 'secret-xyz',
      authServerIssuer: 'https://auth.example.com',
      redirectUri: 'https://app.example.com/api/mcp/oauth/callback',
      resourceUrl: 'https://mcp.example.com/mcp',
    });
  });
});

describe('isTokenExpired', () => {
  const now = 1_700_000_000_000;

  it('returns false for a token with no expiresAt', () => {
    expect(
      isTokenExpired({ accessToken: 'a', tokenType: 'Bearer', savedAt: now }, now),
    ).toBe(false);
  });

  it('returns false when expiresAt is comfortably in the future', () => {
    expect(
      isTokenExpired(
        { accessToken: 'a', tokenType: 'Bearer', savedAt: now, expiresAt: now + 60_000 },
        now,
      ),
    ).toBe(false);
  });

  it('returns true when expiresAt is in the past', () => {
    expect(
      isTokenExpired(
        { accessToken: 'a', tokenType: 'Bearer', savedAt: now, expiresAt: now - 5 },
        now,
      ),
    ).toBe(true);
  });

  it('honors the skew window (default 30s) so we do not ship a token about to expire', () => {
    expect(
      isTokenExpired(
        { accessToken: 'a', tokenType: 'Bearer', savedAt: now, expiresAt: now + 5_000 },
        now,
      ),
    ).toBe(true);
  });
});
