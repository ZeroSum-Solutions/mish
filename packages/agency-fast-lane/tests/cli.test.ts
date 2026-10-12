/**
 * Process-level tests for the fast-lane CLI's `main(argv, deps)`: the real argument parsing,
 * `resolveVerifyPolicy` wiring, credential preflight ordering, and report/console output, driven
 * with fake model/Jev/daemon dependencies so nothing here makes a network call, reads a real
 * credential, or touches a real daemon. `deps.createModelCaller`/`createJevChecker` default to
 * the real factories only where a test deliberately wants the real sanitization pipeline (the
 * sentinel test below); every other test replaces them outright.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, type CliDeps } from '../src/cli.ts';
import { createJevChecker, type FaithfulnessChecker, type FaithfulnessSlot } from '../src/jev.ts';
import type { RouteDecision } from '../src/route.ts';
import type { JsonObject } from '../src/spine.ts';
import { fakeModel, type Filler } from './fixtures.ts';

const BRIEF_TEXT = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';

const briefDir = await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-'));
const briefPath = path.join(briefDir, 'brief.md');
await writeFile(briefPath, BRIEF_TEXT);

/** Matches run.test.ts's own fakeJevChecker: flags any slot whose text contains a marker. */
function fakeJevChecker(markers: string[] = ['FABRICATED']): FaithfulnessChecker & { calls: number } {
  const checker = {
    calls: 0,
    async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
      checker.calls += 1;
      const flagged = slots.filter((slot) => markers.some((marker) => slot.text.includes(marker))).map((slot) => ({ path: slot.path, probability: 0.95 }));
      return { flagged, ms: 1, calls: 1 };
    },
  };
  return checker;
}

/** A model fill that fabricates an unrepairable fact in the hero statement, so a Jev flag on it
 * survives repair and stays in `remaining` — the shape strict must fail on. */
const fabricatingFill: Filler = (key, _value, at, limit) =>
  (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`));

type DaemonCall = { method: string; url: string; body?: JsonObject };

/** A fake `fetch` standing in for the daemon: never opens a socket, records every call, and
 * answers 200 for everything (id echoed back for a project create) unless the test wants a
 * failure — none of the cases here do, so that knob is not needed. */
function fakeDaemonFetch(calls: DaemonCall[]): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const body = bodyText ? (JSON.parse(bodyText) as JsonObject) : undefined;
    calls.push({ method, url, body });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    return new Response(JSON.stringify(body?.id ? { id: body.id } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** Base deps every test starts from: a clean (non-fabricating) fake model, no verify checker
 * configured (tests that need one set `createJevChecker` themselves), a daemon fetch that never
 * touches a real socket, and `resolveJevCredential` fixed to a fake key so no test ever reads the
 * environment or the real vault unless it explicitly overrides this itself. */
function baseDeps(overrides: Partial<CliDeps> = {}): { deps: Partial<CliDeps>; daemonCalls: DaemonCall[]; stdout: string[]; stderr: string[] } {
  const daemonCalls: DaemonCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    daemonCalls,
    stdout,
    stderr,
    deps: {
      createModelCaller: () => fakeModel(),
      daemonFetch: fakeDaemonFetch(daemonCalls),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      resolveJevCredential: async () => 'fake-jev-key',
      // Keeps every optional section, without a request: no test here reaches the real Jev.
      createSectionJudge: () => ({ judge: async ({ optional }) => ({ dropped: [], kept: optional.map((section) => section.id), warnings: [], ms: 0, calls: 0 }) }),
      // Chooses no automatic effect, without a request, for the same reason.
      createEffectJudge: () => ({ judge: async () => ({ picks: [], skipped: [], ms: 0, calls: 0 }) }),
      ...overrides,
    },
  };
}

/** A minimal, valid `decision: 'routed'` `RouteDecision` — routes to the real bundled `maben`
 * family, so a test that lets the build continue past routing loads a real package. */
const fakeRoutedDecision: RouteDecision = {
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

/** A minimal, valid `decision: 'unrouted'` `RouteDecision`. */
const fakeUnroutedDecision: RouteDecision = {
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

test('default strict: a fabricated fact surviving repair exits 2 and reaches the daemon zero times', async () => {
  const { deps, daemonCalls, stdout, stderr } = baseDeps({
    createModelCaller: () => fakeModel({ fill: fabricatingFill }),
    createJevChecker: () => fakeJevChecker(),
  });
  const code = await main(['--family', 'maben', '--brief', briefPath], deps);

  assert.equal(code, 2);
  assert.equal(daemonCalls.length, 0, 'strict defers every daemon write; a failed gate must send none of them');
  assert.equal(stderr.length, 0, 'the failure detail already went to stdout; the exit carries no extra stderr message');
  assert.ok(stdout.some((line) => line.includes('VERIFY-STRICT FAILED')));
  assert.ok(stdout.some((line) => line.includes('Nothing was registered')));
});

test('explicit advisory: the same fabricated fact still publishes, flagged loudly', async () => {
  const { deps, daemonCalls, stdout } = baseDeps({
    createModelCaller: () => fakeModel({ fill: fabricatingFill }),
    createJevChecker: () => fakeJevChecker(),
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-mode', 'advisory'], deps);

  assert.equal(code, 0);
  assert.ok(daemonCalls.length > 0, 'advisory publishes regardless of what the gate flags');
  assert.ok(stdout.some((line) => line.includes('UNRESOLVED FABRICATIONS')));
  assert.ok(!stdout.some((line) => line.includes('VERIFY-STRICT')), 'the strict block never fires outside strict mode');
});

test('off: the checker factory is never called', async () => {
  let checkerFactoryCalls = 0;
  const { deps } = baseDeps({
    createJevChecker: () => {
      checkerFactoryCalls += 1;
      return fakeJevChecker();
    },
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-mode', 'off', '--dry-run'], deps);

  assert.equal(code, 0);
  assert.equal(checkerFactoryCalls, 0);
});

test('legacy --verify jev alone resolves advisory: a remaining flag does not fail the build', async () => {
  const reportPath = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'report.json');
  const { deps } = baseDeps({
    createModelCaller: () => fakeModel({ fill: fabricatingFill }),
    createJevChecker: () => fakeJevChecker(),
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify', 'jev', '--dry-run', '--report', reportPath], deps);

  assert.equal(code, 0, 'advisory never fails the build on a remaining flag');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { verifyMode: string };
  assert.equal(report.verifyMode, 'advisory');
});

test('legacy --verify jev --verify-strict together resolves strict', async () => {
  const { deps, stdout } = baseDeps({
    createModelCaller: () => fakeModel({ fill: fabricatingFill }),
    createJevChecker: () => fakeJevChecker(),
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify', 'jev', '--verify-strict', '--dry-run'], deps);

  assert.equal(code, 2);
  assert.ok(stdout.some((line) => line.includes('VERIFY-STRICT FAILED')));
});

test('conflicting --verify-strict / --verify-mode exits 2 before the model caller is ever built', async () => {
  let modelFactoryCalls = 0;
  const { deps, daemonCalls, stderr } = baseDeps({
    createModelCaller: () => {
      modelFactoryCalls += 1;
      return fakeModel();
    },
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-strict', '--verify-mode', 'advisory'], deps);

  assert.equal(code, 2);
  assert.equal(modelFactoryCalls, 0);
  assert.equal(daemonCalls.length, 0);
  assert.ok(stderr.some((line) => line.includes('--verify-strict conflicts with --verify-mode advisory')));
});

test('a preflight failure precedes every model call and every daemon/file mutation, for a plain build', async () => {
  const outDir = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'out');
  let modelFactoryCalls = 0;
  const { deps, daemonCalls, stderr } = baseDeps({
    resolveJevCredential: async () => { throw new Error('zsvault returned no value for typesafe_api_key'); },
    createModelCaller: () => {
      modelFactoryCalls += 1;
      return fakeModel();
    },
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--out-dir', outDir], deps);

  assert.equal(code, 2);
  assert.equal(modelFactoryCalls, 0, 'the preflight runs before the model caller is ever built');
  assert.equal(daemonCalls.length, 0);
  assert.ok(stderr.some((line) => line.includes('needs a Jev credential')));
  await assert.rejects(readFile(path.join(outDir, 'maben-r1.html')), /ENOENT/, '--out-dir was never even created, let alone written into');
});

test('a broken credential is reported before the brief file is even read', async () => {
  // The preflight comes first, ahead of every other thing that can fail: a build that cannot
  // verify is told so, with exit 2, rather than being told about the next problem down the list.
  // The brief path here does not exist, so an order that read it first would answer ENOENT/exit 1.
  const { deps, daemonCalls, stderr } = baseDeps({
    resolveJevCredential: async () => { throw new Error('zsvault returned no value for typesafe_api_key'); },
  });
  const missingBrief = path.join(briefDir, 'no-such-brief.md');
  const code = await main(['--family', 'maben', '--brief', missingBrief], deps);

  assert.equal(code, 2);
  assert.equal(daemonCalls.length, 0);
  assert.ok(stderr.some((line) => line.includes('needs a Jev credential')), `expected the credential failure, got ${JSON.stringify(stderr)}`);
  assert.ok(!stderr.some((line) => line.includes('ENOENT')), 'the missing brief must not be what a broken credential reports');
});

test('--family auto: a FAILED preflight runs before the router is ever built, one credential read', async () => {
  let credentialCalls = 0;
  let routerFactoryCalls = 0;
  let modelFactoryCalls = 0;
  const { deps, daemonCalls, stderr } = baseDeps({
    resolveJevCredential: async () => {
      credentialCalls += 1;
      throw new Error('zsvault returned no value for typesafe_api_key');
    },
    createJevRouter: () => {
      routerFactoryCalls += 1;
      return { route: async () => { throw new Error('the router must never be reached'); } };
    },
    createModelCaller: () => {
      modelFactoryCalls += 1;
      return fakeModel();
    },
  });
  const code = await main(['--family', 'auto', '--brief', briefPath], deps);

  assert.equal(code, 2);
  assert.ok(stderr.some((line) => line.includes('needs a Jev credential')));
  assert.equal(routerFactoryCalls, 0, 'strict/advisory preflights before the router is ever built');
  assert.equal(modelFactoryCalls, 0);
  assert.equal(daemonCalls.length, 0);
  assert.equal(credentialCalls, 1, 'a failed preflight is the only credential read this run ever makes');
});

test('--family auto, strict, a SUCCESSFUL run: routing and verification both use the shared resolver, one underlying read', async () => {
  // The failed-preflight test above only proves the preflight's OWN read is shared with itself —
  // routing and verification never run on that path, so a bug where they carried a separate
  // resolver would still pass it. This test lets the credential succeed and has the fake router
  // and the fake checker each actually call the `apiKey` they were given, so a second resolver
  // anywhere in that chain would show up as more than one underlying read.
  let credentialCalls = 0;
  let routerApiKeyCalls = 0;
  let checkerApiKeyCalls = 0;
  const resolveGivenApiKey = async (apiKey: string | (() => Promise<string>)): Promise<string> => (typeof apiKey === 'function' ? apiKey() : apiKey);

  const { deps, daemonCalls } = baseDeps({
    resolveJevCredential: async () => {
      credentialCalls += 1;
      return 'shared-key';
    },
    createJevRouter: (options) => ({
      route: async () => {
        routerApiKeyCalls += 1;
        await resolveGivenApiKey(options.apiKey);
        return fakeRoutedDecision;
      },
    }),
    createJevChecker: (options) => ({
      checkFaithfulness: async () => {
        checkerApiKeyCalls += 1;
        await resolveGivenApiKey(options.apiKey);
        return { flagged: [], ms: 1, calls: 1 };
      },
    }),
  });
  const code = await main(['--family', 'auto', '--brief', briefPath], deps);

  assert.equal(code, 0, `expected a clean strict pass, got exit ${code}`);
  assert.equal(routerApiKeyCalls, 1, 'the fake router did resolve the key it was given');
  assert.equal(checkerApiKeyCalls, 1, 'the fake checker did resolve the key it was given');
  assert.equal(credentialCalls, 1, 'exactly one underlying credential read across the preflight, routing and verification');
  assert.ok(daemonCalls.length > 0, 'a clean strict pass still publishes');
});

test('--route-only, routed: exits 0, writes the route decision, and never builds', async () => {
  const reportPath = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'route-report.json');
  let modelFactoryCalls = 0;
  const { deps, daemonCalls } = baseDeps({
    createJevRouter: () => ({ route: async () => fakeRoutedDecision }),
    createModelCaller: () => {
      modelFactoryCalls += 1;
      return fakeModel();
    },
  });
  const code = await main(['--route-only', '--brief', briefPath, '--report', reportPath], deps);

  assert.equal(code, 0);
  assert.equal(modelFactoryCalls, 0, '--route-only never builds, so the model caller is never constructed');
  assert.equal(daemonCalls.length, 0);
  const written = JSON.parse(await readFile(reportPath, 'utf8')) as { route: RouteDecision };
  assert.deepEqual(written.route, { ...fakeRoutedDecision, routeAttempts: 1 });
});

test('--route-only, a routing failure: exits 1 through routing\'s own error path, not the preflight', async () => {
  // --route-only always resolves to verify-mode off (see resolveVerifyPolicy), so this run never
  // reaches the credential preflight at all; a failure inside the router itself is a plain
  // uncaught error, handled by main's generic catch (exit 1), not the preflight's exit 2.
  const { deps, daemonCalls, stderr } = baseDeps({
    createJevRouter: () => ({ route: async () => { throw new Error('jev 500 upstream error'); } }),
  });
  const code = await main(['--route-only', '--brief', briefPath], deps);

  assert.equal(code, 1);
  assert.equal(daemonCalls.length, 0);
  assert.ok(stderr.some((line) => line.includes('jev 500 upstream error')));
});

test('--family auto, unrouted (not --route-only): exits 3 and builds nothing', async () => {
  const reportPath = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'unrouted-report.json');
  let modelFactoryCalls = 0;
  const { deps, daemonCalls } = baseDeps({
    createJevRouter: () => ({ route: async () => fakeUnroutedDecision }),
    createModelCaller: () => {
      modelFactoryCalls += 1;
      return fakeModel();
    },
  });
  const code = await main(['--family', 'auto', '--brief', briefPath, '--report', reportPath], deps);

  assert.equal(code, 3);
  assert.equal(modelFactoryCalls, 0, 'unrouted never builds, so the model caller is never constructed');
  assert.equal(daemonCalls.length, 0);
  const written = JSON.parse(await readFile(reportPath, 'utf8')) as { route: RouteDecision };
  assert.deepEqual(written.route, { ...fakeUnroutedDecision, routeAttempts: 1 });
});

test('verifyMode is named in both the written report and the console summary', async () => {
  const reportPath = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'report.json');
  const { deps, stdout } = baseDeps();
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-mode', 'off', '--dry-run', '--report', reportPath], deps);

  assert.equal(code, 0);
  assert.ok(stdout.some((line) => line === 'verify-mode: off'));
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { verifyMode: string };
  assert.equal(report.verifyMode, 'off');
});

test('strict + dry-run: a clean pass says nothing was registered, not "registered"', async () => {
  const { deps, stdout } = baseDeps({ createJevChecker: () => fakeJevChecker() });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-mode', 'strict', '--dry-run'], deps);

  assert.equal(code, 0);
  assert.ok(stdout.includes('verify-strict: passed — dry run, nothing registered.'));
  assert.ok(!stdout.some((line) => line.includes('passed — registered')), 'the old wording must not appear for a dry run');
});

test('sentinel: a raw upstream body never reaches stderr or the written report, through the real checker', async () => {
  const sentinel = 'SENTINEL-BODY-7731';
  const reportPath = path.join(await mkdtemp(path.join(tmpdir(), 'fast-lane-cli-test-')), 'report.json');
  const sentinelFetch = (async () => new Response(`<html>${sentinel} — internal trace</html>`, { status: 500 })) as typeof fetch;
  // Real createJevChecker, only its transport faked: proves the sanitization in jev.ts actually
  // holds all the way out through run.ts's skipped-catch and the CLI's own stdout/report, not
  // just at the unit level already covered by tests/jev.test.ts.
  const { deps, stdout, stderr } = baseDeps({
    createJevChecker: (options) => createJevChecker({ ...options, fetchImpl: sentinelFetch }),
  });
  const code = await main(['--family', 'maben', '--brief', briefPath, '--verify-mode', 'advisory', '--dry-run', '--report', reportPath], deps);

  assert.equal(code, 0, 'a skipped advisory check never fails the build');
  for (const line of stdout) assert.ok(!line.includes(sentinel), `stdout leaked the sentinel: ${line}`);
  for (const line of stderr) assert.ok(!line.includes(sentinel), `stderr leaked the sentinel: ${line}`);
  const reportText = await readFile(reportPath, 'utf8');
  assert.ok(!reportText.includes(sentinel), 'the written report leaked the sentinel');
  assert.ok(stdout.some((line) => line.includes('SKIPPED')), 'the skip is still visible, just sanitized');
});
