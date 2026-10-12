// Route-level coverage for the design index and Jev routing API
// (docs/plans/2026-09-19-design-index-app-wiring-design.md section 5).
//
// `registerDesignIndexRoutes` is mounted on a bare Express app with a fake router, a fake
// profiler and a temp index file, so nothing here needs a TypeSafe key and nothing reaches the
// network. The real `sendApiError` is used, so the status/code/message envelope under test is the
// one the daemon actually sends. One boot test at the bottom goes through `startServer` instead,
// to prove the routes are registered on the real server rather than only in this harness.

import type http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApiErrorResponse,
  DesignIndexAddResponse,
  DesignIndexFindResponse,
  DesignIndexGetResponse,
  DesignIndexProfileResponse,
  DesignIndexRemoveResponse,
  DesignIndexTaxonomyResponse,
  DesignJudgment,
  DesignProfile,
  RouteDecision,
} from '@mish/contracts';
import { AGENCY_ROUTE_MAX_CHARS, DESIGN_INDEX_INPUT_MAX_CHARS } from '@mish/contracts';
import { loadAtlasData } from '@mish/agency-fast-lane/atlas';
import { htmlFacts } from '@mish/agency-fast-lane/html-facts';
import { resolveJevKey } from '@mish/agency-fast-lane/jev';
import { ProfileError, createJevProfiler, type ProfileInput } from '@mish/agency-fast-lane/profile';
import { RouteError, createJevRouter, type RouteInput } from '@mish/agency-fast-lane/route';
import { loadDesignTaxonomy } from '@mish/agency-fast-lane/taxonomy';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { JevKeyUnavailableError, jevKeyResolver, registerDesignIndexRoutes } from '../src/routes/design-index.js';

/** The config pair has its own suite (`agency-config.test.ts`); here it only has to exist. */
const unusedJevKeyStore = (dataDir: string) =>
  createAgencyJevKeyStore({
    dataDir,
    readVaultSecret: async () => {
      throw new Error('this suite never reads a key');
    },
  });

const { atlas, registry } = await loadAtlasData();
const taxonomy = await loadDesignTaxonomy();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function judgment(choice: string, probabilities: Record<string, number> = {}): DesignJudgment {
  const confidence = probabilities[choice] ?? 0.9;
  return { choice, confidence, probabilities: { [choice]: confidence, ...probabilities } };
}

function profileFixture(overrides: Partial<DesignProfile> = {}): DesignProfile {
  return {
    schema: 'design-profile/1',
    taxonomy: '1.0',
    model: 'jev-1.13.0',
    at: '2026-09-01T00:00:00.000Z',
    ms: 620,
    calls: 1,
    source: { kind: 'prompt', id: 'fixture', title: 'Fixture', chars: 12, digest: 'digest-fixture' },
    route: {
      spine: judgment('TL'),
      skin: judgment('Editorial'),
      format: judgment('Landing page'),
      action: judgment('contact'),
      family: judgment('none'),
      resolved: {},
    },
    sections: { hero: 0.9 },
    components: {},
    mechanics: {},
    depth: {},
    style: {
      ground: judgment('near-black'),
      accent: judgment('unspecified'),
      typography: judgment('unspecified'),
      imagery: judgment('unspecified'),
      topology: judgment('bento-grid'),
      density: judgment('unspecified'),
    },
    quality: { 'focal-discipline': { score: 3, legend: 'good', confidence: 0.8 } },
    truthRisk: 0.1,
    ...overrides,
  };
}

const ROUTED: RouteDecision = {
  decision: 'routed',
  spine: { code: 'TL', name: 'Trust Ladder', confidence: 0.82, probabilities: { TL: 0.82 } },
  spines: [{ code: 'TL', probability: 0.82 }],
  archetype: { id: 'TL-1', name: 'Local service', confidence: 0.7 },
  skin: { choice: 'Editorial', confidence: 0.6 },
  family: { id: 'wrenfield', probability: 0.71, basis: 'exact', transfer: 3 },
  candidates: [
    { family: 'wrenfield', probability: 0.71, basis: 'exact', transfer: 3, archetype: 'TL-1', skin: 'Editorial', viaSpine: 'TL' },
  ],
  warnings: [],
  ms: 610,
  calls: 1,
  model: 'jev-1.13.0',
};

const UNROUTED: RouteDecision = {
  decision: 'unrouted',
  reason: 'no bundled family within transfer >= 2 of spine CS',
  spine: { code: 'CS', name: 'Catalog Scan', confidence: 0.64, probabilities: { CS: 0.64 } },
  spines: [{ code: 'CS', probability: 0.64 }],
  skin: { choice: 'unspecified', confidence: 0.3 },
  candidates: [],
  warnings: [],
  ms: 590,
  calls: 1,
  model: 'jev-1.13.0',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
let tempRoot = '';
let routeImpl: (input: RouteInput) => Promise<RouteDecision>;
let profileImpl: (input: ProfileInput) => Promise<DesignProfile>;
let routeCalls: RouteInput[] = [];
let profileCalls: ProfileInput[] = [];

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-design-index-'));
  routeCalls = [];
  profileCalls = [];
  routeImpl = async () => ROUTED;
  profileImpl = async () => profileFixture();

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  registerDesignIndexRoutes(app, {
    http: { sendApiError } as never,
    designIndex: {
      atlas,
      registry,
      taxonomy,
      router: {
        route: async (input) => {
          routeCalls.push(input);
          return routeImpl(input);
        },
      },
      profiler: {
        profile: async (input) => {
          profileCalls.push(input);
          return profileImpl(input);
        },
      },
      jevKeyStore: unusedJevKeyStore(tempRoot),
      indexFile: path.join(tempRoot, 'index.json'),
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
  tempRoot = '';
});

const post = (url: string, body: unknown) =>
  fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (url: string) => fetch(`${baseUrl}${url}`);
const del = (url: string) => fetch(`${baseUrl}${url}`, { method: 'DELETE' });
const errorOf = async (response: Response) => (await response.json() as ApiErrorResponse).error;

/** Stores `profiles` through the public add endpoint, the way the CLI's `import` does. */
async function seed(profiles: DesignProfile[]): Promise<void> {
  for (const profile of profiles) {
    const response = await post('/api/design-index', { profile });
    expect(response.status).toBe(200);
  }
}

// ---------------------------------------------------------------------------
// GET /api/design-index/taxonomy
// ---------------------------------------------------------------------------

describe('GET /api/design-index/taxonomy', () => {
  it('serves the loaded taxonomy, so the web facets have a vocabulary', async () => {
    const response = await get('/api/design-index/taxonomy');
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexTaxonomyResponse;
    expect(body.taxonomy.version).toBe('1.0');
    expect(body.taxonomy.sections.map((label) => label.id)).toContain('hero');
    expect(Object.keys(body.taxonomy.style)).toEqual(
      expect.arrayContaining(['ground', 'accent', 'typography', 'imagery', 'topology', 'density']),
    );
  });

  it('is not shadowed by the :digest route', async () => {
    // Registration order is the only thing keeping `/taxonomy` from being read as a digest.
    const response = await get('/api/design-index/taxonomy');
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('taxonomy');
  });
});

// ---------------------------------------------------------------------------
// POST /api/agency/route
// ---------------------------------------------------------------------------

describe('POST /api/agency/route', () => {
  it('routes a brief and passes the resolution options through to the fast lane', async () => {
    const response = await post('/api/agency/route', {
      brief: 'A family dental practice in Riverbend that wants more bookings.',
      threshold: 0.6,
      minTransfer: 1,
      spineShare: 0.4,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ decision: ROUTED });
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]).toMatchObject({
      brief: 'A family dental practice in Riverbend that wants more bookings.',
      threshold: 0.6,
      minTransfer: 1,
      spineShare: 0.4,
    });
  });

  it('returns an unrouted decision as a 200 result, not an error', async () => {
    routeImpl = async () => UNROUTED;
    const response = await post('/api/agency/route', { brief: 'A tool catalogue.' });
    expect(response.status).toBe(200);
    const body = await response.json() as { decision: RouteDecision };
    expect(body.decision.decision).toBe('unrouted');
    expect(body.decision.spine.code).toBe('CS');
    expect(body.decision.reason).toContain('no bundled family');
  });

  it.each([
    ['brief missing', {}],
    ['brief not a string', { brief: 42 }],
    ['brief empty after trim', { brief: '   \n ' }],
    ['brief over the cap', { brief: 'x'.repeat(AGENCY_ROUTE_MAX_CHARS + 1) }],
    ['threshold not a number', { brief: 'a brief', threshold: 'high' }],
    ['threshold out of range', { brief: 'a brief', threshold: 1.5 }],
    ['minTransfer out of range', { brief: 'a brief', minTransfer: 9 }],
    ['spineShare out of range', { brief: 'a brief', spineShare: -1 }],
  ])('rejects %s with 400 and never calls Jev', async (_label, body) => {
    const response = await post('/api/agency/route', body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(routeCalls).toHaveLength(0);
  });

  it('answers 503 JEV_UNAVAILABLE when the key cannot be resolved', async () => {
    routeImpl = async () => {
      throw new JevKeyUnavailableError();
    };
    const response = await post('/api/agency/route', { brief: 'a brief' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('JEV_UNAVAILABLE');
  });

  it('answers 502 JEV_FAILED without echoing Jev\'s response body', async () => {
    routeImpl = async () => {
      throw new RouteError('jev 422: {"detail":"state.brief: RIVERBEND-DENTAL-SECRET"}');
    };
    const response = await post('/api/agency/route', { brief: 'a brief' });
    expect(response.status).toBe(502);
    const error = await errorOf(response);
    expect(error.code).toBe('JEV_FAILED');
    // A 4xx from Jev can carry the request back, and the request is the caller's own brief.
    expect(JSON.stringify(error)).not.toContain('RIVERBEND-DENTAL-SECRET');
    expect(JSON.stringify(error)).not.toContain('422');
  });

  it('never echoes the TypeSafe key when Jev rejects it', async () => {
    // A 401 from Jev is the failure a misconfigured key produces, and an upstream that names the
    // credential it refused — or a fetch layer that puts the request headers in the message —
    // would otherwise carry that key straight into a client response and the daemon log.
    const key = 'sk-typesafe-NEVER-IN-A-RESPONSE';
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      for (const impl of [
        () => new RouteError(`jev 401: {"detail":"invalid api key ${key}"}`),
        () => new TypeError(`fetch failed: Authorization: Bearer ${key}`),
      ]) {
        routeImpl = async () => {
          throw impl();
        };
        const response = await post('/api/agency/route', { brief: 'a brief' });
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(key);
      }
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(logged)).not.toContain(key);
  });

  it('answers 502 JEV_FAILED on a transport failure', async () => {
    routeImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const response = await post('/api/agency/route', { brief: 'a brief' });
    expect(response.status).toBe(502);
    expect((await errorOf(response)).code).toBe('JEV_FAILED');
  });

  it('writes nothing of Jev’s response body to the daemon log either', async () => {
    const marker = 'RIVERBEND-DENTAL-SECRET';
    routeImpl = async () => {
      throw new RouteError(`jev 422: {"detail":"state.brief: ${marker}"}`);
    };
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const response = await post('/api/agency/route', { brief: 'a brief' });
      expect(response.status).toBe(502);
    } finally {
      spy.mockRestore();
    }
    // The daemon may say a Jev call failed; it may not say what Jev said back.
    expect(JSON.stringify(logged)).not.toContain(marker);
    expect(JSON.stringify(logged)).not.toContain('422');
  });

  it.each([
    ['threshold not a number', { brief: 'a brief', threshold: 'high' }],
    ['minTransfer not a number', { brief: 'a brief', minTransfer: 'far' }],
    ['spineShare not a number', { brief: 'a brief', spineShare: null }],
  ])('rejects %s on the route endpoint', async (_label, body) => {
    const response = await post('/api/agency/route', body);
    expect(response.status).toBe(400);
    expect(routeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/design-index/profile
// ---------------------------------------------------------------------------

describe('POST /api/design-index/profile', () => {
  it('profiles without storing when `add` is absent', async () => {
    const response = await post('/api/design-index/profile', { kind: 'brief', input: 'A dental practice.' });
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexProfileResponse;
    expect(body.added).toBe(false);
    expect(body.profile.schema).toBe('design-profile/1');

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(0);
  });

  it('stores when `add` is true, and reports added:false for the same input again', async () => {
    const first = await post('/api/design-index/profile', { kind: 'brief', input: 'A dental practice.', add: true });
    expect((await first.json() as DesignIndexProfileResponse).added).toBe(true);

    const second = await post('/api/design-index/profile', { kind: 'brief', input: 'A dental practice.', add: true });
    expect((await second.json() as DesignIndexProfileResponse).added).toBe(false);

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(1);
  });

  it('carries kind, title, ref and id into the profiler source', async () => {
    await post('/api/design-index/profile', {
      kind: 'spec',
      input: 'A spec.',
      title: 'Riverbend spec',
      ref: 'https://example.test/spec',
      id: 'spec-1',
    });
    expect(profileCalls[0]!.source).toEqual({
      kind: 'spec',
      id: 'spec-1',
      title: 'Riverbend spec',
      ref: 'https://example.test/spec',
    });
  });

  it('derives text and facts from the page for kind: html, exactly as the CLI does', async () => {
    const html = '<html><head><title>Riverbend</title></head><body><main><h1>Book a visit</h1><p>Open Saturdays.</p><video></video></main></body></html>';
    await post('/api/design-index/profile', { kind: 'html', input: html });
    const expected = htmlFacts(html);
    expect(profileCalls).toHaveLength(1);
    expect(profileCalls[0]!.text).toBe(expected.text);
    expect(profileCalls[0]!.facts).toEqual(expected);
  });

  it('sends the raw input as text for a non-html kind, with no facts', async () => {
    await post('/api/design-index/profile', { kind: 'prompt', input: 'A near-black hero.' });
    expect(profileCalls[0]!.text).toBe('A near-black hero.');
    expect(profileCalls[0]!.facts).toBeUndefined();
  });

  it.each([
    ['kind missing', { input: 'text' }],
    ['kind not one of the four', { kind: 'pdf', input: 'text' }],
    ['input missing', { kind: 'brief' }],
    ['input empty', { kind: 'brief', input: '' }],
    ['input over the cap', { kind: 'brief', input: 'x'.repeat(DESIGN_INDEX_INPUT_MAX_CHARS + 1) }],
    ['add not a boolean', { kind: 'brief', input: 'text', add: 'yes' }],
    ['title not a string', { kind: 'brief', input: 'text', title: 7 }],
    ['ref not a string', { kind: 'brief', input: 'text', ref: 7 }],
    ['id not a string', { kind: 'brief', input: 'text', id: 7 }],
    ['threshold out of range', { kind: 'brief', input: 'text', threshold: 3 }],
  ])('rejects %s with 400 and never calls Jev', async (_label, body) => {
    const response = await post('/api/design-index/profile', body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(profileCalls).toHaveLength(0);
  });

  it('answers 503 when the key cannot be resolved', async () => {
    profileImpl = async () => {
      throw new JevKeyUnavailableError();
    };
    const response = await post('/api/design-index/profile', { kind: 'brief', input: 'text' });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('JEV_UNAVAILABLE');
  });

  it('never echoes the key, the upstream body or the profiled page when a profile call fails', async () => {
    // A failed profile has three things worth leaking and none that may: the credential, Jev's
    // own response body (a 4xx can carry the request back), and the page that was profiled —
    // which for `kind: 'html'` is whatever the user uploaded. All three are checked against the
    // response AND the log, because a console line reaches a support bundle just as a body does.
    const key = 'sk-typesafe-NEVER-IN-A-RESPONSE';
    const page = 'RIVERBEND-PATIENT-INTAKE-NOTES';
    const taxonomyText = taxonomy.sections[0]?.definition ?? '';
    expect(taxonomyText.length).toBeGreaterThan(0);

    const logged: unknown[][] = [];
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    let body: string;
    let status: number;
    try {
      profileImpl = async () => {
        throw new ProfileError(
          `jev 401: {"detail":"invalid api key ${key}","state":{"text":"${page}"},"questions":{"hero":"${taxonomyText}"}}`,
          401,
        );
      };
      const response = await post('/api/design-index/profile', { kind: 'brief', input: page });
      status = response.status;
      body = await response.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(status).toBe(502);
    const captured = JSON.stringify(logged);
    for (const secret of [key, page, taxonomyText]) {
      expect(body, 'the response must not carry it').not.toContain(secret);
      expect(captured, 'the daemon log must not carry it either').not.toContain(secret);
    }
  });

  it('answers 502 for a Jev HTTP failure and for a malformed-answer ProfileError alike', async () => {
    profileImpl = async () => {
      throw new ProfileError('jev 422', 422);
    };
    const http422 = await post('/api/design-index/profile', { kind: 'brief', input: 'text' });
    expect(http422.status).toBe(502);
    expect((await errorOf(http422)).code).toBe('JEV_FAILED');

    // A malformed-answer ProfileError carries no `status` at all; it is still a failed profile.
    profileImpl = async () => {
      throw new ProfileError('malformed answer spine: choice is not one of the offered options');
    };
    const malformed = await post('/api/design-index/profile', { kind: 'brief', input: 'text' });
    expect(malformed.status).toBe(502);
    expect((await errorOf(malformed)).code).toBe('JEV_FAILED');
  });

  it.each([
    ['threshold not a number', { kind: 'brief', input: 'text', threshold: 'high' }],
    ['minTransfer out of range', { kind: 'brief', input: 'text', minTransfer: 9 }],
    ['minTransfer negative', { kind: 'brief', input: 'text', minTransfer: -1 }],
    ['spineShare out of range', { kind: 'brief', input: 'text', spineShare: 2 }],
    ['spineShare not a number', { kind: 'brief', input: 'text', spineShare: 'wide' }],
  ])('rejects %s on the profile endpoint and never calls Jev', async (_label, body) => {
    const response = await post('/api/design-index/profile', body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
    expect(profileCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/design-index (store an already-computed profile)
// ---------------------------------------------------------------------------

describe('POST /api/design-index', () => {
  it('stores a profile and reports the index size', async () => {
    const response = await post('/api/design-index', { profile: profileFixture({ source: { kind: 'prompt', chars: 9, digest: 'd1' } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexAddResponse;
    expect(body.added).toBe(true);
    expect(body.total).toBe(1);
  });

  it('refuses a duplicate digest and returns the stored profile', async () => {
    const first = profileFixture({ source: { kind: 'prompt', title: 'First', chars: 9, digest: 'd1' } });
    const second = profileFixture({ source: { kind: 'prompt', title: 'Second', chars: 9, digest: 'd1' } });
    await seed([first]);
    const response = await post('/api/design-index', { profile: second });
    const body = await response.json() as DesignIndexAddResponse;
    expect(body.added).toBe(false);
    expect(body.replaced).toBe(false);
    expect(body.total).toBe(1);
    expect(body.profile.source.title).toBe('First');
  });

  it.each([
    ['no profile', {}],
    ['wrong schema', { profile: { schema: 'design-profile/2', source: { digest: 'd1' } } }],
    ['no digest', { profile: { schema: 'design-profile/1', source: {} } }],
    ['empty digest', { profile: { schema: 'design-profile/1', source: { digest: '' } } }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await post('/api/design-index', body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('serialises concurrent adds so none is lost', async () => {
    const profiles = Array.from({ length: 10 }, (_unused, index) =>
      profileFixture({ source: { kind: 'prompt', id: `p${index}`, chars: 9, digest: `digest-${index}` } }));
    // Without the store's promise chain each request would read the same index and the last
    // atomic rename would win, dropping nine of the ten.
    const responses = await Promise.all(profiles.map((profile) => post('/api/design-index', { profile })));
    for (const response of responses) expect(response.status).toBe(200);

    const listed = await (await get('/api/design-index?limit=500')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(10);
    expect(new Set(listed.profiles.map((profile) => profile.source.digest)).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// POST /api/design-index with `replace`
// ---------------------------------------------------------------------------

describe('POST /api/design-index with replace', () => {
  const stored = (title: string, digest: string) =>
    profileFixture({ source: { kind: 'prompt', title, chars: 9, digest } });

  it('overwrites the stored profile of the same digest, in the position it already had', async () => {
    await seed([stored('First', 'd1'), stored('Other', 'd2')]);

    const response = await post('/api/design-index', { profile: stored('Second', 'd1'), replace: true });
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexAddResponse;
    expect(body.added).toBe(false);
    expect(body.replaced).toBe(true);
    expect(body.total).toBe(2);
    expect(body.profile.source.title).toBe('Second');

    const read = await (await get('/api/design-index/d1')).json() as DesignIndexGetResponse;
    expect(read.profile.source.title).toBe('Second');
    // Replaced in place: `d1` is still the first entry, not moved to the end of the file.
    const file = JSON.parse(readFileSync(path.join(tempRoot, 'index.json'), 'utf8')) as { profiles: DesignProfile[] };
    expect(file.profiles.map((profile) => profile.source.digest)).toEqual(['d1', 'd2']);
  });

  it('stores a digest that is not in the index yet, reporting added rather than replaced', async () => {
    const response = await post('/api/design-index', { profile: stored('Fresh', 'd-new'), replace: true });
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexAddResponse;
    expect(body.added).toBe(true);
    expect(body.replaced).toBe(false);
    expect(body.total).toBe(1);
  });

  it('without the flag leaves the stored profile alone and reports neither added nor replaced', async () => {
    await seed([stored('First', 'd1')]);

    const body = await (await post('/api/design-index', { profile: stored('Second', 'd1') })).json() as DesignIndexAddResponse;
    expect(body.added).toBe(false);
    expect(body.replaced).toBe(false);

    const read = await (await get('/api/design-index/d1')).json() as DesignIndexGetResponse;
    expect(read.profile.source.title).toBe('First');
  });

  it('serialises concurrent replaces of one digest into a single entry', async () => {
    await seed([stored('First', 'd1')]);
    // Each request reads, replaces and saves inside the store's one serialize callback. Were the
    // read and the save separate steps, ten replaces would each write their own copy of `d1`.
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        post('/api/design-index', { profile: stored(`Take ${index}`, 'd1'), replace: true })),
    );
    for (const response of responses) expect(response.status).toBe(200);

    const listed = await (await get('/api/design-index?limit=500')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(1);
    expect(listed.profiles.map((profile) => profile.source.digest)).toEqual(['d1']);
    const file = JSON.parse(readFileSync(path.join(tempRoot, 'index.json'), 'utf8')) as { profiles: DesignProfile[] };
    expect(file.profiles).toHaveLength(1);
  });

  it.each([['a string', 'yes'], ['a number', 1], ['null', null]])(
    'rejects %s as replace with 400 and stores nothing',
    async (_label, replace) => {
      const response = await post('/api/design-index', { profile: stored('First', 'd1'), replace });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('BAD_REQUEST');

      const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
      expect(listed.total).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// POST /api/design-index — what actually gets persisted
// ---------------------------------------------------------------------------

describe('POST /api/design-index rebuilds the profile it stores', () => {
  it('strips unknown fields, so a page smuggled in as source.text is never persisted', async () => {
    const smuggled = {
      ...profileFixture({ source: { kind: 'html', chars: 9, digest: 'd-smuggle' } }),
      input: '<html>the whole page</html>',
      trackingBlob: { campaign: 'x' },
      source: {
        kind: 'html',
        chars: 9,
        digest: 'd-smuggle',
        title: 'Kept',
        text: '<html>the whole page</html>',
      },
    };

    const added = await post('/api/design-index', { profile: smuggled });
    expect(added.status).toBe(200);
    const stored = (await added.json() as DesignIndexAddResponse).profile as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty('input');
    expect(stored).not.toHaveProperty('trackingBlob');
    expect(stored.source).not.toHaveProperty('text');
    expect((stored.source as Record<string, unknown>).title).toBe('Kept');

    // And never comes back on a later read either — the file is what the route wrote.
    const fetched = await (await get('/api/design-index/d-smuggle')).json() as DesignIndexGetResponse;
    const readBack = fetched.profile as unknown as Record<string, unknown>;
    expect(readBack).not.toHaveProperty('input');
    expect(readBack.source).not.toHaveProperty('text');
    expect(JSON.stringify(fetched)).not.toContain('the whole page');
  });

  it('rejects a minimal object carrying only the fields the old check looked at', async () => {
    // This one used to be stored, and then broke every read that expects `at`, `route` or `style`.
    const response = await post('/api/design-index', {
      profile: { schema: 'design-profile/1', source: { kind: 'prompt', chars: 1, digest: 'd-min' } },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(0);
  });

  it.each([
    ['taxonomy missing', (profile: Record<string, unknown>) => { delete profile.taxonomy; }],
    ['model missing', (profile: Record<string, unknown>) => { delete profile.model; }],
    ['at missing', (profile: Record<string, unknown>) => { delete profile.at; }],
    ['at not an ISO date', (profile: Record<string, unknown>) => { profile.at = '19 September 2026'; }],
    ['ms negative', (profile: Record<string, unknown>) => { profile.ms = -1; }],
    ['calls not finite', (profile: Record<string, unknown>) => { profile.calls = 'many'; }],
    ['chars negative', (profile: Record<string, unknown>) => { (profile.source as Record<string, unknown>).chars = -3; }],
    ['calls fractional', (profile: Record<string, unknown>) => { profile.calls = 0.5; }],
    ['chars fractional', (profile: Record<string, unknown>) => { (profile.source as Record<string, unknown>).chars = 1.5; }],
    ['usage tokens fractional', (profile: Record<string, unknown>) => { profile.usage = { input_tokens: 10.5, output_tokens: 3 }; }],
    ['digest empty', (profile: Record<string, unknown>) => { (profile.source as Record<string, unknown>).digest = ''; }],
    ['kind not one of the four', (profile: Record<string, unknown>) => { (profile.source as Record<string, unknown>).kind = 'pdf'; }],
    ['truthRisk above 1', (profile: Record<string, unknown>) => { profile.truthRisk = 1.4; }],
    ['truthRisk below 0', (profile: Record<string, unknown>) => { profile.truthRisk = -0.1; }],
    ['a section probability above 1', (profile: Record<string, unknown>) => { profile.sections = { hero: 1.2 }; }],
    ['a section probability not a number', (profile: Record<string, unknown>) => { profile.sections = { hero: 'high' }; }],
    ['route missing', (profile: Record<string, unknown>) => { delete profile.route; }],
    ['route.spine confidence out of range', (profile: Record<string, unknown>) => {
      ((profile.route as Record<string, unknown>).spine as Record<string, unknown>).confidence = 4;
    }],
    ['route.resolved.transfer above the atlas maximum', (profile: Record<string, unknown>) => {
      (profile.route as Record<string, unknown>).resolved = { transfer: 9 };
    }],
    ['style missing an axis', (profile: Record<string, unknown>) => { delete (profile.style as Record<string, unknown>).density; }],
    ['a quality score above 4', (profile: Record<string, unknown>) => {
      profile.quality = { 'focal-discipline': { score: 9, legend: 'good', confidence: 0.5 } };
    }],
    ['a quality confidence above 1', (profile: Record<string, unknown>) => {
      profile.quality = { 'focal-discipline': { score: 2, legend: 'good', confidence: 1.5 } };
    }],
    ['usage token count negative', (profile: Record<string, unknown>) => { profile.usage = { input_tokens: -1, output_tokens: 2 }; }],
    ['a meta value that is an object', (profile: Record<string, unknown>) => { profile.meta = { nested: { a: 1 } }; }],
    ['schema of another version', (profile: Record<string, unknown>) => { profile.schema = 'design-profile/2'; }],
  ])('rejects %s with 400 and stores nothing', async (_label, corrupt) => {
    const profile = JSON.parse(JSON.stringify(profileFixture())) as Record<string, unknown>;
    corrupt(profile);

    const response = await post('/api/design-index', { profile });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toMatch(/^profile\./);

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(0);
  });

  it('keeps every allowlisted optional field it was given', async () => {
    const full = profileFixture({
      source: { kind: 'html', id: 'page-1', title: 'Riverbend', ref: 'https://example.test/', chars: 42, digest: 'd-full' },
      usage: { input_tokens: 20_000, output_tokens: 900 },
      meta: { total_likes: 42, curated: true, collection: 'catalog-25' },
    });
    full.route.archetype = judgment('TL-1');
    full.route.resolved = { archetypeId: 'TL-1', familyId: 'wrenfield', basis: 'exact', transfer: 3 };

    const response = await post('/api/design-index', { profile: full });
    expect(response.status).toBe(200);
    expect((await response.json() as DesignIndexAddResponse).profile).toEqual(full);
  });
});

// ---------------------------------------------------------------------------
// POST /api/design-index — the three meta keys the app itself consumes
// ---------------------------------------------------------------------------

describe('POST /api/design-index validates the meta keys the app consumes', () => {
  const withMeta = (meta: Record<string, unknown>) => ({
    ...profileFixture({ source: { kind: 'prompt', chars: 9, digest: 'd-meta' } }),
    meta,
  });

  it('stores all three when they are valid, alongside the free-form meta values', async () => {
    const meta = {
      catalogId: 'urban-jungle-hero',
      previewImage: 'https://cdn.example.test/urban-jungle-hero.jpg',
      previewVideo: 'https://cdn.example.test/urban-jungle-hero.mp4',
      total_likes: 42,
      curated: true,
    };

    const response = await post('/api/design-index', { profile: withMeta(meta) });
    expect(response.status).toBe(200);
    expect((await response.json() as DesignIndexAddResponse).profile.meta).toEqual(meta);
  });

  it.each(['previewImage', 'previewVideo'] as const)('accepts an https: URL for %s on its own', async (key) => {
    const response = await post('/api/design-index', { profile: withMeta({ [key]: 'https://cdn.example.test/a.mp4' }) });
    expect(response.status).toBe(200);
  });

  it('accepts a catalogId of exactly the 128-character maximum', async () => {
    const response = await post('/api/design-index', { profile: withMeta({ catalogId: 'c'.repeat(128) }) });
    expect(response.status).toBe(200);
  });

  // `new URL` parses every one of these, so only the protocol test refuses them; a card built
  // from an unchecked meta value would hand the browser the URL as media.
  const badUrls: [string, unknown][] = [
    ['an http: URL', 'http://cdn.example.test/a.jpg'],
    ['a data: URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a malformed URL', 'cdn.example.test/a.jpg'],
    ['an empty string', ''],
    ['an over-long URL', `https://cdn.example.test/${'a'.repeat(2_048)}`],
    ['a number', 7],
  ];

  it.each(
    (['previewImage', 'previewVideo'] as const).flatMap((key) =>
      badUrls.map(([label, value]) => [key, label, value] as const)),
  )('rejects %s as %s with a 400 naming the key', async (key, _label, value) => {
    const response = await post('/api/design-index', { profile: withMeta({ [key]: value }) });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain(`profile.meta.${key}`);

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(0);
  });

  it.each([
    ['an over-long value', 'c'.repeat(129)],
    ['an empty string', ''],
    ['a number', 7],
    ['a boolean', true],
  ])('rejects a catalogId that is %s with a 400 naming the key', async (_label, value) => {
    const response = await post('/api/design-index', { profile: withMeta({ catalogId: value }) });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('profile.meta.catalogId');

    const listed = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(listed.total).toBe(0);
  });

  it('leaves every other meta key on the old primitive rule', async () => {
    const meta = { preview: '/local/path/shot.png', total_likes: 42, curated: false, note: '' };
    const response = await post('/api/design-index', { profile: withMeta(meta) });
    expect(response.status).toBe(200);
    expect((await response.json() as DesignIndexAddResponse).profile.meta).toEqual(meta);
  });
});

// ---------------------------------------------------------------------------
// The index file itself — a profile that never went through POST
// ---------------------------------------------------------------------------

describe('profiles read back from the index file are normalised through the same parser', () => {
  // Our own string, invented for this test: it stands for whatever a legacy or hand-made index
  // might carry in `source.text`, which is the profiled page itself.
  const SENTINEL = 'SENTINEL-STORED-SOURCE-TEXT-MUST-NOT-REACH-THE-BROWSER-51';

  /** Writes `profiles` straight into the store's file, bypassing every route. */
  function seedFile(profiles: unknown[]): void {
    writeFileSync(
      path.join(tempRoot, 'index.json'),
      `${JSON.stringify({ schema: 'design-index/1', profiles }, null, 2)}\n`,
    );
  }

  /** A well-formed profile that also carries the two things the parser is there to drop. */
  const withSmuggledText = {
    ...profileFixture({ source: { kind: 'html', id: 'legacy-ok', title: 'Kept', chars: 9, digest: 'd-disk-ok' } }),
    trackingBlob: { campaign: SENTINEL },
    source: { kind: 'html', id: 'legacy-ok', title: 'Kept', chars: 9, digest: 'd-disk-ok', text: SENTINEL },
  };

  /** A legacy entry of the shape the old check accepted: no `at`, no `route`, no `style`. */
  const legacyBroken = { schema: 'design-profile/1', source: { kind: 'prompt', chars: 1, digest: 'd-disk-legacy' } };

  const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  let warn: ReturnType<typeof silenceWarn>;

  beforeEach(() => {
    warn = silenceWarn();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('serves the list without source.text, without the unknown field, and without the bad entry', async () => {
    seedFile([withSmuggledText, legacyBroken]);

    const response = await get('/api/design-index');
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(SENTINEL);

    const body = JSON.parse(raw) as DesignIndexFindResponse;
    expect(body.total).toBe(1);
    expect(body.matched).toBe(1);
    expect(body.profiles).toHaveLength(1);

    const served = body.profiles[0] as unknown as Record<string, unknown>;
    expect(served).not.toHaveProperty('trackingBlob');
    expect(served.source).not.toHaveProperty('text');
    expect((served.source as Record<string, unknown>).title).toBe('Kept');
  });

  it('serves the same normalised profile from GET /:digest', async () => {
    seedFile([withSmuggledText, legacyBroken]);

    const response = await get('/api/design-index/d-disk-ok');
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(SENTINEL);

    const readBack = (JSON.parse(raw) as DesignIndexGetResponse).profile as unknown as Record<string, unknown>;
    expect(readBack).not.toHaveProperty('trackingBlob');
    expect(readBack.source).not.toHaveProperty('text');
    expect((readBack.source as Record<string, unknown>).digest).toBe('d-disk-ok');
  });

  it('answers 404 for the entry the parser refused, rather than serving it', async () => {
    seedFile([withSmuggledText, legacyBroken]);

    const response = await get('/api/design-index/d-disk-legacy');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('NOT_FOUND');
  });

  it('warns once per refused entry, naming the digest and the reason, and still serves the rest', async () => {
    seedFile([withSmuggledText, legacyBroken]);

    const body = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(body.total).toBe(1);

    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('d-disk-legacy');
    expect(lines[0]).toMatch(/profile\.taxonomy/);
  });

  it('names the position when a refused entry has no digest to name', async () => {
    seedFile([{ not: 'a profile at all' }]);

    const body = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(body.total).toBe(0);
    expect(String(warn.mock.calls[0]?.[0])).toContain('entry 0');
  });

  it('writes the sanitised set back on the next save, so the bad entry leaves the file', async () => {
    seedFile([withSmuggledText, legacyBroken]);

    const added = await post('/api/design-index', {
      profile: profileFixture({ source: { kind: 'prompt', chars: 9, digest: 'd-disk-new' } }),
    });
    expect(added.status).toBe(200);

    const onDisk = readFileSync(path.join(tempRoot, 'index.json'), 'utf8');
    expect(onDisk).not.toContain(SENTINEL);
    expect(onDisk).not.toContain('d-disk-legacy');
    const stored = JSON.parse(onDisk) as { profiles: DesignProfile[] };
    expect(stored.profiles.map((profile) => profile.source.digest)).toEqual(['d-disk-ok', 'd-disk-new']);
  });
});

// ---------------------------------------------------------------------------
// GET /api/design-index (search and list)
// ---------------------------------------------------------------------------

describe('GET /api/design-index', () => {
  const near = profileFixture({
    at: '2026-09-01T00:00:00.000Z',
    source: { kind: 'prompt', id: 'near', title: 'Near black hero', chars: 9, digest: 'd-near' },
    sections: { hero: 0.9, pricing: 0.8 },
  });
  const paper = profileFixture({
    at: '2026-09-02T00:00:00.000Z',
    source: { kind: 'prompt', id: 'paper', title: 'Paper hero', chars: 9, digest: 'd-paper' },
    sections: { hero: 0.6 },
    style: { ...profileFixture().style, ground: judgment('light-paper') },
  });
  const footer = profileFixture({
    at: '2026-09-03T00:00:00.000Z',
    source: { kind: 'prompt', id: 'footer', title: 'Footer only', chars: 9, digest: 'd-footer' },
    sections: { footer: 0.9 },
  });

  beforeEach(async () => {
    await seed([near, paper, footer]);
  });

  it('lists the whole index newest first when no filter is given', async () => {
    const body = await (await get('/api/design-index')).json() as DesignIndexFindResponse;
    expect(body.total).toBe(3);
    expect(body.matched).toBe(3);
    expect(body.profiles.map((profile) => profile.source.id)).toEqual(['footer', 'paper', 'near']);
  });

  it('applies limit while still reporting the full match count', async () => {
    const body = await (await get('/api/design-index?limit=1')).json() as DesignIndexFindResponse;
    expect(body.profiles).toHaveLength(1);
    expect(body.matched).toBe(3);
    expect(body.total).toBe(3);
  });

  it('repeats a list key to require every value', async () => {
    const body = await (await get('/api/design-index?section=hero&section=pricing')).json() as DesignIndexFindResponse;
    expect(body.profiles.map((profile) => profile.source.id)).toEqual(['near']);
    expect(body.matched).toBe(1);
    expect(body.total).toBe(3);
  });

  it('uses min as the probability a label needs to count as present', async () => {
    const atDefault = await (await get('/api/design-index?section=hero')).json() as DesignIndexFindResponse;
    expect(atDefault.profiles.map((profile) => profile.source.id)).toEqual(['near', 'paper']);

    const stricter = await (await get('/api/design-index?section=hero&min=0.8')).json() as DesignIndexFindResponse;
    expect(stricter.profiles.map((profile) => profile.source.id)).toEqual(['near']);
  });

  it('filters on a scalar style key', async () => {
    const body = await (await get('/api/design-index?ground=near-black')).json() as DesignIndexFindResponse;
    expect(body.profiles.map((profile) => profile.source.id).sort()).toEqual(['footer', 'near']);
  });

  it('ignores an unknown query key', async () => {
    const body = await (await get('/api/design-index?nonsense=hero')).json() as DesignIndexFindResponse;
    expect(body.matched).toBe(3);
  });

  it.each([
    ['min out of range', '?min=2'],
    ['min not a number', '?min=high'],
    ['limit over the maximum', '?limit=501'],
    ['limit below one', '?limit=0'],
  ])('rejects %s with 400', async (_label, query) => {
    const response = await get(`/api/design-index${query}`);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('BAD_REQUEST');
  });

  it('rejects a repeated scalar filter key rather than guessing which value was meant', async () => {
    const response = await get('/api/design-index?skin=Editorial&skin=Luxury');
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain('accepts a single value');
  });

  it('rejects a label that is not in the taxonomy, naming the valid ids', async () => {
    const response = await get('/api/design-index?section=not-a-section');
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toContain('not-a-section');
    expect(error.message).toContain('hero');
  });
});

// ---------------------------------------------------------------------------
// GET / DELETE /api/design-index/:digest
// ---------------------------------------------------------------------------

describe('GET and DELETE /api/design-index/:digest', () => {
  const stored = profileFixture({ source: { kind: 'prompt', id: 'one', chars: 9, digest: 'd-one' } });

  it('reads one stored profile', async () => {
    await seed([stored]);
    const response = await get('/api/design-index/d-one');
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexGetResponse;
    expect(body.profile.source.id).toBe('one');
  });

  it('answers 404 for an unknown digest', async () => {
    const response = await get('/api/design-index/nope');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('NOT_FOUND');
  });

  it('removes a profile, after which reading it is a 404', async () => {
    await seed([stored]);
    const removed = await del('/api/design-index/d-one');
    expect(removed.status).toBe(200);
    expect(await removed.json() as DesignIndexRemoveResponse).toEqual({ removed: true, total: 0 });
    expect((await get('/api/design-index/d-one')).status).toBe(404);
  });

  it('answers 404 when removing a digest that is not stored', async () => {
    const response = await del('/api/design-index/nope');
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// The Jev key: never at startup, once per process, never in a log
// ---------------------------------------------------------------------------

describe('the Jev key resolver', () => {
  let keyServer: http.Server;
  let keyUrl: string;
  let keyRoot = '';
  let reads = 0;

  beforeEach(async () => {
    reads = 0;
    keyRoot = mkdtempSync(path.join(tmpdir(), 'od-design-index-key-'));
    // Composed exactly as server.ts composes it, including the shared cache, but over a fake
    // secret reader and a fake fetch so the test never touches the vault or the network.
    const apiKey = resolveJevKey(jevKeyResolver(async () => {
      reads += 1;
      return 'a-key-that-is-never-logged';
    }));
    const fetchImpl = (async () => new Response(
      JSON.stringify({ model: 'jev-1.13.0', answers: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    const app = express();
    app.use(express.json());
    registerDesignIndexRoutes(app, {
      http: { sendApiError } as never,
      designIndex: {
        atlas,
        registry,
        taxonomy,
        router: createJevRouter({ apiKey, fetchImpl }),
        profiler: createJevProfiler({ apiKey, fetchImpl }),
        jevKeyStore: unusedJevKeyStore(keyRoot),
        indexFile: path.join(keyRoot, 'index.json'),
      },
    });
    keyServer = app.listen(0);
    await new Promise<void>((resolve) => keyServer.once('listening', () => resolve()));
    keyUrl = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => keyServer.close(() => resolve()));
    if (keyRoot) rmSync(keyRoot, { force: true, recursive: true });
    keyRoot = '';
  });

  it('is not read at startup, nor by a read-only request, and is read once for the first Jev call', async () => {
    // Registering the routes is the whole of this daemon's startup work for this surface.
    expect(reads).toBe(0);

    expect((await fetch(`${keyUrl}/api/design-index/taxonomy`)).status).toBe(200);
    expect((await fetch(`${keyUrl}/api/design-index`)).status).toBe(200);
    expect(reads, 'a read-only request must never reach the secret store').toBe(0);

    const first = await fetch(`${keyUrl}/api/agency/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'A dental practice.' }),
    });
    expect(first.status).toBe(200);
    expect(reads).toBe(1);

    // Cached for the life of the process: a second request does not shell out again.
    await fetch(`${keyUrl}/api/agency/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'Another brief.' }),
    });
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Boot: the routes are registered on the real server
// ---------------------------------------------------------------------------

describe('design index routes on a booted daemon', () => {
  let bootedServer: http.Server;
  let bootedUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const { startServer } = await import('../src/server.js');
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    bootedUrl = started.url;
    bootedServer = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => bootedServer.close(() => resolve()));
  });

  /**
   * The harness at the top of this file builds its own Express app, so the ordering that matters
   * — the global body parser, then this route's parse-failure handler — is only really proven
   * here, on the booted daemon.
   *
   * Every spelling Express will route to the PUT handler has to be sanitized, not just the one
   * the client library happens to send. With `case sensitive routing` and `strict routing` both
   * left at their defaults, Express matches the path case-insensitively and tolerates one
   * trailing slash, so a sanitizer keyed on an exact lower-case string lets the other spellings
   * fall through to Express's default error handler with the credential still in the message.
   */
  const putMalformed = (path: string, marker: string, method = 'PUT') =>
    fetch(`${bootedUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: `{"apiKey":"${marker}"`,
    });

  it.each([
    ['the canonical path', '/api/agency/config'],
    ['a trailing slash', '/api/agency/config/'],
    ['upper case', '/API/AGENCY/CONFIG'],
    ['mixed case with a trailing slash', '/api/Agency/Config/'],
  ])('sanitizes a malformed body sent with %s', async (_label, path) => {
    const marker = 'sk-typesafe-BOOTED-DAEMON-MARKER';
    const logged: unknown[][] = [];
    const spies = (['error', 'warn', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
    let response: Response;
    let text: string;
    try {
      response = await putMalformed(path, marker);
      text = await response.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(response.status).toBe(400);
    expect(text).not.toContain(marker);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'BAD_REQUEST',
      details: { kind: 'agency-jev-config', reason: 'shape' },
    });
    expect(JSON.stringify(logged)).not.toContain(marker);
  });

  it.each([
    // Controls. Neither of these reaches the config route — a percent-encoded spelling and a
    // doubled slash both 404 on a well-formed body — so neither may be quietly absorbed by a
    // sanitizer that has drifted wider than the route it belongs to.
    ['another path', '/api/agency/%63onfig', 'PUT'],
    ['a doubled slash', '/api/agency/config//', 'PUT'],
    ['the wrong method on the right path', '/api/agency/config', 'POST'],
  ])('leaves %s to the handlers that already own it', async (_label, path, method) => {
    const response = await putMalformed(path, 'sk-typesafe-CONTROL-MARKER', method);
    const body = await response.text();
    const details = (() => {
      try {
        return JSON.parse(body)?.error?.details;
      } catch {
        return undefined;
      }
    })();
    expect(details).not.toMatchObject({ kind: 'agency-jev-config' });
  });

  /**
   * Every route other than `PUT /api/agency/config` used to fall through to Express's default
   * error handler on a malformed body, which answers an HTML/text 400 that echoes a slice of the
   * request bytes (and, outside production, a stack). These two representative routes — one under
   * `routes/design-index.ts`, one under `routes/project/index.ts` — prove the global handler in
   * `server.ts` now answers the API's own fixed 400 instead, without ever putting the submitted
   * bytes in the response.
   */
  it.each([
    ['POST /api/design-index/profile', '/api/design-index/profile', 'POST'],
    ['POST /api/projects', '/api/projects', 'POST'],
  ])('answers the API\'s own 400 for a malformed body on %s', async (_label, path, method) => {
    const marker = 'MALFORMED-BODY-GLOBAL-HANDLER-MARKER';
    const response = await putMalformed(path, marker, method);
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain(marker);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'the request body is not valid JSON',
    });
  });

  it('serves the taxonomy, proving startup loaded it without touching the secret store', async () => {
    const response = await fetch(`${bootedUrl}/api/design-index/taxonomy`);
    expect(response.status).toBe(200);
    const body = await response.json() as DesignIndexTaxonomyResponse;
    expect(body.taxonomy.version).toBe('1.0');
  });
});
