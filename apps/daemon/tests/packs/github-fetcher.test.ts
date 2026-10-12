// P1-3 specs 1–4b: the private GitHub pack fetcher.
//
// Every request goes to a fake `fetchImpl` that records it; no test opens a
// socket except the opt-in live check at the end, which stays skipped until
// the `github-mishh-licensed-read` token exists (owner decision 2026-10-07).
//
// Fixture bytes are synthetic. Token-shaped values are assembled at runtime so
// no committed line matches a token pattern.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { PackGithubAccess, ResolvedPackGithubToken } from '../../src/integrations/github-auth.js';
import { createPackGithubAccess } from '../../src/integrations/github-auth.js';
import {
  createGithubPackFetcher,
  type GithubPackFetcher,
  type GithubPackFetchOptions,
  type PackFetchErrorCode,
  PACK_MANIFEST_MAX_BYTES_DEFAULT,
  PackFetchError,
} from '../../src/packs/github-fetcher.js';
import { safeExternalFetch } from '../../src/plugins/plugin-asset-cache.js';

const TOKEN = `ghp_${'T'.repeat(36)}`;
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const BRANCH_SHA = 'c'.repeat(40);
const SIGNED_MARKER = 'signedQueryCredential';
const API = 'https://api.github.com/repos/acme/pack';
const CODELOAD = `https://codeload.github.com/acme/pack/legacy.tar.gz/${SHA}?token=${SIGNED_MARKER}`;
const MANIFEST = new TextEncoder().encode('{"synthetic":"manifest fixture for the P1-3 fetcher tests"}\n');
const MIB = 1024 * 1024;

// ---------------------------------------------------------------- helpers

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: RequestInit['redirect'];
  viaSafeExternalFetch: boolean;
}

type Handler = (req: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

function recordingFetch(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      redirect: init?.redirect,
      viaSafeExternalFetch: Boolean((init as { dispatcher?: unknown } | undefined)?.dispatcher),
    };
    requests.push(req);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(req, init?.signal ?? undefined);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function bytesOf(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A body that yields `chunks` one by one, `delayMs` apart, and records how far it was pulled. */
function streamBody(chunks: Uint8Array[], delayMs = 0) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const next = chunks[state.pulled];
      state.pulled += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
  return { stream, state };
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function tagsPage(names: string[], nextPage: number | null, sha = SHA) {
  const headers: Record<string, string> = {};
  if (nextPage !== null) {
    headers.link = `<${API}/tags?per_page=100&page=${nextPage}>; rel="next", <${API}/tags?per_page=100&page=99>; rel="last"`;
  }
  return Response.json(
    names.map((name) => ({ name, commit: { sha, url: 'ignored' } })),
    { headers },
  );
}

interface FakeGithubOptions {
  tagPages?: string[][];
  commitSha?: string;
  manifest?: Uint8Array;
  tarball?: Uint8Array;
  tarballChunk?: number;
  tarballDelayMs?: number;
  tarballContentLength?: boolean;
  override?: (req: RecordedRequest) => Response | Promise<Response> | undefined;
}

/** A GitHub that serves pack@ tags, a sha, pack.json and a tarball behind a 302 to codeload. */
function fakeGithub(opts: FakeGithubOptions = {}) {
  const tarball = opts.tarball ?? bytesOf(4096);
  let tarballBody: ReturnType<typeof streamBody> | undefined;
  const recorder = recordingFetch(async (req) => {
    const custom = await opts.override?.(req);
    if (custom) return custom;
    const url = new URL(req.url);
    if (url.origin === 'https://api.github.com' && url.pathname === '/repos/acme/pack/tags') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const pages = opts.tagPages ?? [];
      return tagsPage(pages[page - 1] ?? [], page < pages.length ? page + 1 : null);
    }
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/acme/pack/commits/refs/tags/')) {
      return new Response(opts.commitSha ?? SHA, { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/acme/pack/commits/')) {
      // A branch with the same name as the tag: must never be what gets installed.
      return new Response(BRANCH_SHA, { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === '/repos/acme/pack/contents/pack.json') {
      return new Response(opts.manifest ?? MANIFEST, { status: 200 });
    }
    if (url.origin === 'https://api.github.com' && url.pathname === `/repos/acme/pack/tarball/${SHA}`) {
      return new Response(null, { status: 302, headers: { location: CODELOAD } });
    }
    if (url.origin === 'https://codeload.github.com') {
      tarballBody = streamBody(chunksOf(tarball, opts.tarballChunk ?? 1024), opts.tarballDelayMs ?? 0);
      const headers: Record<string, string> = { 'content-type': 'application/x-gzip' };
      if (opts.tarballContentLength !== false) headers['content-length'] = String(tarball.length);
      return new Response(tarballBody.stream, { status: 200, headers });
    }
    return new Response('not found', { status: 404 });
  });
  return { ...recorder, tarball, pulled: () => tarballBody?.state.pulled ?? 0 };
}

function fakeAccess(resolved: ResolvedPackGithubToken | null = { token: TOKEN, source: 'stored' }): PackGithubAccess {
  return {
    status: async () => (resolved ? { configured: true, source: resolved.source } : { configured: false, source: 'none' }),
    storePastedToken: async () => undefined,
    clearStoredToken: async () => undefined,
    resolveToken: async () => resolved,
  };
}

async function catchError(promise: Promise<unknown>): Promise<PackFetchError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PackFetchError);
  return error as PackFetchError;
}

let workDir: string;
let destPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'p1-3-fetch-'));
  destPath = path.join(workDir, 'staging', 'download.tgz');
  await fsp.mkdir(path.dirname(destPath));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

function fetchOpts(extra: Partial<GithubPackFetchOptions> = {}): GithubPackFetchOptions {
  return { destPath, maxBytes: 64 * MIB, ...extra };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------- spec 1

describe('spec 1: tag, manifest, sha, tarball', () => {
  it('resolves the highest pack@* tag (or the given version), reads pack.json at the tag, resolves the tag to a sha, downloads /tarball/{sha} with Authorization and redirect manual; the token is never in a URL', async () => {
    const page1 = [
      ...Array.from({ length: 96 }, (_, i) => `docs-${i}`),
      'pack@1.9.0',
      'v9.9.9',
      'pack@01.2.3',
      'pack@1.2',
    ];
    const page2 = ['pack@1.10.0', 'release@3.0.0', 'pack@0.99.99', 'pack@1.10.0-rc.1'];
    const gh = fakeGithub({ tagPages: [page1, page2], tarball: bytesOf(10_000) });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });

    const result = await fetcher('github:acme/pack', fetchOpts());

    expect(gh.requests.map((r) => r.url)).toEqual([
      `${API}/tags?per_page=100&page=1`,
      `${API}/tags?per_page=100&page=2`,
      `${API}/commits/refs/tags/pack%401.10.0`,
      `${API}/contents/pack.json?ref=${SHA}`,
      `${API}/tarball/${SHA}`,
      CODELOAD,
    ]);
    const accepts = gh.requests.map((r) => r.headers.accept);
    expect(accepts.slice(0, 5)).toEqual([
      'application/vnd.github+json',
      'application/vnd.github+json',
      'application/vnd.github.sha',
      'application/vnd.github.raw+json',
      'application/vnd.github+json',
    ]);
    for (const req of gh.requests) {
      expect(req.redirect).toBe('manual');
      expect(req.method).toBe('GET');
      // Every hop goes through safeExternalFetch (it attaches the SSRF dispatcher).
      expect(req.viaSafeExternalFetch).toBe(true);
      expect(req.url).not.toContain(TOKEN);
      expect(req.url).not.toContain(TOKEN.slice(4, 14));
      expect(req.headers['user-agent']).toBeTruthy();
    }
    for (const req of gh.requests.slice(0, 5)) {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.headers['x-github-api-version']).toBe('2022-11-28');
    }

    const onDisk = await readFile(destPath);
    expect(result).toEqual({
      archivePath: destPath,
      resolvedRef: `pack@1.10.0 ${SHA}`,
      archiveIntegrity: `sha256:${sha256Hex(gh.tarball)}`,
      expectedManifestSha256: sha256Hex(MANIFEST),
      bytes: gh.tarball.length,
    });
    expect(sha256Hex(onDisk)).toBe(sha256Hex(gh.tarball));
    if (process.platform !== 'win32') expect((await stat(destPath)).mode & 0o777).toBe(0o600);
  });

  it('an explicit @version skips the tag listing and pins pack@<version>', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const result = await fetcher('github:acme/pack@2026.10.7', fetchOpts());
    expect(gh.requests.map((r) => r.url)).toEqual([
      `${API}/commits/refs/tags/pack%402026.10.7`,
      `${API}/contents/pack.json?ref=${SHA}`,
      `${API}/tarball/${SHA}`,
      CODELOAD,
    ]);
    expect(result.resolvedRef).toBe(`pack@2026.10.7 ${SHA}`);
  });

  it('no pack@ tag fails FETCH_FAILED without reading a manifest or a tarball', async () => {
    const gh = fakeGithub({ tagPages: [['v1.0.0', 'pack@1.0', 'latest']] });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toMatch(/no pack tag/);
    expect(gh.requests).toHaveLength(1);
    expect(await exists(destPath)).toBe(false);
  });

  it('a tag listing past the page cap fails FETCH_FAILED instead of guessing a version', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `pack@1.0.${i}`);
    const gh = fakeGithub({ tagPages: Array.from({ length: 50 }, () => full) });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    expect(gh.requests.every((r) => r.url.includes('/tags?'))).toBe(true);
    // NIT 4: fails only once the cap is reached and a next page still exists.
    expect(gh.requests).toHaveLength(10);
  });

  it('NIT 6: a tag that moved between listing and resolution fails FETCH_FAILED (retry) before downloading', async () => {
    const gh = fakeGithub({ tagPages: [['pack@1.0.0']], commitSha: OTHER_SHA });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toMatch(/changed/);
    expect(gh.requests.some((r) => r.url.includes('/tarball/'))).toBe(false);
  });

  it('a commit lookup that is not a 40-hex sha fails FETCH_FAILED; an unknown version (422) fails FETCH_FAILED', async () => {
    for (const commitResponse of [
      () => new Response('not-a-sha', { status: 200 }),
      () => new Response('{"message":"No commit found"}', { status: 422 }),
    ]) {
      const gh = fakeGithub({
        override: (req) => (req.url.includes('/commits/') ? commitResponse() : undefined),
      });
      const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
      const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
      expect(error.code).toBe('FETCH_FAILED');
      expect(gh.requests).toHaveLength(1);
    }
  });

  it('with no token configured, sends no Authorization header at all (a public pack repo still works)', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(null), fetchImpl: gh.fetchImpl });
    await fetcher('github:acme/pack@1.0.0', fetchOpts());
    for (const req of gh.requests) expect(Object.keys(req.headers)).not.toContain('authorization');
  });

  it('satisfies the GithubPackFetcher seam that P1-1 consumes, with exactly four error codes (NIT 6)', () => {
    const fetcher: GithubPackFetcher = createGithubPackFetcher({ access: fakeAccess() });
    expect(typeof fetcher).toBe('function');
    expectTypeOf<PackFetchErrorCode>().toEqualTypeOf<'BAD_REQUEST' | 'AUTH_REQUIRED' | 'FETCH_FAILED' | 'TOO_LARGE'>();
  });

  it('NIT 3: the version lookup uses commits/refs/tags/pack@<v>, so a branch with the same name is never installed', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const result = await fetcher('github:acme/pack@1.0.0', fetchOpts());
    expect(result.resolvedRef).toBe(`pack@1.0.0 ${SHA}`);
    expect(gh.requests.some((r) => r.url.includes(BRANCH_SHA))).toBe(false);
    expect(gh.requests.some((r) => /\/commits\/pack/.test(r.url))).toBe(false);
  });

  it('NIT 4: exactly 1000 tags (10 full pages, no rel="next" on the last) succeeds and picks the highest', async () => {
    const pages = Array.from({ length: 10 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => `pack@1.${p}.${i}`),
    );
    const gh = fakeGithub({ tagPages: pages });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const result = await fetcher('github:acme/pack', fetchOpts());
    expect(result.resolvedRef).toBe(`pack@1.9.99 ${SHA}`);
    expect(gh.requests.filter((r) => r.url.includes('/tags?'))).toHaveLength(10);
  });

  it('NIT 4: a full page of 100 tags with no rel="next" stops paging', async () => {
    const gh = fakeGithub({ tagPages: [Array.from({ length: 100 }, (_, i) => `pack@2.0.${i}`)] });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const result = await fetcher('github:acme/pack', fetchOpts());
    expect(result.resolvedRef).toBe(`pack@2.0.99 ${SHA}`);
    expect(gh.requests.filter((r) => r.url.includes('/tags?'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- spec 2

describe('spec 2: manual redirects', () => {
  it('a cross-origin redirect hop (api.github.com → codeload.github.com) is requested without Authorization; the api.github.com request carries it', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    await fetcher('github:acme/pack@1.0.0', fetchOpts());

    const apiTarball = gh.requests.find((r) => r.url === `${API}/tarball/${SHA}`);
    const codeload = gh.requests.find((r) => r.url.startsWith('https://codeload.github.com/'));
    expect(apiTarball?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(codeload).toBeDefined();
    // Case-insensitive over every header name and value.
    for (const [name, value] of Object.entries(codeload!.headers)) {
      expect(name.toLowerCase()).not.toBe('authorization');
      expect(value).not.toContain(TOKEN.slice(4, 14));
    }
    // The fetcher followed the hop itself: undici was told not to.
    expect(apiTarball?.redirect).toBe('manual');
    expect(codeload?.redirect).toBe('manual');
  });

  it('a same-origin api.github.com redirect (renamed repo) keeps Authorization; a relative Location resolves against the current URL', async () => {
    const gh = fakeGithub({
      override: (req) => {
        if (req.url === `${API}/commits/refs/tags/pack%401.0.0`) {
          return new Response(null, {
            status: 301,
            headers: { location: '/repositories/42/commits/refs/tags/pack%401.0.0' },
          });
        }
        if (req.url === 'https://api.github.com/repositories/42/commits/refs/tags/pack%401.0.0') {
          return new Response(SHA, { status: 200 });
        }
        return undefined;
      },
    });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    await fetcher('github:acme/pack@1.0.0', fetchOpts());
    const hop = gh.requests.find((r) => r.url.includes('/repositories/42/'));
    expect(hop?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a redirect to a host outside the allowlist, to http:, or a fourth hop fails FETCH_FAILED and sends no request to that host', async () => {
    const cases: { location: string; forbiddenPrefix: string }[] = [
      { location: 'https://evil.example/steal', forbiddenPrefix: 'https://evil.example' },
      { location: `http://codeload.github.com/acme/pack/legacy.tar.gz/${SHA}`, forbiddenPrefix: 'http://' },
      { location: `https://codeload.github.com:8443/acme/pack/${SHA}`, forbiddenPrefix: 'https://codeload.github.com:8443' },
      { location: `https://user:pw@codeload.github.com/acme/pack/${SHA}`, forbiddenPrefix: 'https://user' },
      { location: 'https://api.github.com.evil.example/x', forbiddenPrefix: 'https://api.github.com.evil' },
      { location: 'https://objects.githubusercontent.com/x', forbiddenPrefix: 'https://objects.' },
    ];
    for (const { location, forbiddenPrefix } of cases) {
      const gh = fakeGithub({
        override: (req) =>
          req.url === `${API}/tarball/${SHA}` ? new Response(null, { status: 302, headers: { location } }) : undefined,
      });
      const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
      const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
      expect(error.code).toBe('FETCH_FAILED');
      expect(gh.requests.some((r) => r.url.startsWith(forbiddenPrefix))).toBe(false);
      expect(await exists(destPath)).toBe(false);
    }

    // Three hops are allowed; the fourth redirect is refused before it is requested.
    let hop = 0;
    const loop = fakeGithub({
      override: (req) => {
        const url = new URL(req.url);
        if (url.hostname === 'codeload.github.com' || url.pathname.startsWith('/repos/acme/pack/tarball/')) {
          hop += 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://codeload.github.com/acme/pack/hop/${hop}` },
          });
        }
        return undefined;
      },
    });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: loop.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    const tarballChain = loop.requests.filter((r) => /tarball|codeload/.test(r.url));
    expect(tarballChain.map((r) => r.url)).toEqual([
      `${API}/tarball/${SHA}`,
      'https://codeload.github.com/acme/pack/hop/1',
      'https://codeload.github.com/acme/pack/hop/2',
      'https://codeload.github.com/acme/pack/hop/3',
    ]);

    // A redirect with no Location is refused too.
    const bare = fakeGithub({
      override: (req) => (req.url === `${API}/tarball/${SHA}` ? new Response(null, { status: 307 }) : undefined),
    });
    const bareError = await catchError(
      createGithubPackFetcher({ access: fakeAccess(), fetchImpl: bare.fetchImpl })('github:acme/pack@1.0.0', fetchOpts()),
    );
    expect(bareError.code).toBe('FETCH_FAILED');
  });
});

// ---------------------------------------------------------------- spec 2b

describe('spec 2b: manifest cap and source shape', () => {
  it('a tag whose pack.json exceeds the manifest cap fails TOO_LARGE without downloading the tarball', async () => {
    expect(PACK_MANIFEST_MAX_BYTES_DEFAULT).toBe(8 * MIB);
    const cap = 1024;
    const declared = fakeGithub({
      override: (req) =>
        req.url.includes('/contents/pack.json')
          ? new Response(bytesOf(cap + 1), { status: 200, headers: { 'content-length': String(cap + 1) } })
          : undefined,
    });
    const streamed = fakeGithub({
      override: (req) =>
        req.url.includes('/contents/pack.json')
          ? new Response(streamBody(chunksOf(bytesOf(cap * 3), 256)).stream, { status: 200 })
          : undefined,
    });
    for (const gh of [declared, streamed]) {
      const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl, manifestMaxBytes: cap });
      const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
      expect(error.code).toBe('TOO_LARGE');
      expect(gh.requests.some((r) => r.url.includes('/tarball/'))).toBe(false);
      expect(await exists(destPath)).toBe(false);
    }
  });

  it('a non-pack@ ref, a subpath or any other source shape fails BAD_REQUEST before any request', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    for (const source of [
      'github:acme/pack@main',
      'github:acme/pack@v1.2.3',
      'github:acme/pack@pack@1.2.3',
      'github:acme/pack@1.2',
      'github:acme/pack@01.2.3',
      'github:acme/pack@1.2.3-rc.1',
      'github:acme/pack@1.2.3/sub',
      'github:acme/pack/sub',
      'github:acme/pack@',
      'github:acme',
      'gh:acme/pack',
      'https://github.com/acme/pack',
      'github:-acme/pack',
      'github:acme/..',
      'github:acme/pack?x=1',
      ` github:acme/pack`,
      '',
    ]) {
      const error = await catchError(fetcher(source, fetchOpts()));
      expect(error.code).toBe('BAD_REQUEST');
    }
    expect(gh.requests).toHaveLength(0);
  });

  it('invalid options fail BAD_REQUEST before any request', async () => {
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    for (const opts of [
      { destPath: 'relative.tgz', maxBytes: 10 },
      { destPath, maxBytes: 0 },
      { destPath, maxBytes: Number.NaN },
      { destPath, maxBytes: 1.5 },
    ]) {
      const error = await catchError(fetcher('github:acme/pack@1.0.0', opts));
      expect(error.code).toBe('BAD_REQUEST');
    }
    expect(gh.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- spec 3

describe('spec 3: status mapping and no leaks', () => {
  interface Branch {
    name: string;
    expected: PackFetchError['code'];
    access?: PackGithubAccess;
    idleTimeoutMs?: number;
    override: (req: RecordedRequest) => Response | Promise<Response> | undefined;
  }
  const at = (fragment: string, make: () => Response | Promise<Response>) => (req: RecordedRequest) =>
    req.url.includes(fragment) ? make() : undefined;

  const branches: Branch[] = [
    { name: '401 at commits', expected: 'AUTH_REQUIRED', override: at('/commits/', () => new Response('', { status: 401 })) },
    { name: '403 at tarball', expected: 'AUTH_REQUIRED', override: at('/tarball/', () => new Response('', { status: 403 })) },
    { name: '404 at contents', expected: 'AUTH_REQUIRED', override: at('/contents/', () => new Response('', { status: 404 })) },
    {
      name: '404 with no token',
      expected: 'AUTH_REQUIRED',
      access: fakeAccess(null),
      override: at('/commits/', () => new Response('', { status: 404 })),
    },
    {
      name: '403 rate limited',
      expected: 'FETCH_FAILED',
      override: at('/commits/', () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })),
    },
    { name: '429', expected: 'FETCH_FAILED', override: at('/commits/', () => new Response('', { status: 429 })) },
    {
      name: 'NIT 5: 403 with retry-after (secondary rate limit)',
      expected: 'FETCH_FAILED',
      override: at('/commits/', () => new Response('', { status: 403, headers: { 'retry-after': '60' } })),
    },
    { name: 'NIT 5: 403 at codeload (expired link)', expected: 'FETCH_FAILED', override: at('codeload.github.com', () => new Response('', { status: 403 })) },
    { name: 'NIT 5: 404 at codeload', expected: 'FETCH_FAILED', override: at('codeload.github.com', () => new Response('', { status: 404 })) },
    { name: 'NIT 5: 401 at codeload', expected: 'FETCH_FAILED', override: at('codeload.github.com', () => new Response('', { status: 401 })) },
    { name: '500 at codeload', expected: 'FETCH_FAILED', override: at('codeload.github.com', () => new Response('', { status: 500 })) },
    { name: '502 at api', expected: 'FETCH_FAILED', override: at('/contents/', () => new Response('', { status: 502 })) },
    {
      name: 'network error naming the URL and token',
      expected: 'FETCH_FAILED',
      override: (req) => {
        if (!req.url.includes('codeload.github.com')) return undefined;
        throw new TypeError(`fetch failed for ${req.url} with Bearer ${TOKEN} into ${destPath}`);
      },
    },
    {
      // The fake ignores the abort signal, so only the fetcher's own race can end the wait.
      name: 'idle timeout (headers never arrive)',
      expected: 'FETCH_FAILED',
      idleTimeoutMs: 40,
      override: (req) => (req.url.includes('codeload.github.com') ? new Promise<Response>(() => undefined) : undefined),
    },
    {
      name: 'idle timeout (body stalls)',
      expected: 'FETCH_FAILED',
      idleTimeoutMs: 40,
      override: at('codeload.github.com', () => {
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytesOf(100));
          },
        });
        return new Response(stalled, { status: 200 });
      }),
    },
    {
      name: 'redirect off the allowlist',
      expected: 'FETCH_FAILED',
      override: at(
        '/tarball/',
        () => new Response(null, { status: 302, headers: { location: `https://evil.example/?token=${SIGNED_MARKER}` } }),
      ),
    },
  ];

  it('401, 403 and 404 map to AUTH_REQUIRED; 5xx, network errors and the idle timeout map to FETCH_FAILED; no rejection message, code, progress callback or console line carries the token, a URL or destPath', async () => {
    const captured: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      });
    }
    for (const stream of [process.stderr, process.stdout]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      });
    }

    const errors: PackFetchError[] = [];
    const progress: unknown[] = [];
    const outcomes: [string, string][] = [];
    for (const branch of branches) {
      const gh = fakeGithub({ override: branch.override, tarball: bytesOf(3 * MIB), tarballChunk: 256 * 1024 });
      const fetcher = createGithubPackFetcher({
        access: branch.access ?? fakeAccess(),
        fetchImpl: gh.fetchImpl,
        ...(branch.idleTimeoutMs ? { idleTimeoutMs: branch.idleTimeoutMs } : {}),
      });
      const error = await catchError(
        fetcher(
          'github:acme/pack@1.0.0',
          fetchOpts({ onProgress: (...args: unknown[]) => void progress.push(args) }),
        ),
      );
      outcomes.push([branch.name, error.code]);
      errors.push(error);
      expect(await exists(destPath)).toBe(false);
    }
    vi.restoreAllMocks();

    expect(outcomes).toEqual(branches.map((b) => [b.name, b.expected]));
    const haystacks = [
      JSON.stringify(errors),
      errors.map((e) => `${e.name} ${e.code} ${e.message} ${String(e)}`).join('\n'),
      JSON.stringify(errors.map((e) => (e as { cause?: unknown }).cause ?? null)),
      JSON.stringify(progress),
      captured.join('\n'),
    ];
    for (const haystack of haystacks) {
      expect(haystack).not.toContain(TOKEN.slice(4, 14));
      expect(haystack).not.toContain('https://');
      expect(haystack).not.toContain('http://');
      expect(haystack).not.toContain(SIGNED_MARKER);
      expect(haystack).not.toContain(workDir);
    }
    expect(captured).toEqual([]);
    for (const error of errors) expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('AUTH_REQUIRED says "no GitHub access configured" when no token exists', async () => {
    const gh = fakeGithub({ override: (req) => (req.url.includes('/commits/') ? new Response('', { status: 404 }) : undefined) });
    const error = await catchError(
      createGithubPackFetcher({ access: fakeAccess(null), fetchImpl: gh.fetchImpl })('github:acme/pack@1.0.0', fetchOpts()),
    );
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.message).toMatch(/no GitHub access configured/);
  });

  it('NIT 5: a 403 with retry-after says rate limit; a 4xx from codeload says the download link failed', async () => {
    const limited = fakeGithub({
      override: (req) =>
        req.url.includes('/commits/') ? new Response('', { status: 403, headers: { 'retry-after': '60' } }) : undefined,
    });
    const limitedError = await catchError(
      createGithubPackFetcher({ access: fakeAccess(), fetchImpl: limited.fetchImpl })('github:acme/pack@1.0.0', fetchOpts()),
    );
    expect(limitedError.message).toMatch(/rate limit/);

    const expired = fakeGithub({
      override: (req) => (req.url.includes('codeload.github.com') ? new Response('', { status: 403 }) : undefined),
    });
    const expiredError = await catchError(
      createGithubPackFetcher({ access: fakeAccess(), fetchImpl: expired.fetchImpl })('github:acme/pack@1.0.0', fetchOpts()),
    );
    expect(expiredError.code).toBe('FETCH_FAILED');
    expect(expiredError.message).toMatch(/download link/);
  });

  it('a resolver that throws is treated as no token', async () => {
    const throwing: PackGithubAccess = { ...fakeAccess(), resolveToken: () => Promise.reject(new Error(TOKEN)) };
    const gh = fakeGithub();
    await createGithubPackFetcher({ access: throwing, fetchImpl: gh.fetchImpl })('github:acme/pack@1.0.0', fetchOpts());
    for (const req of gh.requests) expect(req.headers.authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------- spec 4

describe('spec 4: streaming under the byte budget', () => {
  it('a Content-Length over the budget fails TOO_LARGE before reading the body', async () => {
    const gh = fakeGithub({ tarball: bytesOf(5000) });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts({ maxBytes: 4999 })));
    expect(error.code).toBe('TOO_LARGE');
    expect(gh.pulled()).toBeLessThanOrEqual(1);
    expect(await exists(destPath)).toBe(false);
  });

  it('a chunked body that crosses the budget aborts with TOO_LARGE, deletes the partial file, and writes at most maxBytes', async () => {
    const written = { bytes: 0 };
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      const realWrite = handle.write.bind(handle) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
      (handle as { write: unknown }).write = async (...a: unknown[]) => {
        const result = await realWrite(...a);
        written.bytes += result.bytesWritten;
        return result;
      };
      return handle;
    });
    const maxBytes = 100 * 1024;
    const gh = fakeGithub({ tarball: bytesOf(400 * 1024), tarballChunk: 30 * 1024, tarballContentLength: false });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts({ maxBytes })));
    expect(error.code).toBe('TOO_LARGE');
    expect(written.bytes).toBeGreaterThan(0);
    expect(written.bytes).toBeLessThanOrEqual(maxBytes);
    expect(await exists(destPath)).toBe(false);
    // The body was not drained to the end.
    expect(gh.pulled()).toBeLessThan(Math.ceil((400 * 1024) / (30 * 1024)));
  });

  it('on success archiveIntegrity is the sha256 of the bytes on disk, and onProgress fires at most every 1 MiB', async () => {
    const progress: [number, number | undefined][] = [];
    const gh = fakeGithub({ tarball: bytesOf(3.5 * MIB), tarballChunk: 256 * 1024 });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const result = await fetcher(
      'github:acme/pack@1.0.0',
      fetchOpts({ onProgress: (bytes, totalBytes) => void progress.push([bytes, totalBytes]) }),
    );
    const onDisk = await readFile(destPath);
    expect(result.archiveIntegrity).toBe(`sha256:${sha256Hex(onDisk)}`);
    expect(result.bytes).toBe(onDisk.length);
    expect(onDisk.length).toBe(3.5 * MIB);

    expect(progress.map(([b]) => b)).toEqual([1 * MIB, 2 * MIB, 3 * MIB, 3.5 * MIB]);
    for (const [, total] of progress) expect(total).toBe(3.5 * MIB);
    for (let i = 1; i < progress.length - 1; i++) {
      expect(progress[i]![0] - progress[i - 1]![0]).toBeGreaterThanOrEqual(MIB);
    }
  });

  it('a caller abort mid-stream fails FETCH_FAILED and deletes the partial file; an already-aborted signal sends nothing', async () => {
    const controller = new AbortController();
    const gh = fakeGithub({ tarball: bytesOf(2 * MIB), tarballChunk: 64 * 1024, tarballDelayMs: 5 });
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const pending = fetcher(
      'github:acme/pack@1.0.0',
      fetchOpts({
        signal: controller.signal,
        onProgress: () => undefined,
      }),
    );
    const waitForFile = async () => {
      for (let i = 0; i < 200 && !(await exists(destPath)); i++) await new Promise((r) => setTimeout(r, 2));
    };
    await waitForFile();
    controller.abort();
    const error = await catchError(pending);
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toMatch(/cancel/);
    expect(await exists(destPath)).toBe(false);

    const pre = new AbortController();
    pre.abort();
    const idle = fakeGithub();
    const early = await catchError(
      createGithubPackFetcher({ access: fakeAccess(), fetchImpl: idle.fetchImpl })(
        'github:acme/pack@1.0.0',
        fetchOpts({ signal: pre.signal }),
      ),
    );
    expect(early.code).toBe('FETCH_FAILED');
    expect(idle.requests).toHaveLength(0);
  });

  it('never overwrites or deletes a file that already exists at destPath', async () => {
    await writeFile(destPath, 'pre-existing');
    const gh = fakeGithub();
    const fetcher = createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl });
    const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    expect(await readFile(destPath, 'utf8')).toBe('pre-existing');
  });

  it('a body shorter than its Content-Length fails FETCH_FAILED and deletes the partial file', async () => {
    const gh = fakeGithub({
      override: (req) =>
        req.url.includes('codeload.github.com')
          ? new Response(streamBody([bytesOf(100)]).stream, { status: 200, headers: { 'content-length': '500' } })
          : undefined,
    });
    const error = await catchError(
      createGithubPackFetcher({ access: fakeAccess(), fetchImpl: gh.fetchImpl })('github:acme/pack@1.0.0', fetchOpts()),
    );
    expect(error.code).toBe('FETCH_FAILED');
    expect(await exists(destPath)).toBe(false);
  });
});

// ---------------------------------------------------------------- spec 4b

describe('spec 4b: total-time cap', () => {
  it('a download that keeps trickling bytes past the total-time cap aborts with FETCH_FAILED and deletes the partial file', async () => {
    // Each chunk arrives well inside the idle timeout, so only the total cap can stop it.
    const gh = fakeGithub({ tarball: bytesOf(64 * 1024), tarballChunk: 512, tarballDelayMs: 10, tarballContentLength: false });
    const fetcher = createGithubPackFetcher({
      access: fakeAccess(),
      fetchImpl: gh.fetchImpl,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 250,
    });
    const started = Date.now();
    const error = await catchError(fetcher('github:acme/pack@1.0.0', fetchOpts()));
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toMatch(/too long/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(gh.pulled()).toBeGreaterThan(3);
    expect(await exists(destPath)).toBe(false);
  });
});

// ---------------------------------------------------------------- live check

// The one live check (decision e, Critic fix 2). It stays skipped: the
// `github-mishh-licensed-read` fine-grained token does not exist yet (owner
// decision 2026-10-07; creating it is Devin's credential step). To run it once
// the token is in your secret store and a `pack@<version>` tag exists:
//   P1_3_LIVE_SOURCE=github:ZeroSum-Solutions/mishh-licensed \
//   P1_3_LIVE_RECEIPT=~/Inbox/notes/<date>-p1-3-live-redirect-receipt.json \
//   GH_TOKEN="<read-only token>" \
//   pnpm --filter @open-design/daemon exec vitest run tests/packs/github-fetcher.test.ts -t live
// The receipt records hosts, statuses and whether Authorization was sent, never
// the token, any part of it, or a signed Location URL.
const LIVE_SOURCE = process.env.P1_3_LIVE_SOURCE;
const LIVE_RECEIPT = process.env.P1_3_LIVE_RECEIPT;

describe('live check (real api.github.com → codeload.github.com)', () => {
  it.skipIf(!LIVE_SOURCE || !LIVE_RECEIPT)(
    'live: skipped until the github-mishh-licensed-read token exists (owner decision 2026-10-07); set P1_3_LIVE_SOURCE and P1_3_LIVE_RECEIPT to run',
    async () => {
      const hops: { host: string; status: number; authorizationSent: boolean }[] = [];
      const recordingImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const response = await fetch(input, init);
        hops.push({
          host: url.hostname,
          status: response.status,
          authorizationSent: new Headers(init?.headers).has('authorization'),
        });
        return response;
      }) as typeof fetch;
      // Prove the production path: safeExternalFetch with the real global fetch underneath.
      expect(typeof safeExternalFetch).toBe('function');

      const access = createPackGithubAccess({ packsDir: path.join(workDir, 'packs'), env: process.env });
      const resolved = await access.resolveToken();
      expect(resolved).not.toBeNull();
      const fetcher = createGithubPackFetcher({ access, fetchImpl: recordingImpl });
      const result = await fetcher(LIVE_SOURCE!, { destPath, maxBytes: 512 * MIB });

      const receipt = {
        dateUtc: new Date().toISOString(),
        node: process.version,
        tokenSource: resolved!.source,
        resolvedRef: result.resolvedRef,
        hops,
        bytes: result.bytes,
        archiveIntegrity: result.archiveIntegrity,
        expectedManifestSha256: result.expectedManifestSha256,
      };
      const serialized = JSON.stringify(receipt, null, 2);
      expect(serialized).not.toContain(resolved!.token.slice(4, 14));
      expect(serialized).not.toContain('token=');
      const tarballHops = hops.slice(hops.findIndex((h) => h.host === 'api.github.com' && h.status === 302));
      expect(tarballHops.some((h) => h.host === 'codeload.github.com' && !h.authorizationSent && h.status === 200)).toBe(
        true,
      );
      for (const h of hops) if (h.host === 'api.github.com') expect(h.authorizationSent).toBe(true);
      const receiptPath = LIVE_RECEIPT!.replace(/^~(?=\/)/, homedir());
      await writeFile(receiptPath, `${serialized}\n`, { flag: 'wx' });
    },
    120_000,
  );
});
