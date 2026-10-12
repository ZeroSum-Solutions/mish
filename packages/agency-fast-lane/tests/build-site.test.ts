/**
 * `buildSite` (`src/build.ts`): the fast lane's build step without a terminal around it.
 *
 * Every dependency is faked — the router, the model caller, the faithfulness checker, the daemon's
 * `fetch` and the provider lock — so nothing here opens a socket, reads a credential or touches a
 * real daemon. The family package is the real bundled `maben` one, since the fill, the render and
 * the publish shape are what these tests are about.
 *
 * The cancellation cases are the point of the file: an aborted build must settle everything it
 * started before it removes anything, must remove only a project it created itself, and must
 * release the provider lock whatever happens. Nothing here waits out a timer to decide that. Every
 * in-flight model call and every in-flight save hangs on a gate the test opens by hand, so the
 * order events happen in is the order the test chose — a build that deleted a project while a save
 * was still on the wire fails here rather than intermittently on a loaded CI runner.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProvenanceOf, buildSite, RenderQualityError, type BuildDeps, type BuildEvent, type BuildInput, type PreparedBuild } from '../src/build.ts';
import { createModelCaller, ProviderHttpError, type ModelCall } from '../src/deepseek.ts';
import { createJevChecker, type FaithfulnessChecker, type FaithfulnessSlot } from '../src/jev.ts';
import type { RouteDecision } from '../src/route.ts';
import type { VerifySkipReason } from '../src/run.ts';
import type { JsonObject } from '../src/spine.ts';
import { loadAtlasData } from '../src/atlas.ts';
import { fakeModel, loadMaben, type Filler } from './fixtures.ts';
import { ProviderFailoverError } from '../src/failover.ts';

const pkg = await loadMaben();
const ENTRY = 'maben-r1.html';
const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';
const DAEMON = 'http://daemon.test';

const prepare = async (): Promise<PreparedBuild> => ({ pkg, entry: ENTRY });

type Deferred = { promise: Promise<void>; open: () => void };

function deferred(): Deferred {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
}

/**
 * Answers whether `condition` ever holds within `turns` turns of the event loop. Used to assert
 * that something must NOT happen — a build must not finish, or delete anything, while this test is
 * still holding one of its calls open. Nothing here is driven by a real timer, so the bound is on
 * scheduling turns rather than on wall-clock time: a slow machine runs the same number of turns.
 */
async function happensWithin(condition: () => boolean, turns = 3000): Promise<boolean> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

/** A promise that rejects the moment `signal` aborts, and otherwise never settles — what a real
 * `fetch` does to a request whose signal fires. */
function rejectsOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Tracks whether a build has finished, however it finished. */
function watchSettled(build: Promise<unknown>): { value: boolean } {
  const settled = { value: false };
  const mark = () => { settled.value = true; };
  build.then(mark, mark);
  return settled;
}

/** Runs the event loop until `condition` holds, so a test never guesses how long a build needs to
 * reach the point it wants to interrupt. Fails loudly rather than hanging. */
async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  // Bounded by wall time, not a turn count: the pre-publish gates do real async work, so the
  // number of event-loop turns a build needs varies by machine.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Matches run.test.ts's own fake: flags any slot whose text contains a marker. */
function fakeJevChecker(markers: string[] = ['FABRICATED']): FaithfulnessChecker {
  return {
    async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
      const flagged = slots.filter((slot) => markers.some((marker) => slot.text.includes(marker))).map((slot) => ({ path: slot.path, probability: 0.95 }));
      return { flagged, ms: 1, calls: 1 };
    },
  };
}

/** A fill that fabricates an unrepairable fact, so a flag on it survives repair and stays
 * `remaining` — the shape a strict gate must refuse to publish. */
const fabricatingFill: Filler = (key, _value, at, limit) =>
  (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`));

const routedToMaben: RouteDecision = {
  decision: 'routed',
  spine: { code: 'TL', name: 'Trust the maker', confidence: 0.9, probabilities: { TL: 0.9 } },
  spines: [{ code: 'TL', probability: 0.9 }],
  archetype: { id: 'TL.01', name: 'Fake archetype', confidence: 0.9 },
  skin: { choice: 'Minimal and quiet', confidence: 0.8 },
  family: { id: 'maben', probability: 0.9, basis: 'exact', transfer: 3 },
  candidates: [],
  warnings: [],
  ms: 1,
  calls: 1,
  model: 'fake-router-model',
};

const unrouted: RouteDecision = {
  decision: 'unrouted',
  reason: 'no spine confidently placed',
  spine: { code: 'TL', name: 'Trust the maker', confidence: 0.3, probabilities: { TL: 0.3 } },
  spines: [],
  skin: { choice: 'Minimal and quiet', confidence: 0.5 },
  candidates: [],
  warnings: [],
  ms: 1,
  calls: 1,
  model: 'fake-router-model',
};

type DaemonCall = { method: string; url: string; body?: JsonObject };

type DaemonOptions = {
  /** Called with every request as it arrives, after it is recorded and before it is answered.
   * Throwing from it is how a test makes that one request fail. */
  onRequest?: (call: DaemonCall) => void;
  /** Returns a promise that holds the n-th file save open until the test settles it. */
  holdSave?: (index: number) => Promise<void> | undefined;
  /** Appended to, in the order things actually happen. */
  log?: string[];
  /** The ids this daemon holds. Pass one in to assert what survived the build. */
  projects?: Set<string>;
  /**
   * Holds a create open until the test settles it. The project commits when it does — which is
   * what the real daemon does too: it inserts only after a stretch of async validation, well
   * after it has started reading the request.
   */
  holdCreate?: Promise<void>;
  /** The create is refused with this status and nothing is committed (400 when just `true`). */
  refuseCreate?: boolean | number;
  /** Drops the create's connection when this settles. The daemon carries on and commits when
   * `holdCreate` opens, which is the state the client cannot tell apart from one that never
   * landed. */
  dropCreate?: Promise<void>;
  /** The create never answers: only the client's own deadline ends it, leaving its fate unknown. */
  stallCreate?: boolean;
};

/** A fake `fetch` standing in for the daemon: never opens a socket, records every call, and
 * answers 200 for everything the test does not deliberately fail. */
function fakeDaemonFetch(calls: DaemonCall[], options: DaemonOptions = {}): typeof fetch {
  let saves = 0;
  /** The ids this daemon actually holds, so a DELETE of anything else answers 404 as it really would. */
  const projects = options.projects ?? new Set<string>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const call: DaemonCall = { method, url, body: bodyText ? (JSON.parse(bodyText) as JsonObject) : undefined };
    calls.push(call);
    options.onRequest?.(call);
    if (method === 'POST' && url.endsWith('/api/projects')) {
      const id = String(call.body!.id);
      options.log?.push('create:start');
      if (options.stallCreate) {
        // Never answers. Only the caller's own deadline ends this, which is the state that leaves
        // the create's fate genuinely unknown.
        await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      }
      if (options.holdCreate) {
        // The daemon goes on and commits when the hold opens, whatever the client does about the
        // request in the meantime. That is the race in one line: a create whose connection dies
        // answers the client at once and lands anyway, moments later.
        const committing = options.holdCreate.then(() => {
          if (options.refuseCreate) return;
          projects.add(id);
          options.log?.push('create:committed');
        });
        const dropped = options.dropCreate?.then(() => {
          options.log?.push('create:dropped');
          throw new TypeError('fetch failed');
        });
        await Promise.race([committing, rejectsOnAbort(init?.signal), ...(dropped ? [dropped] : [])]);
      }
      if (options.refuseCreate) {
        const status = typeof options.refuseCreate === 'number' ? options.refuseCreate : 400;
        options.log?.push(`create:refused:${status}`);
        return new Response(JSON.stringify({ error: { code: 'REFUSED', message: 'refused' } }), { status, headers: { 'content-type': 'application/json' } });
      }
      if (!options.holdCreate) {
        projects.add(id);
        options.log?.push('create:committed');
      }
    }
    if (method === 'DELETE') {
      options.log?.push('delete');
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      if (!projects.has(id)) return new Response(JSON.stringify({ error: { code: 'PROJECT_NOT_FOUND', message: 'not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      projects.delete(id);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/files')) {
      const index = saves;
      saves += 1;
      const held = options.holdSave?.(index);
      if (held) {
        options.log?.push(`save:start:${index}`);
        await held;
        options.log?.push(`save:settled:${index}`);
      }
      // A save the caller cancelled fails, as a real `fetch` on an aborted signal would — but a
      // held one only once the test has let it finish, which is the point: the build must wait
      // for it either way.
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    }
    return new Response(JSON.stringify(call.body?.id ? { id: call.body.id } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** A model whose every call hangs on a gate, so the test decides when each unit settles. Every
 * call ends the way an aborted one does. */
function gatedModel(log: string[]): ModelCall & { gates: Deferred[] } {
  const gates: Deferred[] = [];
  const call: ModelCall = async () => {
    const index = gates.length;
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    log.push(`unit-settled:${index}`);
    throw new DOMException('aborted', 'AbortError');
  };
  return Object.assign(call, { gates });
}

function baseInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    brief: BRIEF,
    family: 'maben',
    mode: 'sections',
    revision: 1,
    verify: 'off',
    provider: 'deepseek',
    prepare,
    loadAtlas: loadAtlasData,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<BuildDeps> = {}): BuildDeps {
  return {
    createModelCaller: () => fakeModel(),
    createJevChecker: () => fakeJevChecker(),
    createJevRouter: () => ({ route: async () => routedToMaben }),
    resolveJevCredential: async () => 'fake-jev-key',
    resolveModelKey: async () => 'fake-model-key',
    daemonFetch: fakeDaemonFetch([]),
    ...overrides,
  };
}

/** The real family compiler first produces a valid draft, then a concrete duplicate-id defect.
 * Keeping the initial renders valid exercises cleanup after progressive publication has begun. */
function prepareStructuralFailure(): BuildInput['prepare'] {
  let renders = 0;
  const failingPackage = {
    ...pkg,
    render: (...args: Parameters<typeof pkg.render>) => {
      const result = pkg.render(...args);
      renders += 1;
      return renders <= 2 ? result : {
        ...result,
        html: result.html.replace('</body>', '<div id="quality-defect"></div><div id="quality-defect"></div></body>'),
      };
    },
  };
  return async () => ({ pkg: failingPackage, entry: ENTRY });
}

test('structural failure deletes the new advisory project after its valid draft was saved', async () => {
  const calls: DaemonCall[] = [];
  const projects = new Set<string>();
  const events: BuildEvent[] = [];
  await assert.rejects(buildSite(
    baseInput({ verify: 'advisory', prepare: prepareStructuralFailure(), project: { daemonUrl: DAEMON }, onEvent: event => events.push(event) }),
    baseDeps({ daemonFetch: fakeDaemonFetch(calls, { projects }) }),
  ), error => error instanceof RenderQualityError && error.report.issues.some(issue => issue.check === 'unique-ids'));
  const created = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/projects'));
  assert.ok(created);
  assert.ok(calls.some(call => call.url.endsWith('/files')), 'the valid progressive draft was saved');
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.url), [`${DAEMON}/api/projects/${created.body!.id as string}`]);
  assert.equal(projects.size, 0, 'no abandoned project survives the failed build');
  assert.ok(events.some(event => event.type === 'render-quality' && !event.report.passed));
});

test('structural failure in strict mode never creates or saves a project', async () => {
  const calls: DaemonCall[] = [];
  const projects = new Set<string>();
  await assert.rejects(buildSite(
    baseInput({ verify: 'strict', prepare: prepareStructuralFailure(), project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(calls, { projects }) }),
  ), error => error instanceof RenderQualityError);
  assert.deepEqual(calls, []);
  assert.equal(projects.size, 0);
});

test('structural failure retains the existing advisory project without deleting it', async () => {
  const calls: DaemonCall[] = [];
  const projects = new Set(['existing-project']);
  await assert.rejects(buildSite(
    baseInput({ verify: 'advisory', prepare: prepareStructuralFailure(), project: { daemonUrl: DAEMON, projectId: 'existing-project' } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(calls, { projects }) }),
  ), error => error instanceof RenderQualityError);
  assert.ok(calls.some(call => call.url.endsWith('/files')), 'the existing project accepted the valid draft');
  assert.equal(calls.some(call => call.method === 'POST' && call.url.endsWith('/api/projects')), false);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
  assert.deepEqual([...projects], ['existing-project']);
});

test('structural failure with refused cleanup reports the new project left behind', async () => {
  const calls: DaemonCall[] = [];
  const projects = new Set<string>();
  const result = await buildSite(
    baseInput({ verify: 'advisory', prepare: prepareStructuralFailure(), project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(calls, { projects, onRequest(call) { if (call.method === 'DELETE') throw new Error('daemon refused the delete'); } }) }),
  );
  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.ok(projects.has(result.projectId));
  assert.equal(result.projectId, calls.find(call => call.method === 'POST' && call.url.endsWith('/api/projects'))!.body!.id);
  assert.match(result.message, /removing it again failed/);
});

test('a routed build reports built, with the route and the project decided before the run starts', async () => {
  const daemonCalls: DaemonCall[] = [];
  const events: BuildEvent[] = [];
  const result = await buildSite(
    baseInput({ family: 'auto', project: { daemonUrl: DAEMON }, onEvent: (event) => events.push(event) }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls) }),
  );

  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.family, 'maben');
  assert.deepEqual(result.route, { ...routedToMaben, routeAttempts: 1 }, 'a first-call route takes one attempt');
  assert.equal(result.report.entry, ENTRY);
  assert.equal(result.report.family, 'maben');
  assert.equal(result.projectId, result.report.projectId);
  assert.ok(result.projectId, 'a build that publishes reports the project it published to');

  assert.equal(events[0]!.type, 'route', 'the route decision is the first thing a build reports');
  assert.equal(events[1]!.type, 'project', 'the project comes next, before any run event');
  const runEvents = events.slice(2);
  assert.ok(runEvents.length > 0);
  assert.ok(!runEvents.some((event) => event.type === 'route' || event.type === 'project'), 'everything after those two is the run itself');
  assert.ok(runEvents.some((event) => event.type === 'registered'), 'the run reached registration');
});

test('the brief is read only after the credential preflight has passed', async () => {
  // A caller that has to go and get the brief hands over a reader rather than the text, so the
  // preflight keeps its promise: a build that cannot verify says so before anything else can fail.
  let briefReads = 0;
  const { deps } = { deps: baseDeps({ resolveJevCredential: async () => { throw new Error('zsvault returned no value for typesafe_api_key'); } }) };
  await assert.rejects(
    buildSite(baseInput({ verify: 'strict', brief: async () => { briefReads += 1; return BRIEF; } }), deps),
    /needs a Jev credential/,
  );
  assert.equal(briefReads, 0, 'a failed preflight reads no brief at all');
});

test('a named family never builds a router', async () => {
  let routerFactoryCalls = 0;
  const result = await buildSite(
    baseInput({ family: 'maben' }),
    baseDeps({
      createJevRouter: () => {
        routerFactoryCalls += 1;
        return { route: async () => { throw new Error('the router must never be reached'); } };
      },
    }),
  );

  assert.equal(result.outcome, 'built');
  assert.equal(routerFactoryCalls, 0);
});

test('provider omitted with a defaultModelFor callback resolves it once, after routing, before the model call', async () => {
  // `provider` is deliberately not in this input at all — the same shape a daemon build for
  // `family: 'auto'` with no `provider` named actually sends (`apps/daemon/src/routes/
  // agency-build.ts`'s `startBuild`) — so `buildSite` has nothing to fall back on but
  // `defaultModelFor`, and this asserts exactly when and how many times that runs.
  const calls: string[] = [];
  const result = await buildSite(
    {
      brief: BRIEF,
      family: 'auto',
      mode: 'sections',
      revision: 1,
      verify: 'off',
      prepare,
      loadAtlas: loadAtlasData,
      project: { daemonUrl: DAEMON },
      defaultModelFor: (family) => {
        calls.push(`defaultModelFor:${family}`);
        return { provider: 'cerebras', model: 'gpt-oss-120b' };
      },
    },
    baseDeps({
      createJevRouter: () => ({ route: async () => routedToMaben }),
      createModelCaller: (options) => {
        calls.push(`createModelCaller:${options.provider}:${options.model}`);
        return fakeModel();
      },
      daemonFetch: fakeDaemonFetch([]),
    }),
  );

  assert.equal(result.outcome, 'built');
  // Routing happens before `family` — and so `defaultModelFor`'s argument — is known; the model
  // caller is built after, from exactly what `defaultModelFor` returned. Order proves "resolved
  // once, after routing, before the first model call" all at once: a second call, a call before
  // routing, or the model caller using some other provider would all show up as a different list.
  assert.deepEqual(calls, ['defaultModelFor:maben', 'createModelCaller:cerebras:gpt-oss-120b']);
});

test('an unrouted brief builds nothing: no package prepared, no model call, no project', async () => {
  const daemonCalls: DaemonCall[] = [];
  let modelFactoryCalls = 0;
  let prepareCalls = 0;
  const result = await buildSite(
    baseInput({
      family: 'auto',
      project: { daemonUrl: DAEMON },
      prepare: async () => {
        prepareCalls += 1;
        return prepare();
      },
    }),
    baseDeps({
      createJevRouter: () => ({ route: async () => unrouted }),
      createModelCaller: () => {
        modelFactoryCalls += 1;
        return fakeModel();
      },
      daemonFetch: fakeDaemonFetch(daemonCalls),
    }),
  );

  assert.deepEqual(result, { outcome: 'unrouted', route: { ...unrouted, routeAttempts: 1 } }, 'a spine below the bar is refused without a retry');
  assert.equal(prepareCalls, 0, 'the family-dependent inputs are never even prepared');
  assert.equal(modelFactoryCalls, 0);
  assert.equal(daemonCalls.length, 0);
});

test('strict: a fabrication that survives repair publishes nothing and says why', async () => {
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ verify: 'strict', project: { daemonUrl: DAEMON } }),
    baseDeps({ createModelCaller: () => fakeModel({ fill: fabricatingFill }), daemonFetch: fakeDaemonFetch(daemonCalls) }),
  );

  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.strict?.passed, false);
  assert.match(result.report.strict?.reason ?? '', /^unresolved: /);
  assert.equal(result.projectId, undefined, 'a failed gate never reaches a project');
  assert.equal(daemonCalls.length, 0, 'strict defers every daemon write; a failed gate sends none of them');
});

test('cancelled mid-fill: every unit settles before the project this build created is deleted', async () => {
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const model = gatedModel(log);
  const build = buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({ createModelCaller: () => model, daemonFetch: fakeDaemonFetch(daemonCalls, { log }) }),
  );

  const settled = watchSettled(build);
  await until(() => model.gates.length > 1, 'more than one unit to be in flight');
  controller.abort();

  // The first unit unwinds while its siblings are still waiting on the model. A build that let
  // that first failure propagate on its own would delete the project and finish right here.
  model.gates[0]!.open();
  assert.equal(
    await happensWithin(() => settled.value || log.includes('delete')),
    false,
    'the build finished, or deleted its project, while other units were still running',
  );

  for (const gate of model.gates.slice(1)) gate.open();
  const result = await build;

  assert.deepEqual(result, { outcome: 'cancelled', family: 'maben' });
  const created = daemonCalls.find((call) => call.url.endsWith('/api/projects'));
  assert.ok(created, 'the project was created before the abort');
  const deleted = daemonCalls.filter((call) => call.method === 'DELETE');
  assert.equal(deleted.length, 1, 'exactly one delete was sent');
  assert.equal(deleted[0]!.url, `${DAEMON}/api/projects/${created!.body!.id as string}`, 'the deleted id is the one this build created');
  assert.equal(log.indexOf('delete'), log.length - 1, 'the delete is the last thing to happen: no unit was still running');
});

test('cancelled mid-fill: a project the caller supplied is kept, never created and never deleted', async () => {
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const model = gatedModel(log);
  const build = buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON, projectId: 'given-project' } }),
    baseDeps({ createModelCaller: () => model, daemonFetch: fakeDaemonFetch(daemonCalls, { log }) }),
  );

  await until(() => model.gates.length > 0, 'the fill to start');
  controller.abort();
  for (const gate of model.gates) gate.open();
  const result = await build;

  assert.deepEqual(result, { outcome: 'cancelled', family: 'maben', projectId: 'given-project' });
  assert.equal(daemonCalls.some((call) => call.url.endsWith('/api/projects')), false, 'a given project id is never created');
  assert.equal(daemonCalls.some((call) => call.method === 'DELETE'), false, 'a caller-supplied project is never deleted');
});

test('cancelled mid-publish: the save already on the wire finishes before the delete is sent', async () => {
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const firstSave = deferred();
  const build = buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { log, holdSave: (index) => (index === 0 ? firstSave.promise : undefined) }) }),
  );

  const settled = watchSettled(build);
  await until(() => log.includes('save:start:0'), 'a save to be on the wire');
  controller.abort();
  assert.equal(
    await happensWithin(() => settled.value || log.includes('delete')),
    false,
    'the build finished, or deleted its project, with a save still on the wire',
  );

  firstSave.open();
  const result = await build;

  assert.equal(result.outcome, 'cancelled');
  const deleteAt = log.indexOf('delete');
  assert.ok(deleteAt > 0, 'the project this build created was deleted');
  assert.ok(log.indexOf('save:settled:0') < deleteAt, 'the held save settled before the delete');
});

test('cancelled mid-create: the rollback waits for the create it is undoing, then removes it', async () => {
  // The daemon commits a project only after a stretch of async validation, so a DELETE sent while
  // the POST is still in flight can be answered — truthfully — with 404 for a project that lands a
  // moment later. The create is therefore never cancelled, and the clean-up waits for it.
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const createGate = deferred();
  const build = buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { log, holdCreate: createGate.promise }) }),
  );
  const settled = watchSettled(build);

  await until(() => log.includes('create:start'), 'the create to be on the wire');
  controller.abort();
  assert.equal(
    await happensWithin(() => settled.value || log.includes('delete')),
    false,
    'the build deleted, or finished, while the create it must undo was still in flight',
  );

  createGate.open();
  const result = await build;

  assert.equal(result.outcome, 'cancelled');
  assert.equal((result as { projectId?: string }).projectId, undefined, 'nothing was left behind');
  assert.deepEqual(log.filter((entry) => entry.startsWith('create:') || entry === 'delete'), ['create:start', 'create:committed', 'delete']);
  const created = daemonCalls.find((call) => call.url.endsWith('/api/projects'));
  const deleted = daemonCalls.filter((call) => call.method === 'DELETE');
  assert.equal(deleted.length, 1, 'one delete, which the daemon answered 200 because the project was there');
  assert.equal(deleted[0]!.url, `${DAEMON}/api/projects/${created!.body!.id as string}`);
});

test('strict: cancelled mid-create, the project is still rolled back once the create lands', async () => {
  // Strict defers project creation until the gate passes, so its create happens inside
  // `runFastLane` rather than before it — and `runFastLane` has no publisher to roll back when the
  // create itself is what failed. The build owns that case, in strict exactly as in every mode.
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const createGate = deferred();
  const build = buildSite(
    baseInput({ verify: 'strict', signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { log, holdCreate: createGate.promise }) }),
  );

  await until(() => log.includes('create:start'), 'the deferred create to be on the wire');
  controller.abort();
  createGate.open();
  const result = await build;

  assert.equal(result.outcome, 'cancelled');
  assert.equal((result as { projectId?: string }).projectId, undefined, 'nothing was left behind');
  const created = daemonCalls.find((call) => call.url.endsWith('/api/projects'));
  assert.ok(created?.body?.id, 'strict created the project through the id it had settled');
  const deleted = daemonCalls.filter((call) => call.method === 'DELETE');
  // Two owners roll this back without coordinating: `runFastLane`'s strict rollback removes it,
  // and the build's own clean-up asks again. The second answer is a 404, which is why the rollback
  // has to tolerate one — and why the build does not have to know which of them got there first.
  assert.equal(deleted.length, 2);
  for (const call of deleted) assert.equal(call.url, `${DAEMON}/api/projects/${created!.body!.id as string}`);
  assert.ok(log.indexOf('create:committed') < log.indexOf('delete'), 'the delete followed the commit');
});

test('a create the daemon refused rolls back cleanly: a missing project is already rolled back', async () => {
  // The create answered, and the answer was no. Every DELETE then finds nothing — which is the
  // rollback succeeding, not a clean-up failure, and certainly not a project left behind.
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls, {
        refuseCreate: true,
        onRequest: (call) => { if (call.method === 'POST' && call.url.endsWith('/api/projects')) controller.abort(); },
      }),
    }),
  );

  assert.deepEqual(result, { outcome: 'cancelled', family: 'maben' });
  assert.ok(daemonCalls.some((call) => call.method === 'DELETE'), 'the rollback was still attempted');
});

test('a create that never answered leaves its fate unknown, and says so rather than claiming clean', async () => {
  // The create timed out client-side: the daemon may still commit it. A rollback that finds
  // nothing is no longer proof that there is nothing, so the build reports the id it cannot
  // account for instead of a clean cancellation.
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls, {
        stallCreate: true,
        // Stands in for the create's own deadline firing, which is the only thing that ends it.
        onRequest: (call) => {
          if (call.method !== 'POST' || !call.url.endsWith('/api/projects')) return;
          controller.abort();
          throw new DOMException('the operation timed out', 'TimeoutError');
        },
      }),
    }),
  );

  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
  assert.match(result.message, /whether it was created is unknown/);
});

test('a create whose connection dropped is not taken at its word: the rollback waits for the commit', async () => {
  // The client saw a transport failure, which proves nothing about the daemon. Here the daemon
  // commits a moment later — so a rollback that read one 404 as "nothing to undo" would walk away
  // from a project that then exists and that nobody else knows about.
  const controller = new AbortController();
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const createGate = deferred();
  const dropGate = deferred();
  const build = buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { log, holdCreate: createGate.promise, dropCreate: dropGate.promise }) }),
  );

  await until(() => log.includes('create:start'), 'the create to be on the wire');
  controller.abort();
  dropGate.open();
  await until(() => log.includes('create:dropped'), 'the create to fail on the client side');
  // The daemon finishes what it started, after the client has already given up on it.
  createGate.open();
  const result = await build;

  assert.equal(result.outcome, 'cancelled', `expected the project to be recovered, got ${JSON.stringify(result)}`);
  assert.equal((result as { projectId?: string }).projectId, undefined, 'nothing was left behind');
  const deletes = log.map((entry, index) => (entry === 'delete' ? index : -1)).filter((index) => index >= 0);
  assert.ok(deletes.length >= 1);
  assert.ok(log.indexOf('create:committed') < deletes.at(-1)!, 'the delete that found the project followed the commit');
  const created = daemonCalls.find((call) => call.url.endsWith('/api/projects'));
  for (const call of daemonCalls.filter((call) => call.method === 'DELETE')) {
    assert.equal(call.url, `${DAEMON}/api/projects/${created!.body!.id as string}`);
  }
});

test('a create whose connection dropped with nobody cancelling: the project the daemon still commits is not left behind', async () => {
  // The same ambiguity as the cancelled case, without the cancellation — and the one the previous
  // rounds never actually exercised. The client sees a transport failure, nothing aborts, and the
  // daemon commits the project afterwards. A build that took the rejection as proof that nothing
  // was written would fail and leave a project nobody else knows the id of.
  const log: string[] = [];
  const daemonCalls: DaemonCall[] = [];
  const projects = new Set<string>();
  const createGate = deferred();
  const dropGate = deferred();
  const build = buildSite(
    baseInput({ project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { log, projects, holdCreate: createGate.promise, dropCreate: dropGate.promise }) }),
  );

  await until(() => log.includes('create:start'), 'the create to be on the wire');
  dropGate.open();
  await until(() => log.includes('create:dropped'), 'the create to fail on the client side');
  // The daemon finishes what it started only once the rollback has already looked once and found
  // nothing. One look is therefore not enough, which is exactly what the retries are for.
  await until(() => daemonCalls.some((call) => call.method === 'DELETE'), 'the rollback to start');
  createGate.open();

  // Nobody cancelled this build, so it still fails — with the transport error it actually hit.
  await assert.rejects(build, /fetch failed/);
  assert.equal(projects.size, 0, 'the project the daemon committed was left behind');
  const created = daemonCalls.find((call) => call.url.endsWith('/api/projects'));
  assert.ok(log.indexOf('create:committed') >= 0, 'the daemon did commit, after the client gave up');
  assert.ok(log.indexOf('create:committed') < log.lastIndexOf('delete'), 'the delete that found the project followed the commit');
  for (const call of daemonCalls.filter((call) => call.method === 'DELETE')) {
    assert.equal(call.url, `${DAEMON}/api/projects/${created!.body!.id as string}`);
  }
});

test('a create the daemon failed on (5xx) is unknown, not refused, and is reported when it cannot be found', async () => {
  // A 5xx is the daemon falling over part-way through without saying how far it got. Unlike a
  // 4xx, it is no evidence that nothing was written, so the id cannot simply be dropped.
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls, {
        refuseCreate: 500,
        onRequest: (call) => { if (call.method === 'POST' && call.url.endsWith('/api/projects')) controller.abort(); },
      }),
    }),
  );

  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
  assert.match(result.message, /whether it was created is unknown/);
  assert.ok(daemonCalls.filter((call) => call.method === 'DELETE').length > 1, 'an unknown fate is re-asked, not accepted on one 404');
});

test('a create that failed with nobody cancelling still rolls back, and still surfaces the id', async () => {
  // Nothing aborted this build: the create simply never completed. The id exists nowhere a caller
  // can reach once the rejection propagates, so it is rolled back and reported like any other
  // project this build cannot account for.
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ project: { daemonUrl: DAEMON } }),
    baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { refuseCreate: 503 }) }),
  );

  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
  assert.ok(daemonCalls.some((call) => call.method === 'DELETE'), 'the rollback ran even though nobody cancelled');
});

test('a create the daemon refused outright (4xx) is taken at its word: no project, and the build fails', async () => {
  // The other side of the rule. A 4xx is the daemon deciding about this request and writing
  // nothing, so there is nothing to account for and the build fails the way it always did.
  const daemonCalls: DaemonCall[] = [];
  await assert.rejects(
    buildSite(
      baseInput({ project: { daemonUrl: DAEMON } }),
      baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { refuseCreate: 400 }) }),
    ),
    /daemon 400 on \/api\/projects/,
  );
  assert.equal(daemonCalls.filter((call) => call.method === 'DELETE').length, 0, 'nothing was created, so nothing is rolled back');
});

test('cancelled, and the rollback itself fails: the project left behind is still named', async () => {
  // The clean-up cannot finish. That is the same problem as a failed strict rollback — a project
  // is on the daemon that nobody else knows about — so it gets the same outcome, not a rejection
  // that would lose the id.
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls, {
        onRequest: (call) => {
          if (call.method === 'POST' && call.url.endsWith('/files')) controller.abort();
          if (call.method === 'DELETE') throw new Error('daemon refused the delete');
        },
      }),
    }),
  );

  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.equal(result.family, 'maben');
  assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
  assert.match(result.message, /removing it again failed/);
});

test('strict: a rollback that fails is its own outcome, carrying the project left behind', async () => {
  // Strict publishes in one deferred batch once the gate passes. If that batch fails AND removing
  // the project it had just created fails too, a partly-written project is on the daemon. That is
  // not `cancelled`, which promises the opposite, and it is not an exception either: the caller
  // has to be able to name the project a person now has to deal with.
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ verify: 'strict', signal: controller.signal, project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls, {
        onRequest: (call) => {
          if (call.method === 'POST' && call.url.endsWith('/files') && call.body?.name === ENTRY) {
            controller.abort();
            throw new Error('daemon refused the page save');
          }
          if (call.method === 'DELETE') throw new Error('daemon refused the delete');
        },
      }),
    }),
  );

  assert.equal(result.outcome, 'rollback-failed');
  if (result.outcome !== 'rollback-failed') return;
  assert.equal(result.family, 'maben');
  assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
  assert.match(result.message, /removing it also failed/);
});

test('an abort thrown by the checker unwinds the run on its own, with no signal to fall back on', async () => {
  // The checker is advisory by contract — it answers `skipped` rather than throwing, and the run
  // turns that into a public `verify` event. A cancellation must not travel that path: `advisory`
  // would publish straight past it, `strict` would call it a failed gate, and either way the event
  // would carry the abort's own text out of the daemon.
  //
  // No signal is passed to this build at all. That is deliberate: with one, `isRunCancellation`
  // would be true from `signal.aborted` alone and the trailing `throwIfAborted()` would end the
  // run even if `checkOnce` had swallowed the error, so the test would pass either way. Here the
  // rethrow is the only thing that can produce this outcome.
  const events: BuildEvent[] = [];
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ verify: 'advisory', project: { daemonUrl: DAEMON }, onEvent: (event) => events.push(event) }),
    baseDeps({
      createJevChecker: () => ({
        checkFaithfulness: async () => { throw new DOMException('aborted', 'AbortError'); },
      }),
      daemonFetch: fakeDaemonFetch(daemonCalls),
    }),
  );

  assert.equal(result.outcome, 'cancelled', 'the abort ended the run where it was thrown');
  const verifyEvents = events.filter((event) => event.type === 'verify');
  assert.deepEqual(verifyEvents, [], `a cancelled check still reported itself: ${JSON.stringify(verifyEvents)}`);
  assert.ok(!events.some((event) => event.type === 'registered'), 'and advisory did not publish past it');
});

test('a skip names which way Jev failed, on both of the paths the checker reports one', async () => {
  // Which code applies is decided by how `createJevChecker` reports the failure, so the real
  // checker is used here with only its transport faked: a throw and a returned skip are different
  // code paths inside it, and a test that only drove one would not notice the two being swapped.
  const skipReasonFrom = async (fetchImpl: typeof fetch): Promise<VerifySkipReason | undefined> => {
    const events: BuildEvent[] = [];
    const result = await buildSite(
      baseInput({ verify: 'advisory', onEvent: (event) => events.push(event) }),
      baseDeps({ createJevChecker: (options) => createJevChecker({ ...options, fetchImpl }) }),
    );
    assert.equal(result.outcome, 'built', 'an advisory skip never fails the build');
    const verifyEvent = events.find((event) => event.type === 'verify');
    assert.ok(verifyEvent, 'the skip was reported');
    return verifyEvent.skipped;
  };

  // Jev answered, and the answer was an error: the checker throws. Reached, and said no.
  assert.equal(await skipReasonFrom((async () => new Response('upstream trouble', { status: 500 })) as typeof fetch), 'jev-refused');
  // The request never completed: the checker returns a `skipped` result. Not reached at all.
  assert.equal(await skipReasonFrom((async () => { throw new TypeError('fetch failed'); }) as typeof fetch), 'jev-unavailable');
});

test('a verify event that does report a skip carries a fixed code, never the failure text', async () => {
  const sentinel = 'SENTINEL-UPSTREAM-9931';
  const events: BuildEvent[] = [];
  const result = await buildSite(
    baseInput({ verify: 'advisory', onEvent: (event) => events.push(event) }),
    baseDeps({
      createJevChecker: () => ({
        checkFaithfulness: async () => ({ flagged: [], ms: 1, calls: 1, skipped: `socket hang up ${sentinel}` }),
      }),
    }),
  );

  assert.equal(result.outcome, 'built');
  const verifyEvent = events.find((event) => event.type === 'verify');
  assert.ok(verifyEvent);
  assert.equal(verifyEvent.skipped, 'jev-unavailable');
  assert.ok(!JSON.stringify(events).includes(sentinel), 'the underlying failure text reached the event stream');
  if (result.outcome !== 'built') return;
  assert.match(result.report.verify!.skipped!, /socket hang up/, 'the operator-facing report still carries the detail');
});

for (const status of [408, 429]) {
  test(`a create answered ${status} is unknown, not refused: the daemon is asking to be asked again`, async () => {
    // Neither status says what became of this attempt, so neither is proof that nothing was
    // written — unlike every other 4xx, which is the daemon deciding about the request itself.
    const daemonCalls: DaemonCall[] = [];
    const result = await buildSite(
      baseInput({ project: { daemonUrl: DAEMON } }),
      baseDeps({ daemonFetch: fakeDaemonFetch(daemonCalls, { refuseCreate: status }) }),
    );

    assert.equal(result.outcome, 'rollback-failed');
    if (result.outcome !== 'rollback-failed') return;
    assert.equal(result.projectId, daemonCalls.find((call) => call.url.endsWith('/api/projects'))!.body!.id as string);
    assert.ok(daemonCalls.filter((call) => call.method === 'DELETE').length > 1, 'an unknown fate is re-asked, not accepted on one 404');
  });
}

test("cancelled: the provider's one-at-a-time run lock takes the signal, and is released", async () => {
  const controller = new AbortController();
  const log: string[] = [];
  let acquired = 0;
  let released = 0;
  let sawSignal: AbortSignal | undefined;
  const model = gatedModel(log);
  const build = buildSite(
    baseInput({ signal: controller.signal, provider: 'cerebras' }),
    baseDeps({
      createModelCaller: () => model,
      acquireRunLock: async (_name, options) => {
        acquired += 1;
        sawSignal = options?.signal;
        return () => { released += 1; };
      },
    }),
  );

  await until(() => model.gates.length > 0, 'the fill to start');
  controller.abort();
  for (const gate of model.gates) gate.open();
  const result = await build;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(acquired, 1, 'cerebras serialises its runs, so the lock was taken');
  assert.equal(sawSignal, controller.signal, "the build's signal reaches the lock, so a queued build can be cancelled");
  assert.equal(released, 1, 'and the lock is released on the way out');
});

test('cancelled while queued for the lock: the build ends cancelled, having run nothing', async () => {
  const controller = new AbortController();
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ signal: controller.signal, provider: 'cerebras' }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls),
      // Stands in for a real wait on another process's lock: the signal aborts while queued.
      acquireRunLock: async (_name, options) => {
        controller.abort();
        options?.signal?.throwIfAborted();
        throw new Error('the lock must not be taken for a cancelled build');
      },
    }),
  );

  assert.deepEqual(result, { outcome: 'cancelled', family: 'maben' });
  assert.equal(daemonCalls.length, 0);
});

test('no credential ever reaches an event, a result or an error', async () => {
  const jevKey = 'JEV-SENTINEL-4412';
  const modelKey = 'MODEL-SENTINEL-8827';
  const events: BuildEvent[] = [];
  const result = await buildSite(
    baseInput({ family: 'auto', verify: 'strict', project: { daemonUrl: DAEMON }, onEvent: (event) => events.push(event) }),
    baseDeps({
      resolveJevCredential: async () => jevKey,
      resolveModelKey: async () => modelKey,
      // Both resolvers are called the way the real router, checker and model caller call them:
      // at use time, from inside the call that needs the key.
      createJevRouter: (options) => ({ route: async () => { await (options.apiKey as () => Promise<string>)(); return routedToMaben; } }),
      createJevChecker: (options) => ({ checkFaithfulness: async () => { await (options.apiKey as () => Promise<string>)(); return { flagged: [], ms: 1, calls: 1 }; } }),
      createModelCaller: (options) => { void options.apiKey?.(); return fakeModel(); },
    }),
  );

  assert.equal(result.outcome, 'built');
  const serialised = `${JSON.stringify(events)} ${JSON.stringify(result)}`;
  assert.ok(!serialised.includes(jevKey), 'the Jev credential leaked into an event or the result');
  assert.ok(!serialised.includes(modelKey), 'the model key leaked into an event or the result');
});

// -- provider failover ------------------------------------------------------------------------

test('a pre-output 503 on the primary fails over: built on cerebras, one failover event, lock taken and released once', async () => {
  const events: BuildEvent[] = [];
  const created: string[] = [];
  let acquired = 0;
  let released = 0;
  const lockedProviders: string[] = [];
  const modelKey = 'MODEL-SENTINEL-3141';
  const result = await buildSite(
    baseInput({ provider: 'deepseek', onEvent: (event) => events.push(event) }),
    baseDeps({
      resolveModelKey: async () => modelKey,
      createModelCaller: (options) => {
        created.push(`${options.provider}:${options.model}`);
        if (options.provider === 'deepseek') return async () => { throw new ProviderHttpError('deepseek', 503, 'down'); };
        void options.apiKey?.();
        return fakeModel();
      },
      acquireRunLock: async (name) => {
        acquired += 1;
        lockedProviders.push(name);
        return () => { released += 1; };
      },
    }),
  );

  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.provider, 'cerebras');
  assert.equal(result.model, 'gpt-oss-120b');
  assert.equal(result.report.model, 'gpt-oss-120b');
  assert.deepEqual(created, ['deepseek:deepseek-flash', 'cerebras:gpt-oss-120b'], 'the secondary caller is created only on failover');
  const failovers = events.filter((event) => event.type === 'failover');
  assert.deepEqual(failovers, [{ type: 'failover', from: 'deepseek', to: 'cerebras', reason: 'server-error' }]);
  assert.equal(acquired, 1, "the secondary's one-at-a-time lock is taken once");
  assert.deepEqual(lockedProviders, ['cerebras']);
  assert.equal(released, 1, 'and released once');
  assert.ok(!`${JSON.stringify(events)} ${JSON.stringify(result)}`.includes(modelKey), 'no key leaks into events or the result');
});

test('a sections build that fails over midway records both providers and the sections each filled', async () => {
  // The first section call answers on deepseek; every later deepseek call answers 503, so the
  // remaining sections — running concurrently — fail over to cerebras.
  let deepseekCalls = 0;
  const primary = fakeModel();
  const result = await buildSite(
    baseInput({ provider: 'deepseek' }),
    baseDeps({
      createModelCaller: (options) => (options.provider === 'deepseek'
        ? async (request) => {
          deepseekCalls += 1;
          if (deepseekCalls === 1) return primary(request);
          throw new ProviderHttpError('deepseek', 503);
        }
        : fakeModel()),
      acquireRunLock: async () => () => {},
    }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.providers.length, 2);
  const [first, second] = result.providers;
  assert.equal(first!.provider, 'deepseek');
  assert.equal(first!.model, 'deepseek-flash');
  assert.equal(first!.sections?.length, 1);
  assert.equal(second!.provider, 'cerebras');
  assert.equal(second!.model, 'gpt-oss-120b');
  const filled = [...first!.sections!, ...second!.sections!].sort();
  assert.deepEqual(filled, result.report.units.map((unit) => unit.label).sort(), 'every section is attributed to exactly one provider');
  // The scalar provider stays "the last provider that answered".
  assert.equal(result.provider, 'cerebras');
});

test('a sections build that accepts one section and then loses both providers keeps that provider on the failure', async () => {
  // The first section answers on deepseek; every later call fails on both providers, so the build
  // throws. The thrown error still carries who wrote the accepted section.
  let deepseekCalls = 0;
  const primary = fakeModel();
  let thrown: unknown;
  try {
    await buildSite(
      baseInput({ provider: 'deepseek' }),
      baseDeps({
        createModelCaller: (options) => (options.provider === 'deepseek'
          ? async (request) => {
            deepseekCalls += 1;
            if (deepseekCalls === 1) return primary(request);
            throw new ProviderHttpError('deepseek', 503);
          }
          : async () => { throw new ProviderHttpError('cerebras', 503); }),
        acquireRunLock: async () => () => {},
      }),
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProviderFailoverError, `expected ProviderFailoverError, got ${String(thrown)}`);
  const provenance = buildProvenanceOf(thrown);
  assert.ok(provenance, 'the failed build keeps its provenance');
  assert.equal(provenance.provider, 'deepseek');
  assert.equal(provenance.model, 'deepseek-flash');
  assert.equal(provenance.providers.length, 1);
  assert.equal(provenance.providers[0]!.provider, 'deepseek');
  assert.equal(provenance.providers[0]!.sections?.length, 1);
});

test('a build that fails before any provider answers carries no provenance', async () => {
  let thrown: unknown;
  try {
    await buildSite(
      baseInput({ provider: 'deepseek' }),
      baseDeps({
        createModelCaller: (options) => async () => { throw new ProviderHttpError(options.provider ?? 'deepseek', 503); },
        acquireRunLock: async () => () => {},
      }),
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.equal(buildProvenanceOf(thrown), undefined);
});

test('after a failover the published state note names the model that answered', async () => {
  const daemonCalls: DaemonCall[] = [];
  const result = await buildSite(
    baseInput({ provider: 'deepseek', project: { daemonUrl: DAEMON } }),
    baseDeps({
      daemonFetch: fakeDaemonFetch(daemonCalls),
      createModelCaller: (options) => (options.provider === 'deepseek'
        ? async () => { throw new ProviderHttpError('deepseek', 503); }
        : fakeModel()),
      acquireRunLock: async () => () => {},
    }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.report.model, 'gpt-oss-120b');
  const note = daemonCalls.find((call) => call.url.endsWith('/files') && call.body?.name === 'AGENCY-SITE-STATE.md');
  assert.ok(note, 'the state note was saved');
  const content = String(note.body!.content);
  assert.match(content, /Generated by the fast lane \(sections mode, gpt-oss-120b\)/);
  assert.ok(!content.includes('deepseek-flash'), 'the note does not name the primary that failed');
});

/**
 * A `fetch` for a real `createModelCaller` that answers every request with what `fakeModel` would
 * have streamed for it, as one SSE delta. Counts requests.
 */
function transportOver(model: ModelCall): typeof fetch & { count: number } {
  const encoder = new TextEncoder();
  const f = (async (_input: unknown, init?: RequestInit) => {
    f.count += 1;
    const body = JSON.parse(String(init!.body)) as { messages: Array<{ role: string; content: string }> };
    const response = await model({ system: body.messages[0]!.content, user: body.messages[1]!.content });
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: response.text } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frames)); controller.close(); } }), { status: 200 });
  }) as typeof fetch & { count: number };
  f.count = 0;
  return f;
}

test('a schema failure over a mocked transport is repaired on the primary: zero secondary requests', async () => {
  const events: BuildEvent[] = [];
  // Every first answer is cut short with junk appended, so no unit parses; repairs answer cleanly.
  const primaryFetch = transportOver(fakeModel({ rawFirstAnswer: (text) => `${text.slice(0, -3)} <<garbage` }));
  const secondaryFetch = transportOver(fakeModel());
  const result = await buildSite(
    baseInput({ provider: 'deepseek', onEvent: (event) => events.push(event) }),
    baseDeps({
      resolveModelKey: async () => 'k',
      createModelCaller: (options) => createModelCaller({
        ...options,
        fetchImpl: options.provider === 'deepseek' ? primaryFetch : secondaryFetch,
        sleep: async () => {},
      }),
    }),
  );
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.ok(result.report.repairs > 0, 'the run repaired the malformed answers');
  assert.ok(primaryFetch.count > 1);
  assert.equal(secondaryFetch.count, 0, 'zero secondary requests');
  assert.equal(events.filter((event) => event.type === 'failover').length, 0);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
});

test('a build that does not fail over reports the primary provider and model', async () => {
  const result = await buildSite(baseInput({ provider: 'deepseek' }), baseDeps());
  assert.equal(result.outcome, 'built');
  if (result.outcome !== 'built') return;
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(result.providers.map((use) => [use.provider, use.model]), [['deepseek', 'deepseek-flash']]);
});

test('fallbackProvider null turns failover off: the primary error is thrown as-is', async () => {
  let secondaryCreated = false;
  await assert.rejects(
    buildSite(
      baseInput({ provider: 'deepseek', fallbackProvider: null }),
      baseDeps({
        createModelCaller: (options) => {
          if (options.provider === 'cerebras') secondaryCreated = true;
          return async () => { throw new ProviderHttpError('deepseek', 503); };
        },
      }),
    ),
    (error: unknown) => error instanceof ProviderHttpError && error.status === 503,
  );
  assert.equal(secondaryCreated, false);
});
