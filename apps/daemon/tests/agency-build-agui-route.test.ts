// `GET /api/agency/builds/:id/agui` — an agency build as AG-UI spec events.
//
// Mounted the way `agency-build-routes.test.ts` mounts the build routes: a bare Express app, a
// fake `buildSite`, the real `sendApiError` and the real `createSseResponse`, so the framing under
// test is the daemon's own. What these cases hold: replay then live with the spec's ordering,
// `Last-Event-ID` resume, exactly one terminal event per stream, local-only access, and no brief.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencyBuildAguiState, AgencyBuildEvent, AgencyBuildResponse, AgencyBuildSnapshot } from '@open-design/contracts';
import { applyJsonPatch, foldAgencyBuildState, type JsonPatchOp } from '@open-design/agui-adapter';
import type { BuildEvent, BuildInput, BuildResult } from '@open-design/agency-fast-lane/build';

import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';
import { sendApiError } from '../src/http/api-errors.js';
import { createSseResponse } from '../src/server.js';
import { lastEventIdOf, registerAgencyBuildRoutes } from '../src/routes/agency-build.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';

type Report = Extract<BuildResult, { outcome: 'built' }>['report'];

/** The provider fields every built result carries: one provider filled the whole build. */
const BUILT_BY: Pick<Extract<BuildResult, { outcome: 'built' }>, 'provider' | 'model' | 'providers'> = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash', sections: ['hero'] }],
};

function reportFixture(): Report {
  return {
    family: 'wrenfield',
    mode: 'sections',
    model: 'deepseek-chat',
    entry: 'wrenfield-r1.html',
    revision: 1,
    projectId: 'project-1',
    timings: { totalMs: 42_000, firstTokenMs: 900, registeredMs: 41_000 },
    calls: 6,
    repairs: 0,
    retries: 0,
    paints: 1,
    usage: { input: 12_000, output: 3_400, cachedRead: 0 },
    applied: 48,
    missing: [],
    nulled: [],
    truncated: [],
    units: [],
    recipeDigest: 'digest-one',
    recipe: { quoted: BRIEF },
    html: `<!doctype html><p>${BRIEF}</p>`,
    manifest: { entry: 'wrenfield-r1.html', supportingFiles: [], metadata: {} },
    approvedAssets: [],
  } as unknown as Report;
}

const ROUTED_EVENT: BuildEvent = {
  type: 'route',
  decision: {
    decision: 'routed',
    spine: { code: 'TL', name: 'Trust Ladder', confidence: 0.82, probabilities: { TL: 0.82 } },
    spines: [{ code: 'TL', probability: 0.82 }],
    archetype: { id: 'TL-1', name: 'Local service', confidence: 0.7 },
    skin: { choice: 'Editorial', confidence: 0.6 },
    family: { id: 'wrenfield', probability: 0.71, basis: 'exact', transfer: 3 },
    candidates: [],
    warnings: [],
    ms: 610,
    calls: 1,
    model: 'jev-1.13.0',
  },
} as BuildEvent;

let server: http.Server;
let baseUrl: string;
let tempRoot = '';
let sameOrigin = true;
let buildImpl: (input: BuildInput) => Promise<BuildResult>;
/** `registerAgencyBuildRoutes`'s own completion signal: `afterEach` awaits this before `rmSync`
 * so a build's fire-and-forget `persist()` write never races the directory it writes into being
 * removed — same race, same fix, as `agency-build-provider.test.ts`. */
let routes: { idle(): Promise<void> };

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  tempRoot = mkdtempSync(path.join(tmpdir(), 'od-agency-agui-'));
  sameOrigin = true;
  buildImpl = async () => ({ outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() });

  const app = express();
  app.use(express.json());
  routes = registerAgencyBuildRoutes(app, {
    http: {
      sendApiError,
      createSseResponse,
      isLocalSameOrigin: () => sameOrigin,
      resolvedPortRef: { current: 0 },
    } as never,
    paths: { RUNTIME_DATA_DIR: tempRoot } as never,
    agencyBuild: {
      atlas: { spines: [] } as never,
      registry: { families: [] } as never,
      jevKeyStore: createAgencyJevKeyStore({ dataDir: tempRoot, readVaultSecret: async () => 'jev-key' }),
      daemonUrlRef: { current: 'http://127.0.0.1:1' },
      runBuild: (input) => buildImpl(input),
      buildDeps: {
        createModelCaller: () => { throw new Error('no model in this suite'); },
        createJevChecker: () => { throw new Error('no jev in this suite'); },
        createJevRouter: () => { throw new Error('no jev in this suite'); },
        resolveJevCredential: async () => 'jev-key',
        resolveModelKey: async () => 'model-key',
      },
      loadPackage: async (family) => ({ family }) as never,
      buildsFile: path.join(tempRoot, 'agency-builds', 'index.json'),
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Drains any build still in flight, then the store's own save/load chain, so `rmSync` below
  // never races a `persist()` write that is still touching `tempRoot/agency-builds/`.
  await routes.idle();
  if (tempRoot) rmSync(tempRoot, { force: true, recursive: true });
  tempRoot = '';
});

const get = (url: string, init?: RequestInit) => fetch(`${baseUrl}${url}`, init);
const start = async (body: Record<string, unknown> = { brief: BRIEF }): Promise<AgencyBuildSnapshot> => {
  const response = await fetch(`${baseUrl}/api/agency/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  return (await response.json() as AgencyBuildResponse).build;
};

async function waitFor(id: string): Promise<AgencyBuildSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { build } = await (await get(`/api/agency/builds/${id}`)).json() as AgencyBuildResponse;
    if (['done', 'unrouted', 'failed', 'cancelled'].includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the build never finished');
}

interface Frame { event: string; id?: string; data: any; raw: string }

async function readStream(url: string, init?: RequestInit): Promise<Frame[]> {
  const response = await get(url, init);
  expect(response.ok).toBe(true);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0 && !frame.startsWith(':'))
    .map((frame) => {
      const record: Frame = { event: 'message', data: undefined, raw: frame };
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) record.id = line.slice(3).trim();
        else if (line.startsWith('event:')) record.event = line.slice(6).trim();
        else if (line.startsWith('data:')) record.data = JSON.parse(line.slice(5).trim());
      }
      return record;
    });
}

/** The spec's ordering rules, checked on one whole stream. */
function expectWellFormed(frames: Frame[]) {
  expect(frames.every((frame) => frame.event === 'message')).toBe(true);
  expect(frames[0]!.data.type).toBe('RUN_STARTED');
  const terminal = frames.filter((frame) => frame.data.type === 'RUN_FINISHED' || frame.data.type === 'RUN_ERROR');
  expect(terminal).toHaveLength(1);
  expect(frames.at(-1)).toBe(terminal[0]);
  let open: string | null = null;
  for (const { data } of frames) {
    if (data.type === 'STEP_STARTED') {
      expect(open).toBeNull();
      open = data.stepName;
    } else if (data.type === 'STEP_FINISHED') {
      expect(data.stepName).toBe(open);
      open = null;
    }
  }
  expect(open).toBeNull();
}

const label = (frame: Frame) => {
  const { data } = frame;
  if (data.type === 'STEP_STARTED' || data.type === 'STEP_FINISHED') return `${data.type}:${data.stepName}`;
  if (data.type === 'CUSTOM') return `CUSTOM:${data.value.type}`;
  return data.type;
};

function stateOf(frames: Frame[]): AgencyBuildAguiState {
  let state: any;
  for (const { data } of frames) {
    if (data.type === 'STATE_SNAPSHOT') state = data.snapshot;
    if (data.type === 'STATE_DELTA') state = applyJsonPatch(state, data.delta as JsonPatchOp[]);
  }
  return state;
}

describe('GET /api/agency/builds/:id/agui', () => {
  it('replays what happened, streams what follows, and ends with exactly one RUN_FINISHED', async () => {
    let emit: ((event: BuildEvent) => void) | undefined;
    let finish = (_: BuildResult) => {};
    const finished = new Promise<BuildResult>((resolve) => { finish = resolve; });
    buildImpl = async (input) => {
      emit = (event) => input.onEvent?.(event);
      emit(ROUTED_EVENT);
      emit({ type: 'first-token', ms: 900 } as BuildEvent);
      return finished;
    };

    const started = await start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stream = readStream(`/api/agency/builds/${started.id}/agui`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit!({ type: 'unit', label: 'hero', ms: 8_100, repairs: 0 } as BuildEvent);
    emit!({ type: 'verify', ms: 20_000, checked: 12, flagged: 0, repaired: 0, remaining: 0 } as BuildEvent);
    emit!({ type: 'project', projectId: 'project-1', created: true } as BuildEvent);
    emit!({ type: 'registered', ms: 41_000 } as BuildEvent);
    finish({ outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() });

    const frames = await stream;
    expectWellFormed(frames);
    expect(frames.map(label)).toEqual([
      'RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED:route',
      'STATE_DELTA', 'STEP_FINISHED:route', 'CUSTOM:route',
      'STEP_STARTED:fill', 'STATE_DELTA', 'CUSTOM:first-token',
      'STATE_DELTA', 'CUSTOM:unit',
      'STEP_FINISHED:fill', 'STEP_STARTED:verify', 'STATE_DELTA', 'CUSTOM:verify',
      'STEP_FINISHED:verify', 'STEP_STARTED:publish', 'STATE_DELTA', 'CUSTOM:project',
      'STATE_DELTA', 'CUSTOM:registered',
      'STATE_DELTA', 'STEP_FINISHED:publish', 'RUN_FINISHED',
    ]);
    // Only the last frame of each event's group carries its seq; start and end frames carry none.
    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => [frame.id, label(frame)])).toEqual([
      ['1', 'CUSTOM:route'], ['2', 'CUSTOM:first-token'], ['3', 'CUSTOM:unit'],
      ['4', 'CUSTOM:verify'], ['5', 'CUSTOM:project'], ['6', 'CUSTOM:registered'],
    ]);
    const state = stateOf(frames);
    expect(state.build.status).toBe('done');
    expect(state.projectId).toBe('project-1');
    // The terminal frames carry the build's provider history, so a panel driven only by the
    // stream can name who filled it.
    expect(state.providers).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash', sections: ['hero'] }]);
    expect(state.input.family).toBe('wrenfield');
    expect(frames.at(-1)!.data.result).toMatchObject({ status: 'done', projectId: 'project-1', family: 'wrenfield' });
  });

  it('resumes after Last-Event-ID: a snapshot equal to the fold, then only later events', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'first-token', ms: 900 } as BuildEvent);
      input.onEvent?.({ type: 'unit', label: 'hero', ms: 8_100, repairs: 0 } as BuildEvent);
      input.onEvent?.({ type: 'registered', ms: 41_000 } as BuildEvent);
      return { outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await waitFor((await start()).id);
    const frames = await readStream(`/api/agency/builds/${snapshot.id}/agui`, { headers: { 'last-event-id': '2' } });
    expectWellFormed(frames);
    expect(frames.slice(0, 5).map(label)).toEqual([
      'RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED:route', 'STEP_FINISHED:route', 'STEP_STARTED:fill',
    ]);
    const initial = frames[1]!.data.snapshot as AgencyBuildAguiState;
    const meta = { buildId: snapshot.id, startedAt: snapshot.startedAt, input: { ...initial.input, family: 'auto' } };
    expect(initial).toEqual(foldAgencyBuildState(meta, snapshot.events.filter((event) => event.seq <= 2)));
    const custom = frames.filter((frame) => frame.data.type === 'CUSTOM').map((frame) => (frame.data.value as AgencyBuildEvent).seq);
    expect(custom).toEqual([3, 4]);
    // The resumed client ends on the same state as one that watched from the start.
    const full = await readStream(`/api/agency/builds/${snapshot.id}/agui`);
    expect(stateOf(frames)).toEqual(stateOf(full));
  });

  it('resumes strictly after Last-Event-ID N for every N: nothing the client has is sent again', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'first-token', ms: 900 } as BuildEvent);
      input.onEvent?.({ type: 'unit', label: 'hero', ms: 8_100, repairs: 0 } as BuildEvent);
      input.onEvent?.({ type: 'registered', ms: 41_000 } as BuildEvent);
      return { outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await waitFor((await start()).id);
    const total = snapshot.events.length;
    expect(total).toBe(4);
    const full = await readStream(`/api/agency/builds/${snapshot.id}/agui`);
    for (let n = 1; n <= total; n += 1) {
      const frames = await readStream(`/api/agency/builds/${snapshot.id}/agui`, { headers: { 'last-event-id': String(n) } });
      expectWellFormed(frames);
      const custom = frames.filter((frame) => frame.data.type === 'CUSTOM');
      // The first replayed build event is N + 1, never N itself.
      if (n < total) expect((custom[0]!.data.value as AgencyBuildEvent).seq).toBe(n + 1);
      expect(custom.map((frame) => (frame.data.value as AgencyBuildEvent).seq)).toEqual(
        Array.from({ length: total - n }, (_, index) => n + 1 + index),
      );
      const ids = frames.filter((frame) => frame.id !== undefined).map((frame) => Number(frame.id));
      expect(ids.every((id) => id > n)).toBe(true);
      expect(stateOf(frames)).toEqual(stateOf(full));
    }
  });

  it('resumes a live build strictly after Last-Event-ID', async () => {
    let emit: ((event: BuildEvent) => void) | undefined;
    let finish = (_: BuildResult) => {};
    const finished = new Promise<BuildResult>((resolve) => { finish = resolve; });
    buildImpl = async (input) => {
      emit = (event) => input.onEvent?.(event);
      emit(ROUTED_EVENT);
      emit({ type: 'first-token', ms: 900 } as BuildEvent);
      return finished;
    };
    const started = await start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stream = readStream(`/api/agency/builds/${started.id}/agui`, { headers: { 'last-event-id': '2' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit!({ type: 'registered', ms: 41_000 } as BuildEvent);
    finish({ outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() });
    const frames = await stream;
    expectWellFormed(frames);
    expect(frames.filter((frame) => frame.data.type === 'CUSTOM').map((frame) => (frame.data.value as AgencyBuildEvent).seq)).toEqual([3]);
    expect(frames.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual(['3']);
  });

  it('replays from the start when Last-Event-ID is not a complete safe decimal integer', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'first-token', ms: 900 } as BuildEvent);
      input.onEvent?.({ type: 'registered', ms: 41_000 } as BuildEvent);
      return { outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await waitFor((await start()).id);
    for (const header of ['2junk', '1.5', '-1', '0x2', '1e0', '+2', '', '0', '99999999999999999999']) {
      const frames = await readStream(`/api/agency/builds/${snapshot.id}/agui`, { headers: { 'last-event-id': header } });
      expectWellFormed(frames);
      expect(frames.filter((frame) => frame.data.type === 'CUSTOM').map((frame) => (frame.data.value as AgencyBuildEvent).seq), header)
        .toEqual([1, 2, 3]);
    }
    // `/events` shares the parser.
    const events = await readStream(`/api/agency/builds/${snapshot.id}/events`, { headers: { 'last-event-id': '2junk' } });
    expect(events.filter((frame) => frame.event === 'build-event').map((frame) => frame.id)).toEqual(['1', '2', '3']);
  });

  it('reads Last-Event-ID as a whole positive decimal integer or not at all', () => {
    expect(lastEventIdOf('3')).toBe(3);
    expect(lastEventIdOf(' 3 ')).toBe(3);
    expect(lastEventIdOf(undefined)).toBe(0);
    for (const bad of ['2junk', '1.5', '-1', '0x2', '1e3', '+2', '', '0', '9007199254740993']) {
      expect(lastEventIdOf(bad), bad).toBe(0);
    }
  });

  it('ends a failed build with exactly one RUN_ERROR carrying the fixed code', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      throw new Error(`upstream said: ${BRIEF}`);
    };
    const snapshot = await waitFor((await start()).id);
    const frames = await readStream(`/api/agency/builds/${snapshot.id}/agui`);
    expectWellFormed(frames);
    expect(frames.at(-1)!.data).toMatchObject({ type: 'RUN_ERROR', code: 'BUILD_FAILED' });
    expect(stateOf(frames).build.status).toBe('failed');
    // Check every field of the parsed RUN_ERROR payload, not just `message`: a leak in another
    // field (e.g. a future `detail` or `cause`) must fail this test too.
    const errorPayload = frames.at(-1)!.data as Record<string, unknown>;
    for (const [field, value] of Object.entries(errorPayload)) {
      expect(String(value), `field "${field}"`).not.toContain(BRIEF);
      expect(String(value), `field "${field}"`).not.toContain('Riverbend');
    }
    // Secondary guard: the thrown message quoted the brief; the raw SSE bytes (RUN_ERROR
    // included) never do, whatever shape the frame takes.
    const bytes = await (await get(`/api/agency/builds/${snapshot.id}/agui`)).text();
    expect(bytes).toContain('RUN_ERROR');
    expect(bytes).not.toContain(BRIEF);
    expect(bytes).not.toContain('Riverbend');
  });

  it('never sends the brief, only its length', async () => {
    buildImpl = async (input) => {
      input.onEvent?.(ROUTED_EVENT);
      input.onEvent?.({ type: 'repair', label: 'hero', reason: 'unfaithful', message: `refused: ${BRIEF}` } as unknown as BuildEvent);
      return { outcome: 'built', ...BUILT_BY, family: 'wrenfield', projectId: 'project-1', report: reportFixture() };
    };
    const snapshot = await waitFor((await start()).id);
    const frames = await readStream(`/api/agency/builds/${snapshot.id}/agui`);
    const raw = frames.map((frame) => frame.raw).join('\n');
    expect(raw).not.toContain(BRIEF);
    expect(raw).not.toContain('Riverbend');
    expect(stateOf(frames).input.briefChars).toBe(BRIEF.length);
  });

  it('answers 404 for an unknown build', async () => {
    const response = await get('/api/agency/builds/no-such-build/agui');
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('BUILD_NOT_FOUND');
  });

  it('rejects a cross-origin request', async () => {
    const snapshot = await waitFor((await start()).id);
    sameOrigin = false;
    const response = await get(`/api/agency/builds/${snapshot.id}/agui`);
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });
});
