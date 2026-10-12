import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createModelCaller, ProviderHttpError, type ModelCall } from '../src/deepseek.ts';
import { ProviderFailoverError } from '../src/failover.ts';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker } from '../src/jev.ts';
import { ensureProject, projectPublisher, type ProjectPublisher } from '../src/publish.ts';
import { withoutUntracedClaims } from '../src/repair-hints.ts';
import { faithfulnessRepairError, refusalDetail, runFastLane, UnitRefusedError, withAdapterDeterministicGates, type RunEvent } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, nullablePathsOf, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, fillTemplate, loadMaben, promptBlock, WATSON_DIR, type Filler } from './fixtures.ts';

const pkg = await loadMaben();
const ENTRY = 'maben-r1.html';
const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';

type Save = { kind: 'page' | 'file' | 'delete'; name: string; encoding?: string; manifestEntry?: string; label?: string };

function stubPublisher(): ProjectPublisher & { saves: Save[] } {
  const saves: Save[] = [];
  return {
    projectId: 'p1',
    saves,
    async savePage(entry, _html, manifest, label) {
      saves.push({ kind: 'page', name: entry, manifestEntry: isObject(manifest) ? String(manifest.entry) : undefined, label });
    },
    async saveFile(name, _content, encoding = 'utf8') {
      saves.push({ kind: 'file', name, encoding });
    },
    async deleteProject() {
      saves.push({ kind: 'delete', name: 'p1' });
      return 'deleted' as const;
    },
  };
}

/** Fills a template normally, then makes the hero statement overflow its 400-character limit. */
function overflowHero(template: Json, limits: Json | undefined): Json | undefined {
  const filled = fillTemplate(template, limits) as JsonObject;
  const hero = Array.isArray(filled.sections)
    ? (filled.sections as JsonObject[]).find((section) => section.id === 'maben-hero')
    : filled.id === 'maben-hero' ? filled : undefined;
  if (!hero) return undefined;
  (hero.text as JsonObject).statement = 'x'.repeat(401);
  return filled;
}

// -- callModel's bounded transport retry (G8 final on 857a46b982: halcyon x deepseek BUILD_FAILED,
// ECONNRESET mid-request on the "support" unit, --no-failover). Never a provider failover, never
// more than 2 extra attempts, never on a non-transport failure. --------------------------------

test('a transport-class failure is retried once, to the SAME unit request, then succeeds', async () => {
  let attempts = 0;
  const good = fakeModel();
  const model: ModelCall = async (request) => {
    attempts += 1;
    if (attempts === 1) throw new ProviderHttpError('fake', 503);
    return good(request);
  };
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(attempts, 2, 'the failed attempt plus exactly one retry');
  assert.equal(report.retries, 1);
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].type === 'transport-retry' && retryEvents[0].attempt, 1);
  assert.equal(retryEvents[0].type === 'transport-retry' && retryEvents[0].reason, 'http-5xx');
  assert.ok(report.html.includes('Riverbend Dental'), 'the retried call still fills the page');
});

test('a refusal is never retried: the build fails on the first attempt', async () => {
  let attempts = 0;
  const model: ModelCall = async () => {
    attempts += 1;
    throw new Error('the model refused');
  };
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
    /the model refused/,
  );
  assert.equal(attempts, 1, 'a non-transport failure gets no extra attempt');
  assert.equal(events.filter((event) => event.type === 'transport-retry').length, 0);
});

test('3 transport-class failures exhaust the retry budget: 3 attempts total, then the build fails', async () => {
  let attempts = 0;
  const model: ModelCall = async () => {
    attempts += 1;
    throw new ProviderHttpError('fake', 503);
  };
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
    (error: unknown) => error instanceof ProviderHttpError,
  );
  assert.equal(attempts, 3, 'the original attempt plus two bounded retries — never a third retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 2);
  assert.deepEqual(retryEvents.map((event) => event.type === 'transport-retry' && event.attempt), [1, 2]);
});

// -- G8 final: the REAL `createModelCaller` path (real undici-shaped errors raised during the
// body read), covering what the hand-rolled `ModelCall` tests above cannot — deepseek.ts's own
// error tagging feeding `transportRetryReasonOf`, a genuine mid-stream reset with a working-state
// rollback, a pre-output timeout, and the cases that must never retry (a refusal, a
// `ProviderFailoverError`). `build.ts` sets the real caller's own `maxRetries` to 0 for a
// `--no-failover` build, so every retry below is `callModel`'s own bounded budget, never a
// provider-internal one stacked underneath it. --------------------------------------------------

/** A single JSON text as an SSE stream of small delta chunks (matching `fakeModel`'s own chunking:
 * a whole-page answer parses correctly only as it is fed incrementally, the same way a real
 * provider streams tokens rather than one giant line). */
function sseBody(fullText: string, size = 7): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < fullText.length; index += size) {
        const content = fullText.slice(index, index + size);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** The same incremental delivery as `sseBody`, but only through `throughChars` of `fullText`, then
 * a REAL undici-shaped error: a read failure carrying `.code` (`ECONNRESET`), or undici's own
 * `TypeError: terminated` with a socket-error `.cause`. */
function sseBodyThenReset(fullText: string, throughChars: number, kind: 'ECONNRESET' | 'terminated' = 'ECONNRESET', size = 7): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < throughChars) {
        const content = fullText.slice(index, index + size);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        index += size;
        return;
      }
      if (kind === 'terminated') {
        const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
        controller.error(Object.assign(new TypeError('terminated'), { cause }));
      } else {
        controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      }
    },
  });
}

/** The user prompt's own TEMPLATE, filled the same way `fakeModel` does — reused here so a real
 * `fetchImpl` mock can answer with content that is actually valid for whichever unit is asking,
 * without hand-authoring the family's JSON shape. */
function fillPromptTemplate(requestBody: string, fill: Filler = (key, _value, _at, limit) => {
  const text = `New ${key} for Riverbend Dental`;
  return typeof limit === 'number' ? text.slice(0, limit) : text;
}): unknown {
  const body = JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> };
  const user = body.messages.find((message) => message.role === 'user')!.content;
  return fillTemplate(promptBlockFromUser(user, 'TEMPLATE'), promptBlockFromUser(user, 'LIMITS'), fill);
}
function promptBlockFromUser(prompt: string, heading: 'LIMITS' | 'TEMPLATE'): Json {
  const start = prompt.indexOf(`\n${heading}\n`);
  const body = prompt.slice(start + heading.length + 2);
  const end = ['\n\nTEMPLATE\n', '\n\nYOUR PREVIOUS ANSWER WAS REJECTED\n'].map((marker) => body.indexOf(marker)).filter((index) => index >= 0);
  return JSON.parse(end.length > 0 ? body.slice(0, Math.min(...end)) : body) as Json;
}

test('real createModelCaller: pre-byte resets beyond callModel\'s own budget still fail the build', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
  );
  assert.equal(attempts, 3, 'the original attempt plus callModel\'s own two retries — no provider-internal retry stacked under it');
  assert.equal(events.filter((event) => event.type === 'transport-retry').length, 2);
});

// Round 2 audit (Opus B1, FIX): single-page mode is the one call whose `onDelta` merges into
// `working` DURING the call. There is no rollback for it any more — see `callModel`'s own doc —
// so a transport failure there is retried only when NOTHING has merged yet; once a section has
// merged, the call fails outright rather than risk a mixed-attempt page.

test('real createModelCaller: single-page mode retries a transport failure that arrives before anything has merged', async () => {
  let attempts = 0;
  const fetchImpl = (async (_input, init) => {
    attempts += 1;
    const filled = fillPromptTemplate(String(init?.body ?? '{}'));
    const text = JSON.stringify(filled);
    if (attempts === 1) {
      // Cut well inside the opening `{"brand":{...` — nowhere near a closing brace the stream
      // parser could treat as a complete unit, so nothing has merged when the reset fires.
      return new Response(sseBodyThenReset(text, 15), { status: 200 });
    }
    return new Response(sseBody(text), { status: 200 });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(attempts, 2, 'the failed attempt plus one clean retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.reason, 'ECONNRESET');
  const retryIndex = events.findIndex((event) => event.type === 'transport-retry');
  assert.equal(
    events.slice(0, retryIndex).some((event) => event.type === 'merged' && event.label.startsWith('stream:')),
    false,
    'the failed attempt (everything before the transport-retry event) merged nothing, by construction of the cut',
  );
  assert.equal(report.html.includes('Riverbend Dental'), true);
});

test('real createModelCaller: single-page mode never retries once a section has merged — the build fails instead of risking a mixed page', async () => {
  let attempts = 0;
  const fetchImpl = (async (_input, init) => {
    attempts += 1;
    const filled = fillPromptTemplate(String(init?.body ?? '{}'));
    const text = JSON.stringify(filled);
    // Enough of the page to complete the brand unit and at least one section in the stream
    // parser, THEN a real mid-stream reset. Every attempt does this: if a retry ever fired, it
    // would hit the exact same cut and merge the exact same content a second time.
    const cut = Math.max(text.indexOf('"sections"'), Math.floor(text.length / 2));
    return new Response(sseBodyThenReset(text, cut), { status: 200 });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
  );
  assert.equal(attempts, 1, 'no retry after a merge — the build fails on the first attempt rather than stack a second, possibly-mixed one');
  assert.equal(events.filter((event) => event.type === 'transport-retry').length, 0);
  assert.equal(
    events.some((event) => event.type === 'merged' && event.label.startsWith('stream:')),
    true,
    'at least one section merged before the reset, by construction of the cut',
  );
});

test('real createModelCaller: a pre-output timeout is retried; output already flowing is not', async () => {
  let attempts = 0;
  const fetchImpl = (async (_input, init) => {
    attempts += 1;
    if (attempts === 1) {
      // No byte at all: hangs until the CALLER's own signal aborts it — a real `fetch` rejects
      // the same way once its own AbortSignal fires.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(signal.reason ?? new DOMException('aborted', 'AbortError')); return; }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    const filled = fillPromptTemplate(String(init?.body ?? '{}'));
    return new Response(sseBody(JSON.stringify(filled)), { status: 200 });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0, timeoutMs: 20_000 });
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', callTimeoutMs: 50, onEvent: (event) => events.push(event) });
  assert.equal(attempts, 2, 'the timed-out attempt plus one retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.reason, 'ETIMEDOUT');
  assert.equal(report.html.includes('Riverbend Dental'), true);
});

test('a refusal is never retried, even through the real createModelCaller path', async () => {
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return new Response('bad request: refused', { status: 400 });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
    (error: unknown) => error instanceof ProviderHttpError && error.status === 400,
  );
  assert.equal(attempts, 1, 'a 400 is a refusal, not a transport failure — no retry');
  assert.equal(events.filter((event) => event.type === 'transport-retry').length, 0);
});

// Round 2 audit requirement (forced-fault live run, real `createModelCaller` path): a fetch-level
// reset on ONE unit's first request in `sections` mode — the daemon's default — while every other
// unit's own request succeeds concurrently. Proves the whole real stack (deepseek.ts's error
// tagging -> `transportRetryReasonOf` -> `callModel`'s per-unit budget -> a `transport-retry`
// event) produces a passing, correctly-filled page, not a page-wide test double standing in for
// the real transport layer.
test('real createModelCaller, sections mode: a fetch-level reset on one unit\'s first request still produces a passing page, evented', async () => {
  let brandAttempts = 0;
  const fetchImpl = (async (_input, init) => {
    const user = (JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === 'user')!.content;
    const label = /Fill the "([^"]+)" part of the page template/.exec(user)?.[1];
    if (label === 'brand') {
      brandAttempts += 1;
      if (brandAttempts === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    }
    const filled = fillPromptTemplate(String(init?.body ?? '{}'));
    return new Response(sseBody(JSON.stringify(filled)), { status: 200 });
  }) as typeof fetch;
  const model = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(brandAttempts, 2, 'brand: the reset attempt plus one clean retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.label, 'brand');
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.reason, 'ECONNRESET');
  // Every unit — including brand, via its retry — reached the page with real, filled content.
  assert.equal(report.html.includes('Riverbend Dental'), true);
  const unitEvents = events.filter((event) => event.type === 'unit');
  assert.ok(unitEvents.length > 1, 'more than one unit filled');
  assert.ok(unitEvents.every((event) => event.type === 'unit' && event.repairs === 0), 'no unit needed a technical repair — every answer, including brand\'s retry, was valid on its own');
});

test('a ProviderFailoverError is never retried at the unit level', async () => {
  let attempts = 0;
  const model: ModelCall = async () => {
    attempts += 1;
    throw new ProviderFailoverError([{ provider: 'deepseek', reason: 'server-error', status: 500 }, { provider: 'cerebras', reason: 'timeout' }]);
  };
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
    (error: unknown) => error instanceof ProviderFailoverError,
  );
  assert.equal(attempts, 1, 'both providers already failed — retrying the same failed pair again is never a fix');
  assert.equal(events.filter((event) => event.type === 'transport-retry').length, 0);
});

// -- Round 2 audit (Opus B1, race repro): `sections` mode (the daemon's default) and every repair
// call run several units' `callModel` loops CONCURRENTLY. Neither one's `onDelta` merges anything
// into `working` until AFTER its own `options.model(...)` resolves (`fillUnit`/`repairUnit` apply
// the answer only once callModel returns), so a transport retry on ONE unit never needs to roll
// anything back — and must never touch another unit's already-merged work. These tests reproduce
// Opus's `/tmp/hg8r2/race.test.ts`: one unit fails and retries while every other unit finishes and
// merges concurrently. -----------------------------------------------------------------------

// Round 3 audit (Opus F1, reproduced against e462579cb1's run.ts, a scratch copy — never this
// branch): the ORIGINAL assertions here (each label's own `merged` event fires once, and the html
// contains "Riverbend Dental") pass even against the buggy global-rollback code, because that bug
// erases OTHER units' content back to reference-fixture text WITHOUT emitting a second `merged`
// event for them (the rollback runs between attempts, never re-merges anything for the erased
// unit) and "Riverbend Dental" still appears via brand's own retried content regardless. Fixed by
// comparing the retried build's actual OUTPUT against a clean, no-retry run of the exact same
// build: the same total filled-string count (`report.applied`), and every OTHER unit's own filled
// text from the clean run present in the retried run's `report.html`. Against e462563cb1 this find
// 4 of 89 strings filled and every non-brand unit's own text missing, replaced by the reference
// fixture's; against this branch's `run.ts` both checks hold.

test('sections mode: a transport retry on one unit never erases another unit\'s already-merged work (race regression, Opus B1)', async () => {
  const good = fakeModel();
  const clean = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: good, modelName: 'fake' });
  let brandAttempts = 0;
  const model: ModelCall = async (request) => {
    if (request.label !== 'brand') return good(request);
    brandAttempts += 1;
    if (brandAttempts === 1) {
      // Give every OTHER unit's own fillUnit call time to finish and merge first — the exact
      // interleaving Opus's repro relies on (unit B merges while unit A's attempt is still open).
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new ProviderHttpError('fake', 503);
    }
    return good(request);
  };
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(brandAttempts, 2, 'brand: the failed attempt plus one retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.label, 'brand');
  const mergedLabels = events.filter((event) => event.type === 'merged').map((event) => event.label);
  const otherLabels = new Set(mergedLabels.filter((label) => label !== 'brand'));
  assert.ok(otherLabels.size > 0, 'at least one other unit merged while brand was mid-retry');
  for (const label of otherLabels) {
    assert.equal(mergedLabels.filter((entry) => entry === label).length, 1, `${label} merged exactly once — never rolled back and redone by brand's retry`);
  }
  assert.equal(mergedLabels.filter((entry) => entry === 'brand').length, 1, 'brand itself also merged exactly once, from its retry');
  // The real Opus F1 proof: the SAME total number of strings filled as the clean, no-retry build
  // (never fewer — nothing was rolled back and left unfilled), and every other unit's own text
  // from the clean build present in the retried build's published page.
  assert.equal(report.applied, clean.applied, 'the same number of strings filled as a clean, no-retry run of this build');
  assert.equal(report.html, clean.html, 'byte-for-byte the same page as the clean, no-retry run — never a mix of two attempts or a reference fallback for any unit');
});

test('technical repair phase: a transport retry on one unit\'s repair call never erases a concurrent unit\'s own repair (same race, repair path)', async () => {
  const good = fakeModel();
  // Every unit's first answer is missing its required text (an empty fill), so every unit needs
  // one technical repair — all of them running concurrently, exactly like `sections` mode's own
  // fill calls.
  const incompleteFirst = fakeModel({ fill: () => '' });
  const cleanModel: ModelCall = async (request) => {
    const repairing = request.user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n');
    return repairing ? good(request) : incompleteFirst(request);
  };
  const clean = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: cleanModel, modelName: 'fake' });
  let brandRepairAttempts = 0;
  const model: ModelCall = async (request) => {
    const repairing = request.user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n');
    if (!repairing) return incompleteFirst(request);
    if (request.label !== 'brand') return good(request);
    brandRepairAttempts += 1;
    if (brandRepairAttempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new ProviderHttpError('fake', 503);
    }
    return good(request);
  };
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(brandRepairAttempts, 2, 'brand\'s repair: the failed attempt plus one retry');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.label, 'brand');
  const repairMergedLabels = events.flatMap((event) => (event.type === 'merged' && event.label.startsWith('repair:') ? [event.label] : []));
  const otherRepairLabels = new Set(repairMergedLabels.filter((label) => label !== 'repair:brand'));
  assert.ok(otherRepairLabels.size > 0, 'at least one other unit\'s repair merged while brand\'s repair was mid-retry');
  for (const label of otherRepairLabels) {
    assert.equal(repairMergedLabels.filter((entry) => entry === label).length, 1, `${label} merged exactly once — never rolled back and redone by brand's repair retry`);
  }
  // Same real proof as the fill-phase test above: identical filled-string count and a byte-for-
  // byte identical published page against a clean, no-retry run of this same repair-forcing build.
  assert.equal(report.applied, clean.applied, 'the same number of strings filled as a clean, no-retry run of this build');
  assert.equal(report.html, clean.html, 'byte-for-byte the same page as the clean, no-retry run');
});

test('the transport-retry budget is per unit, shared across its fill call and every later repair call — never a fresh 2 per callModel invocation', async () => {
  const good = fakeModel();
  let brandCalls = 0;
  const model: ModelCall = async (request) => {
    if (request.label !== 'brand') return good(request);
    brandCalls += 1;
    // 1: fill's own first attempt fails (budget 0 -> 1, retried).
    if (brandCalls === 1) throw new ProviderHttpError('fake', 503);
    // 2: fill's retry succeeds, but with an incomplete answer, forcing a technical repair.
    if (brandCalls === 2) return { text: '{}', ms: 1, retries: 0 };
    // 3: the repair call's own first attempt ALSO fails (budget 1 -> 2, still under the cap: retried).
    if (brandCalls === 3) throw new ProviderHttpError('fake', 503);
    // 4: the repair's retry fails too — budget is already at 2, so THIS one is never retried:
    // callModel throws it straight through, failing the build.
    throw new ProviderHttpError('fake', 503);
  };
  const events: RunEvent[] = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) }),
    (error: unknown) => error instanceof ProviderHttpError,
  );
  assert.equal(brandCalls, 4, '2 original requests (fill, then its forced repair) plus exactly 2 retries total — never 2 more per call');
  const retryEvents = events.filter((event) => event.type === 'transport-retry' && event.label === 'brand');
  assert.equal(retryEvents.length, 2);
  assert.deepEqual(retryEvents.map((event) => event.type === 'transport-retry' && event.attempt), [1, 2], 'attempt counts across BOTH calls, never resetting to 1 for the repair call');
});

test('single mode paints progressively and ends with a valid, fully rewritten page', async () => {
  const model = fakeModel();
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(report.calls, 1);
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  const streamed = events.filter((event) => event.type === 'merged' && event.label.startsWith('stream:'));
  assert.equal(streamed.length, 8, 'every unit is merged from the stream before the answer completes');
  assert.ok(report.paints >= 3, `expected progressive paints, got ${report.paints}`);
  assert.ok(events.some((event) => event.type === 'first-token'));
  assert.equal(events.filter((event) => event.type === 'paint').length, report.paints);
  assert.equal(report.html.includes('STRATUM'), false, 'no text from the spine client remains');
  assert.ok(report.html.includes('Riverbend Dental'));
  assert.equal(pkg.render(report.recipe, ENTRY).manifest.metadata.agencySite.recipeDigest, report.recipeDigest);
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'assets', 'media']), getAtPath(pkg.fixture, ['sections', 2, 'assets', 'media']));
  assert.equal(report.timings.firstPaintMs !== undefined && report.timings.finalPaintMs !== undefined, true);
  assert.equal(report.usage.output, 50);
});

test('sections mode makes one call per unit and publishes assets before pages, then the state', async () => {
  const model = fakeModel();
  const publisher = stubPublisher();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', publisher });
  assert.equal(report.calls, 8);
  assert.equal(report.projectId, 'p1');
  assert.ok(report.paints >= 1);
  const firstPage = publisher.saves.findIndex((save) => save.kind === 'page');
  const assetSaves = publisher.saves.filter((save) => save.kind === 'file' && save.name.startsWith('assets/agency-site/maben-r1/'));
  assert.equal(assetSaves.length, 17);
  assert.ok(assetSaves.every((save) => save.encoding === 'base64'));
  assert.ok(publisher.saves.slice(0, firstPage).filter((save) => save.kind === 'file').length >= 17, 'every asset lands before the first page save');
  assert.ok(publisher.saves.filter((save) => save.kind === 'page').every((save) => save.manifestEntry === ENTRY));
  const names = publisher.saves.map((save) => save.name);
  for (const expected of ['agency-site-state/r1/recipe.json', 'agency-site-state/r1/approved-assets.json', 'AGENCY-SITE-STATE.md', 'agency-site-state/r1/assets/hero-frame.png']) assert.ok(names.includes(expected), expected);
  assert.ok(report.timings.registeredMs !== undefined);
  assert.equal(report.units.length, 8);
});

test('a page save the daemon refuses fails the run with the daemon error, not an unhandled rejection', async () => {
  const publisher = stubPublisher();
  publisher.savePage = async () => { throw new Error('daemon 500 on /api/projects/p1/files: disk full'); };
  const model = fakeModel();
  await assert.rejects(runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake', publisher }), /daemon 500 on \/api\/projects\/p1\/files: disk full/);
});

test('an asset upload the daemon refuses fails the run with the daemon error', async () => {
  const publisher = stubPublisher();
  publisher.saveFile = async (name) => { if (name.endsWith('hero-frame.png')) throw new Error('daemon 413 on /api/projects/p1/files: too large'); };
  const model = fakeModel();
  await assert.rejects(runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', publisher }), /daemon 413/);
});

test('single mode repairs one unit the validator refuses, without re-asking for the page', async () => {
  const model = fakeModel({ firstAnswer: overflowHero });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.calls, 2);
  assert.equal(report.repairs, 1);
  assert.ok((getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string).length <= 400);
  assert.equal(report.units.find((unit) => unit.label === 'maben-hero')?.repairs, 1);
  assert.ok(model.prompts[1]!.includes('at most 400 characters'));
});

test('a unit that comes back with text missing is repaired', async () => {
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      const hero = (filled.sections as JsonObject[] | undefined)?.find((section) => section.id === 'maben-hero');
      if (!hero) return undefined;
      delete (hero.text as JsonObject).mediaNote;
      return filled;
    },
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 1);
  assert.deepEqual(report.missing, []);
  assert.notEqual(getAtPath(report.recipe, ['sections', 2, 'text', 'mediaNote']), getAtPath(pkg.fixture, ['sections', 2, 'text', 'mediaNote']));
  assert.ok(model.prompts[1]!.includes('missing or empty values: sections[2].text.mediaNote'));
});

test('sections mode: an incomplete repair on a REQUIRED slot (outside any nullable group) is narrowed to the missing slot(s) — sibling text in the same unit is locked to its accepted answer, and the repair TEMPLATE shows that accepted text rather than the original example', async () => {
  // G8 final 32f08a40cd (emmpo x cerebras): emmpo-talents came back with a required slot empty,
  // and BOTH technical repairs — each re-asking the WHOLE unit again with no memory of what the
  // first answer already got right — came back with a (possibly different) slot empty too,
  // exhausting the budget. The fix narrows an 'incomplete' repair to exactly the paths
  // `applyUnit` reported missing, the same way a faithfulness repair narrows to its flagged
  // paths: every other slot is locked to its own accepted answer, and shown to the model as
  // already-accepted context rather than the original TEMPLATE placeholder.
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      // Sections mode calls once per unit, so the per-call TEMPLATE is already the hero unit's
      // own shape (`{id: 'maben-hero', text: {...}}`), not the whole-page shape `overflowHero`
      // (single mode) matches against — handle both, like that helper does.
      const hero = Array.isArray(filled.sections)
        ? (filled.sections as JsonObject[]).find((section) => section.id === 'maben-hero')
        : filled.id === 'maben-hero' ? filled : undefined;
      if (!hero) return undefined;
      delete (hero.text as JsonObject).mediaNote;
      return filled;
    },
    // The repair's own fill: if a sibling slot is not actually locked, this makes it obvious —
    // every text slot gets a REPAIR-* marker distinct from the first fill's "New <key> for
    // Riverbend Dental" text, including the one slot (statement) that should stay locked.
    fill: (key) => `REPAIR-${key}`,
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 1);
  assert.deepEqual(report.missing, []);
  const heroUnitIndex = model.prompts.findIndex((prompt) => prompt.includes('missing or empty values: sections[2].text.mediaNote'));
  assert.ok(heroUnitIndex >= 0, 'the repair prompt names the missing slot');
  const repairTemplate = promptBlock(model.prompts[heroUnitIndex]!, 'TEMPLATE') as JsonObject;
  const heroTemplate = ((repairTemplate.sections as JsonObject[] | undefined) ?? [repairTemplate]).find((section) => section === repairTemplate || (section as JsonObject).id === 'maben-hero') as JsonObject;
  const heroText = (Array.isArray(repairTemplate.sections) ? heroTemplate.text : repairTemplate.text) as JsonObject;
  // The accepted first-fill text for the locked sibling slot is what the repair TEMPLATE shows —
  // not the family's own reference example, and not empty.
  assert.equal(heroText.statement, 'New statement for Riverbend Dental');
  // The final recipe keeps that same accepted text: the repair's REPAIR-* fill for `statement`
  // never lands, because the slot was locked.
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'text', 'statement']), 'New statement for Riverbend Dental');
  // Only the slot that was actually missing takes the repair's new answer.
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'text', 'mediaNote']), 'REPAIR-mediaNote');
});

/** Keep unrelated units at their valid fixture values in focused repair regressions. */
function lockOutsideSection(recipe: Json, sectionIndex: number): string[] {
  const prefix = `sections[${sectionIndex}].`;
  const visit = (value: Json, at = ''): string[] => {
    if (typeof value === 'string' || value === null) return at.startsWith(prefix) ? [] : [at];
    if (Array.isArray(value)) return value.flatMap((item, index) => visit(item, `${at}[${index}]`));
    if (isObject(value)) return Object.entries(value).flatMap(([key, child]) => visit(child, at ? `${at}.${key}` : key));
    return [];
  };
  return visit(recipe);
}

for (const [templateCity, acceptedCity] of [[null, 'Denver'], ['(Los Angeles)', null]] as const) {
  test(`narrowed repair context reflects Watson accepted city ${JSON.stringify(acceptedCity)} from template ${JSON.stringify(templateCity)}`, async () => {
    const watson = await loadFamilyPackage(WATSON_DIR, 'watson');
    const spine = structuredClone(watson.fixture);
    const sectionIndex = (spine.sections as JsonObject[]).findIndex((section) => section.id === 'watson-statement');
    const content = (spine.sections as JsonObject[])[sectionIndex]!.content as JsonObject;
    content.city = templateCity;
    const model = fakeModel({
      firstAnswer: (template, limits) => {
        const filled = fillTemplate(template, limits) as JsonObject;
        if (filled.id !== 'watson-statement') return undefined;
        const text = filled.content as JsonObject;
        text.city = acceptedCity;
        text.opening = '';
        return filled;
      },
      fill: (key) => `REPAIR-${key}`,
    });
    const report = await runFastLane({ pkg: watson, spine, lockPaths: lockOutsideSection(spine, sectionIndex), brief: 'Riverbend Dental in Denver.', mode: 'sections', entry: 'watson-r1.html', revision: 1, model, modelName: 'fake' });
    assert.equal(report.repairs, 1);
    assert.deepEqual(report.missing, []);
    const repair = model.prompts.find((prompt) => prompt.includes(`missing or empty values: sections[${sectionIndex}].content.opening`));
    assert.ok(repair, 'the missing opening receives a narrowed repair');
    const shown = promptBlock(repair, 'TEMPLATE') as JsonObject;
    assert.equal((shown.content as JsonObject).city, acceptedCity, 'the locked city is visible as accepted, including null');
    assert.equal(getAtPath(report.recipe, ['sections', sectionIndex, 'content', 'city']), acceptedCity, 'the repair cannot replace the accepted city');
    assert.equal(getAtPath(report.recipe, ['sections', sectionIndex, 'content', 'opening']), 'REPAIR-opening');
    assert.equal(getAtPath(report.recipe, ['sections', sectionIndex, 'content', 'partnershipsFirst']), 'New partnershipsFirst for Riverbend Dental', 'other accepted sibling text remains locked');
  });
}

test('narrowed repair context preserves accepted Halcyon hours labels and values', async () => {
  const halcyon = await loadFamilyPackage(defaultPackageDir('halcyon'), 'halcyon');
  const sectionIndex = (halcyon.fixture.sections as JsonObject[]).findIndex((section) => section.id === 'visit');
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      if (filled.id !== 'visit') return undefined;
      const content = filled.content as JsonObject;
      content.block1Key1 = 'Wednesday-Friday';
      content.block1Value1 = '';
      content.block1Key2 = 'Saturday';
      content.block1Value2 = '10:00-19:00';
      content.block1Key3 = 'Sunday';
      content.block1Value3 = null;
      content.block1Key4 = 'Monday and Tuesday';
      content.block1Value4 = 'Closed';
      return filled;
    },
    fill: (key) => key === 'block1Value1' ? '11:00-18:00' : `REPAIR-${key}`,
  });
  const repairModel: ModelCall = async (request) => {
    const response = await model({ ...request, onDelta: undefined });
    if (!request.user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n')) return response;
    const answer = JSON.parse(response.text) as JsonObject;
    if (answer.id === 'visit') (answer.content as JsonObject).block1Value1 = '11:00-18:00';
    return { ...response, text: JSON.stringify(answer) };
  };
  const report = await runFastLane({ pkg: halcyon, lockPaths: lockOutsideSection(halcyon.fixture, sectionIndex), brief: 'Hours: Wednesday-Friday 11:00-18:00; Saturday 10:00-19:00; Monday and Tuesday closed.', mode: 'sections', entry: 'halcyon-r1.html', revision: 1, model: repairModel, modelName: 'fake' });
  assert.equal(report.repairs, 1);
  assert.deepEqual(report.missing, []);
  const repair = model.prompts.find((prompt) => prompt.includes(`missing or empty values: sections[${sectionIndex}].content.block1Value1`));
  assert.ok(repair, 'the missing hours value receives a narrowed repair');
  const shown = (promptBlock(repair, 'TEMPLATE') as JsonObject).content as JsonObject;
  assert.equal(shown.block1Key1, 'Wednesday-Friday', 'the day label is necessary context for its missing hours value');
  assert.equal(shown.block1Key2, 'Saturday');
  assert.equal(shown.block1Value2, '10:00-19:00');
  assert.equal(shown.block1Value3, null, 'an accepted null remains visible');
  assert.equal(shown.block1Value1, null, 'only the missing hours value keeps its prompt mask');
  const final = getAtPath(report.recipe, ['sections', sectionIndex, 'content']) as JsonObject;
  assert.equal(final.block1Value1, '11:00-18:00');
  assert.equal(final.block1Key1, 'Wednesday-Friday');
  assert.equal(final.block1Key2, 'Saturday');
  assert.equal(final.block1Value2, '10:00-19:00');
  assert.equal(final.block1Value3, null);
});

test("sections mode: an incomplete repair inside a nullable group (crm-dashboard's secondary KPI cards) may still null the WHOLE group, exactly as the unnarrowed repair always could", async () => {
  // Round-1 audit regression (Opus 5.5, proof/audits/emmpo-r1-opus55.md): narrowing an
  // `incomplete` repair to exactly the missing leaf, with every OTHER slot of the unit locked,
  // also locked every ANCESTOR container of that leaf — including a whole group the family
  // schema lets be null as one piece (`atomKindsFor`'s group kind: crm-dashboard's 3rd/4th KPI
  // card, `x-atom: "kpi-item"`). `mergeIntoSpine`'s whole-group-null branch checks
  // `report.lockedPaths` before honouring a candidate's `null` there, so a locked ancestor made
  // that legitimate answer — "the brief states no such KPI" — as impossible as leaving the
  // label blank again, and base 32f08a40cd recovers from exactly this shape of empty slot in
  // ONE (unnarrowed) repair. The fix keeps every ancestor of a missing leaf unlocked, so a
  // model that decides the whole group has no brief support may still null it.
  const pkg = await loadFamilyPackage(defaultPackageDir('crm-dashboard'), 'crm-dashboard');
  const crmFill: Filler = (key, _value, _at, limit) => {
    if (key === 'email') return 'pat@example.com';
    if (key === 'phone') return '555-0100';
    const text = `New ${key}`;
    return typeof limit === 'number' ? text.slice(0, limit) : text;
  };
  // Round-2 audit (Opus 5.5, proof/audits/emmpo-r2-opus55.md): the previous version of this test
  // filled BOTH the first answer and the repair answer with the same `crmFill`, so the 1st/2nd
  // KPI cards' assertion (`label === 'New label'`) would pass even without the lock — the repair
  // model happened to write the identical text either way. Repair now uses a DISTINCT marker for
  // every field, so a card that is not actually locked would show `REPAIR-label` instead.
  const crmRepairFill: Filler = (key, _value, _at, limit) => {
    if (key === 'email') return 'pat@example.com';
    if (key === 'phone') return '555-0100';
    const text = `REPAIR-${key}`;
    return typeof limit === 'number' ? text.slice(0, limit) : text;
  };
  const call: ModelCall & { prompts: string[] } = (async ({ user, onDelta }) => {
    call.prompts.push(user);
    const template = promptBlock(user, 'TEMPLATE');
    const limits = promptBlock(user, 'LIMITS');
    const repairing = user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n');
    const filled = fillTemplate(template, limits, repairing ? crmRepairFill : crmFill) as JsonObject;
    if (filled.id === 'crm-dashboard-kpis' && Array.isArray(filled.items)) {
      const items = filled.items as (JsonObject | null)[];
      // First fill: an honest model finds no brief support for the label, and — same mistake as
      // emmpo-talents — leaves it empty instead of nulling the whole card. Repair: given the
      // narrowed TEMPLATE (this group unlocked, everything else locked to its own accepted
      // answer), the model corrects course and nulls the whole card, exactly like the unnarrowed
      // repair path always allowed — and, since it is trying REPAIR-* everywhere else too, would
      // overwrite the 1st/2nd cards' locked text if the lock did not hold.
      if (!repairing) (items[3] as JsonObject).label = '';
      else items[3] = null;
    }
    const text = JSON.stringify(filled);
    onDelta?.(text);
    return { text, usage: { input: 100, output: 50, cachedRead: 0 }, firstTokenMs: 1, ms: 2, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = [];
  const report = await runFastLane({ pkg, brief: 'Harbor Freight Co brokers freight across the Gulf Coast.', mode: 'sections', entry: 'crm-dashboard-r1.html', revision: 1, model: call, modelName: 'fake' });
  assert.deepEqual(report.missing, []);
  assert.equal(report.repairs, 1);
  assert.deepEqual(report.nulled, ['sections[0].items[3]']);
  assert.equal(getAtPath(report.recipe, ['sections', 0, 'items', 3]), null);
  // The 1st and 2nd KPI cards (required, never nullable) are untouched by this narrowing: they
  // keep the FIRST fill's "New label", not the repair's "REPAIR-label" — proof the lock held.
  assert.equal(getAtPath(report.recipe, ['sections', 0, 'items', 0, 'label']), 'New label');
  assert.equal(getAtPath(report.recipe, ['sections', 0, 'items', 1, 'label']), 'New label');
});

test("sections mode: an incomplete repair under a VARIABLE-LENGTH list (practice's services items, minItems 1 maxItems 3) falls back to the full, unnarrowed re-ask so the model may still drop the item, exactly as base allows", async () => {
  // Round-2 audit regression (Opus 5.5, proof/audits/emmpo-r2-opus55.md): the ARRAY MINIMA
  // convention tells the model it may drop items it has no brief facts for FROM THE END of a
  // variable-length list. When one slot of the LAST item comes back empty, a narrowed repair
  // locks that item's OTHER slots — and `mergeIntoSpine`'s trim guard (`hasLockedDescendant`)
  // refuses to drop a tail item that still holds any locked slot, on purpose (a locked slot means
  // a repair specifically kept it). That left "invent a fact for the empty slot" as the only way
  // to answer. Repro: practice/practice-services (min 1, max 3 items), `items[2].title` empty —
  // base 32f08a40cd recovers by dropping item 2 in one repair; narrowing (without this fallback)
  // fails it. The fix skips narrowing for any missing path under such a list, so the model keeps
  // the freedom to drop the item on repair, same as before this feature existed.
  const pkg = await loadFamilyPackage(defaultPackageDir('practice'), 'practice');
  // practice's contract validates several atom-kind fields by format, not just length — plain
  // "New <key>" text fails all of them.
  const practiceFill: Filler = (key, _value, at, limit) => {
    if (key === 'destination') return 'https://example.com/book';
    if (key === 'phone') return '555-0100';
    if (key === 'email') return 'front-desk@example.com';
    if (key === 'address') return '100 Main Street';
    if (key === 'name') return at.includes('items[1]') ? 'Dr. Alex Chen' : at.includes('items[2]') ? 'Dr. Morgan Lee' : 'Dr. Pat Rivera';
    if (key === 'title' && at.includes('items[')) return at.includes('items[0]') ? 'Intake assessment' : 'Family counselling';
    const itemIndex = at.match(/items\[(\d+)\]/)?.[1];
    const text = `New ${key}${itemIndex === undefined ? '' : ` ${itemIndex}`}`;
    return typeof limit === 'number' ? text.slice(0, limit) : text;
  };
  const call: ModelCall & { prompts: string[] } = (async ({ user, onDelta }) => {
    call.prompts.push(user);
    const template = promptBlock(user, 'TEMPLATE');
    const limits = promptBlock(user, 'LIMITS');
    const repairing = user.includes('\nYOUR PREVIOUS ANSWER WAS REJECTED\n');
    const filled = fillTemplate(template, limits, practiceFill) as JsonObject;
    if (filled.id === 'practice-services' && Array.isArray(filled.items)) {
      const items = filled.items as JsonObject[];
      if (!repairing) {
        // First fill: the brief supports only 2 services; an honest model should drop the 3rd,
        // but — same mistake as emmpo-talents — leaves its title empty instead.
        if (items[2]) items[2].title = '';
      } else {
        // Repair: given the FULL, unnarrowed template (this fix), the model corrects course and
        // drops the item the brief does not support, exactly as base's unnarrowed repair could.
        filled.items = items.slice(0, 2);
      }
    }
    const text = JSON.stringify(filled);
    onDelta?.(text);
    return { text, usage: { input: 100, output: 50, cachedRead: 0 }, firstTokenMs: 1, ms: 2, retries: 0 };
  }) as ModelCall & { prompts: string[] };
  call.prompts = [];
  const report = await runFastLane({ pkg, brief: 'A therapy practice offering two core services: intake assessment and family counselling.', mode: 'sections', entry: 'practice-r1.html', revision: 1, model: call, modelName: 'fake' });
  assert.deepEqual(report.missing, []);
  assert.equal(report.repairs, 1);
  const sections = (report.recipe as JsonObject).sections as JsonObject[];
  const services = sections.find((section) => section.id === 'practice-services') as JsonObject;
  assert.equal((services.items as unknown[]).length, 2);
});

test('sections mode repairs only the failing unit', async () => {
  const model = fakeModel({ firstAnswer: overflowHero });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.calls, 9);
  assert.equal(report.repairs, 1);
  assert.equal(report.units.filter((unit) => unit.repairs > 0).map((unit) => unit.label).join(), 'maben-hero');
});

test('an overrun that survives the repair budget is clipped at a word boundary and reported', async () => {
  const longStatement = Array.from({ length: 90 }, (_, index) => `word${index}`).join(' ');
  const model = fakeModel({ firstAnswer: overflowHero, fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? longStatement : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)) });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  // `runFastLane`'s default `maxRepairs` is 2 (raised from 1 after a live G8 build matrix run
  // found one technical repair attempt is not always enough headroom for an occasional model
  // flake — see the option's own docblock), so a fill that overruns on every attempt exhausts
  // both before falling through to the clip-to-limit path below.
  assert.equal(report.repairs, 2);
  assert.deepEqual(report.truncated, ['sections[2].text.statement']);
  const statement = getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string;
  assert.ok(statement.length <= 400 && statement.endsWith(statement.split(' ').at(-1)!) && !statement.endsWith(' '));
});

test('a refusal that clipping cannot fix stops the run, naming the unit and a fixed reason only', async () => {
  // The thrown error is printed by the CLI and, in 6b, becomes a daemon job failure, so it is as
  // public as the event stream. The message behind the refusal is not: a validator can quote the
  // value it rejected, and a faithfulness repair is built from the fabricated text itself. The
  // full detail still reaches `onCall`, which `--debug-dir` writes to disk.
  const rejected = 'We <b>fix</b> smiles';
  const model = fakeModel({ fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? rejected : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)) });
  const calls: Array<{ label: string; answer: string }> = [];
  await assert.rejects(
    runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', onCall: (call) => calls.push(call) }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(message, 'maben-hero: the family compiler refused the filled unit');
      assert.ok(!message.includes(rejected), 'the model\'s own text must not ride out on the error');
      assert.ok(!message.includes('markup is not allowed'), 'nor the validator\'s words about it');
      return true;
    },
  );
  assert.ok(calls.some((call) => call.answer.includes(rejected)), 'the raw answer is still available to a debug sink');
});

test('single mode matches answered sections by id, so a dropped or reordered section cannot shift the rest', async () => {
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      const sections = filled.sections as JsonObject[];
      // Drop the rail and put the footer first: every remaining section still lands on its own unit.
      filled.sections = [sections.at(-1)!, ...sections.slice(1, -1)];
      return filled;
    },
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 1, 'only the dropped rail is repaired');
  assert.equal(report.units.find((unit) => unit.label === 'maben-site-rail')?.repairs, 1);
  assert.ok((getAtPath(report.recipe, ['sections', 6, 'text', 'requestTitle']) as string).startsWith('New requestTitle'));
  assert.ok((getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string).startsWith('New statement'));
});

test('single mode keeps the sections that streamed cleanly when the page answer as a whole is malformed', async () => {
  const model = fakeModel({
    rawFirstAnswer: (text, template) => {
      if (!isObject(template) || !Array.isArray(template.sections)) return text;
      // Cut the page answer inside the fourth section and append junk: brand and three sections
      // close cleanly in the stream, the rest never arrive, and the whole text does not parse.
      const cut = text.indexOf('"id": "maben-how-we-work"') > 0 ? text.indexOf('"id": "maben-how-we-work"') : text.indexOf('"id":"maben-how-we-work"');
      return `${text.slice(0, cut + 40)} <<garbage`;
    },
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 4, 'the four units that never closed in the stream are repaired one by one');
  assert.equal(report.calls, 5);
  assert.deepEqual(report.missing, []);
  assert.ok(model.prompts[1]!.includes('page answer was not valid JSON'));
  assert.ok((getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string).startsWith('New statement'));
  assert.ok((getAtPath(report.recipe, ['sections', 6, 'text', 'requestTitle']) as string).startsWith('New requestTitle'));
});

test('the model is shown limits with headroom, not the hard schema limits', async () => {
  const model = fakeModel();
  await runFastLane({ pkg, brief: BRIEF, mode: 'single', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.ok(model.prompts[0]!.includes('"statement": 340'));
  assert.ok(!model.prompts[0]!.includes('"statement": 400'));
});

test('verify: jev flags a fabricated slot, repairUnit repairs it, and remaining ends empty', async () => {
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      const hero = Array.isArray(filled.sections)
        ? (filled.sections as JsonObject[]).find((section) => section.id === 'maben-hero')
        : filled.id === 'maben-hero' ? filled : undefined;
      if (hero) (hero.text as JsonObject).statement = 'Call FABRICATED-555-0100 for a free consult';
      return filled;
    },
  });
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.ok(report.verify);
  assert.equal(report.verify!.provider, 'jev');
  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement']);
  assert.equal(report.verify!.repaired, 1);
  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(verify.calls, 2, 'one check after fill, one recheck after repair');
  assert.ok(!(getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string).includes('FABRICATED'));
  const repairPrompt = model.prompts.at(-1)!;
  assert.ok(repairPrompt.includes('sections[2].text.statement'), 'repair prompt names the flagged path');
  assert.ok(repairPrompt.includes('states a fact the brief does not contain'), 'repair prompt states the rule');
  assert.ok(repairPrompt.includes('return null where NULLABLE names the value'), 'repair prompt points at null rather than a placeholder string, which would leak into the copy');
  assert.equal(verify.calls, 2, 'a clean recheck ends the loop after one round');
});

test('verify: a slot the model keeps fabricating after repair is reported as remaining', async () => {
  const model = fakeModel({
    fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)),
  });
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement']);
  assert.deepEqual(report.verify!.remaining, ['sections[2].text.statement']);
  assert.equal(report.verify!.repaired, 0);
  assert.equal(verify.calls, 3, 'one check after fill, then one recheck after each of the two repair rounds');
});

test('verify: a slot still flagged after the first repair round gets a second round and a fresh check', async () => {
  let statementCalls = 0;
  const model = fakeModel({
    fill: (key, _value, at, limit) => {
      if (at.endsWith('text.statement')) {
        statementCalls += 1;
        return statementCalls <= 2 ? `FABRICATED claim ${statementCalls}` : 'Same-day crowns and sedation options';
      }
      return typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`;
    },
  });
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify, strict: true });

  assert.equal(verify.calls, 3, 'fill check, recheck after round 1 (still flagged), recheck after round 2 (clean)');
  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement']);
  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(report.verify!.repaired, 1);
  assert.equal(report.strict!.passed, true);
  const repairPrompts = model.prompts.filter((prompt) => prompt.includes('states a fact the brief does not contain'));
  assert.equal(repairPrompts.length, 2);
  assert.ok(repairPrompts[1]!.includes('FABRICATED claim 2'), 'round 2 is built from the round-1 recheck, not the first check');
});

test('verify: faithfulness repair stops after two rounds, and strict fails with the slot unresolved', async () => {
  const model = fakeModel({
    fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)),
  });
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify, strict: true });

  assert.equal(verify.calls, 3);
  assert.equal(model.prompts.filter((prompt) => prompt.includes('states a fact the brief does not contain')).length, 2, 'no third round');
  assert.deepEqual(report.strict, { passed: false, reason: 'unresolved: sections[2].text.statement' });
});

test('verify: maxFaithfulnessRounds bounds the loop independently of maxRepairs', async () => {
  const model = fakeModel({
    fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)),
  });
  const verify = fakeJevChecker();
  await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify, maxRepairs: 3, maxFaithfulnessRounds: 1 });
  assert.equal(verify.calls, 2, 'one round, one recheck, whatever the technical budget');
});

test('verify: a faithfulness repair changes only the flagged slot; every other path of the unit stays locked', async () => {
  let repairing = false;
  const model = fakeModel({
    fill: (key, _value, at, limit) => {
      if (at.endsWith('text.statement')) return repairing ? 'Same-day crowns and sedation options' : 'FABRICATED claim';
      const text = repairing ? `CHANGED ${key}` : `New ${key}`;
      return typeof limit === 'number' ? text.slice(0, limit) : text;
    },
  });
  const verify: FaithfulnessChecker = {
    async checkFaithfulness({ slots }) {
      const flagged = slots.filter((slot) => slot.text.includes('FABRICATED')).map((slot) => ({ path: slot.path, probability: 0.95 }));
      repairing = flagged.length > 0;
      return { flagged, ms: 1, calls: 1 };
    },
  };
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'text', 'statement']), 'Same-day crowns and sedation options');
  assert.ok(!JSON.stringify(getAtPath(report.recipe, ['sections', 2])).includes('CHANGED'), 'unflagged slots in the repaired unit keep their text');
});

test('the faithfulness repair instruction asks for null, the brief\'s own words or no claim, never a substitute fact', () => {
  const text = faithfulnessRepairError([{ path: 'sections[4].text.price', text: '$49 per month' }]);
  assert.ok(text.includes('sections[4].text.price states a fact the brief does not contain: "$49 per month"'));
  assert.ok(text.includes('return null where NULLABLE names the value'));
  assert.ok(text.includes('delete the claim'));
  assert.ok(text.includes("the brief's own words"));
  // G8 dry run: a "neutral reword" of a claim sentence is still an untraced claim.
  assert.equal(/neutral wording|neutrally|Ask for pricing/.test(text), false);
  assert.ok(text.includes('Do not paraphrase a claim'));
  assert.ok(text.includes('Never replace it with a different number, date, time, price, amount, count, name, contact detail or quote'));
  assert.ok(!/rewrite it with only what the brief supports|plausible/i.test(text));
});

test('the faithfulness repair names the untraced words and quotes the brief\'s closest sentence', () => {
  const brief = 'Admission covers 34% of annual costs; members, the city and donations cover the rest.\nOpen Wednesday to Sunday.';
  const text = faithfulnessRepairError([{ path: 'sections[8].content.lede', text: 'Admission covers 34% of annual costs; the remainder is supported by donors.' }], brief);
  assert.ok(text.includes('the words not in the brief are: remainder, supported, donors.'), text);
  assert.ok(text.includes('"Admission covers 34% of annual costs; members, the city and donations cover the rest."'), text);
  assert.equal(text.includes('Open Wednesday to Sunday'), false, 'only the closest sentence is quoted');
});

test('withoutUntracedClaims keeps only the example sentences the brief supports', () => {
  const brief = 'Twelve of each piece a year.\n\nWhen a run closes it opens again the following year, if it opens at all.';
  assert.equal(withoutUntracedClaims(brief, 'The run size is set by what two people can finish between January and the end of summer. When a run closes it opens again the following year, if it opens at all.'), 'When a run closes it opens again the following year, if it opens at all.');
  assert.equal(withoutUntracedClaims(brief, 'Made by two people over forty years.'), '');
  assert.equal(withoutUntracedClaims(brief, 'A quiet studio.'), 'A quiet studio.', 'no claim, nothing removed');
});

test('the faithfulness repair names what makes a sentence a claim, so the model can drop it', () => {
  const brief = 'Materials, four things: freshwater pearl and silk thread.';
  const text = faithfulnessRepairError([{ path: 'sections[4].content.lede', text: 'Explore the four materials we work with.' }], brief);
  assert.ok(text.includes('(because of: four)'), text);
  assert.ok(text.includes('drop the claim words (four)'), text);
});

test('verify: no flags means no repair call and the page still publishes', async () => {
  const model = fakeModel();
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.deepEqual(report.verify!.flagged, []);
  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(report.verify!.repaired, 0);
  assert.equal(verify.calls, 1, 'no repair means no recheck call');
});

test('verify: a repair that itself fails validation does not fail the build (advisory end to end)', async () => {
  // The initial fill is plain text (valid, but flagged by jev): the fill step itself must
  // succeed, so the flag comes from verify, not from the ordinary fill-time repair path. The
  // verify-triggered repair then comes back with markup the family compiler refuses on every
  // attempt — repairUnit exhausts its budget and would normally throw. The flagged slot must
  // stay flagged (unfixed) in `remaining` without crashing the run; the page still publishes.
  let statementCalls = 0;
  const model = fakeModel({
    fill: (key, _value, at, limit) => {
      if (at.endsWith('text.statement')) {
        statementCalls += 1;
        return statementCalls === 1 ? 'FABRICATED phone 555-0100' : 'FABRICATED <b>call now</b>';
      }
      return typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`;
    },
  });
  const verify = fakeJevChecker();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement']);
  assert.deepEqual(report.verify!.remaining, ['sections[2].text.statement']);
  assert.equal(report.verify!.repaired, 0);
  assert.ok(report.html.length > 0, 'the build still completes and publishes');
  assert.equal(pkg.render(report.recipe, ENTRY).manifest.metadata.agencySite.recipeDigest, report.recipeDigest);
});

test('verify: a checker that fails is reported as skipped, and the page is still published (advisory)', async () => {
  const model = fakeModel();
  const verify: FaithfulnessChecker = { checkFaithfulness: async () => { throw new Error('fetch failed'); } };
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', verify });

  assert.ok(report.verify);
  assert.equal(report.verify!.skipped, 'fetch failed');
  assert.deepEqual(report.verify!.flagged, []);
  assert.deepEqual(report.verify!.remaining, []);
  assert.ok(report.html.includes('Riverbend Dental'), 'a skipped verify step does not block publishing');
});

test('without --verify, no verify step runs at all', async () => {
  const model = fakeModel();
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.verify, undefined);
});

test('verifyAfterPublish: publishes before the check runs, and the event order ends registered, preview, verify', async () => {
  const model = fakeModel({
    fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)),
  });
  const verify = fakeJevChecker(['FABRICATED']);
  const publisher = stubPublisher();
  const events: RunEvent[] = [];
  const report = await runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
    publisher, verify, verifyAfterPublish: true,
    onEvent: (event) => events.push(event),
  });

  const order = events.map((event) => event.type);
  const tail = order.slice(order.indexOf('registered'));
  assert.deepEqual(tail, ['registered', 'preview', 'verify'], `expected registered, preview, verify at the end, got ${order.join(', ')}`);

  const preview = events.find((event) => event.type === 'preview');
  assert.ok(preview && preview.type === 'preview');
  assert.equal(preview.url, `${publisher.projectId}/${ENTRY}`);

  // The flag is left exactly as filled — no in-run repair — because the page already published.
  assert.deepEqual(report.verify!.flagged, ['sections[2].text.statement']);
  assert.deepEqual(report.verify!.remaining, ['sections[2].text.statement']);
  assert.equal(report.verify!.repaired, 0);
  assert.equal(verify.calls, 1, 'one check, no recheck — verifyAfterPublish never repairs in-run');
  assert.ok((getAtPath(report.recipe, ['sections', 2, 'text', 'statement']) as string).includes('FABRICATED'), 'the flagged text is still on the published page, unlike advisory');
});

test('verifyAfterPublish: a dry run (no publisher) still gets a preview event, url falling back to the entry name', async () => {
  const model = fakeModel();
  const verify = fakeJevChecker(['FABRICATED']);
  const events: RunEvent[] = [];
  const report = await runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
    verify, verifyAfterPublish: true,
    onEvent: (event) => events.push(event),
  });

  assert.equal(events.some((event) => event.type === 'registered'), false, 'no publisher, no registered event');
  const preview = events.find((event) => event.type === 'preview');
  assert.ok(preview && preview.type === 'preview');
  assert.equal(preview.url, ENTRY);
  assert.equal(events.at(-1)!.type, 'verify', 'verify still runs and is still the last event');
  assert.deepEqual(report.verify!.flagged, []);
});

test('verifyAfterPublish: a checker failure is folded into verify.skipped, never thrown — the page already published', async () => {
  const model = fakeModel();
  const verify: FaithfulnessChecker = { checkFaithfulness: async () => { throw new Error('fetch failed'); } };
  const publisher = stubPublisher();
  const report = await runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
    publisher, verify, verifyAfterPublish: true,
  });

  assert.equal(report.verify!.skipped, 'fetch failed');
  assert.deepEqual(report.verify!.flagged, []);
  assert.ok(report.timings.registeredMs !== undefined, 'publish already completed before the failed check');
});

test('verifyAfterPublish: a cancellation while the deferred check is in flight is reported as verify.skipped (cancelled), and the run still completes', async () => {
  // `POST /api/agency/builds/:id/cancel` is a no-op once this check has started (see that route's
  // doc comment): the page has already published, so there is nothing to roll back, and the run
  // must still resolve normally rather than throw. This checker never resolves on its own — it
  // only settles when `controller` aborts, so the run genuinely has to be cancelled mid-check for
  // this test to reach a result at all.
  const model = fakeModel();
  const controller = new AbortController();
  let checkStarted = false;
  const verify: FaithfulnessChecker = {
    checkFaithfulness: () => new Promise((_resolve, reject) => {
      checkStarted = true;
      // The abort below fires synchronously from the `preview` event handler, before this promise
      // is even constructed reaches its `await` — so `signal.aborted` is already `true` by the
      // time this runs, and an `abort` listener added now would never fire. Same rule
      // `tests/jev.test.ts`'s cancellation case and `createJevChecker` itself follow.
      if (controller.signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  };
  const publisher = stubPublisher();
  const events: RunEvent[] = [];
  const report = await runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
    publisher, verify, verifyAfterPublish: true, signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      // Abort exactly once the page has published — the deferred check is the only thing left.
      if (event.type === 'preview') controller.abort();
    },
  });

  assert.ok(checkStarted, 'the deferred check actually started before the cancellation');
  assert.equal(report.verify!.skipped, 'the run was cancelled while the deferred check was still running');
  assert.deepEqual(report.verify!.flagged, []);
  assert.ok(report.timings.registeredMs !== undefined, 'the page had already published — cancellation does not undo that');
  assert.equal(events.at(-1)!.type, 'verify', 'the run still reports a verify event, not a thrown cancellation');
});

test('a spine from an earlier build is re-targeted with the new revision and untouched assets', async () => {
  const previous = structuredClone(pkg.fixture);
  previous.revision = 1;
  const model = fakeModel();
  const report = await runFastLane({ pkg, brief: 'Greenline Landscaping, Denver.', mode: 'single', entry: 'maben-r2.html', revision: 2, model, modelName: 'fake', spine: previous });
  assert.equal(getAtPath(report.recipe, ['revision']), 2);
  assert.equal(report.manifest.metadata.agencySite.revision, 'maben-r2');
  assert.ok(report.approvedAssets.every((asset) => asset.destination.startsWith('assets/agency-site/maben-r2/')));
});

type DaemonRequest = { method: string; url: string; body: JsonObject };

/** A real HTTP daemon stub, so a strict test proves nothing (or exactly the deferred sequence) was
 * actually sent over the wire — not just that a fake publisher's callbacks were not invoked.
 * `forceStatus`, when given, picks the response status for one request from what it has seen so
 * far (including itself); every other request answers 200, so a test can fail exactly one save
 * (e.g. the page save) without needing to fail the whole daemon. */
async function stubDaemon(forceStatus?: (request: DaemonRequest) => number | undefined): Promise<{ server: Server; url: string; requests: DaemonRequest[] }> {
  const requests: DaemonRequest[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const entry: DaemonRequest = { method: request.method ?? '', url: request.url ?? '', body: raw ? (JSON.parse(raw) as JsonObject) : {} };
      requests.push(entry);
      const status = forceStatus?.(entry) ?? 200;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 200 ? '{"ok":true}' : '{"error":{"code":"FORCED_FAILURE"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

/** Builds a run's `ensurePublisher`: creates (or, with `projectId`, reuses) a project on `daemon`
 * through the real HTTP client, exactly as the CLI does. */
function ensurePublisherFor(daemonUrl: string, name: string, projectId?: string) {
  const created = !projectId;
  return async () => ({ publisher: projectPublisher({ daemonUrl, projectId: await ensureProject({ daemonUrl, name, projectId }) }), created });
}

test('strict: a flag that survives repair fails closed — the daemon sees nothing, and the report says why', async () => {
  const model = fakeModel({
    fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)),
  });
  const verify = fakeJevChecker();
  const daemon = await stubDaemon();
  try {
    const report = await runFastLane({
      pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
      verify, strict: true,
      ensurePublisher: ensurePublisherFor(daemon.url, 'x'),
    });

    assert.deepEqual(report.strict, { passed: false, reason: 'unresolved: sections[2].text.statement' });
    assert.equal(report.projectId, undefined, 'no project was ever created');
    assert.equal(report.timings.registeredMs, undefined);
    assert.equal(daemon.requests.length, 0, 'the daemon received zero requests');
  } finally {
    daemon.server.close();
  }
});

test('strict: a skipped check (network failure) fails closed, same as a real flag', async () => {
  const model = fakeModel();
  const verify: FaithfulnessChecker = { checkFaithfulness: async () => { throw new Error('fetch failed'); } };
  const daemon = await stubDaemon();
  try {
    const report = await runFastLane({
      pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
      verify, strict: true,
      ensurePublisher: ensurePublisherFor(daemon.url, 'x'),
    });

    assert.equal(report.verify!.skipped, 'fetch failed');
    assert.deepEqual(report.strict, { passed: false, reason: 'verify was skipped: fetch failed' });
    assert.equal(daemon.requests.length, 0);
  } finally {
    daemon.server.close();
  }
});

test('strict: a slot left unchecked as oversized fails closed even with zero flags', async () => {
  const model = fakeModel();
  const verify: FaithfulnessChecker = { checkFaithfulness: async () => ({ flagged: [], ms: 1, calls: 1, oversized: ['sections[2].text.statement'] }) };
  const daemon = await stubDaemon();
  try {
    const report = await runFastLane({
      pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
      verify, strict: true,
      ensurePublisher: ensurePublisherFor(daemon.url, 'x'),
    });

    assert.deepEqual(report.verify!.oversized, ['sections[2].text.statement']);
    assert.deepEqual(report.verify!.remaining, [], 'oversized, not a repaired flag, is what fails this run');
    assert.deepEqual(report.strict, { passed: false, reason: 'too large to check: sections[2].text.statement' });
    assert.equal(daemon.requests.length, 0);
  } finally {
    daemon.server.close();
  }
});

test('strict: a clean pass defers everything — one create, assets, one page save, then the state files', async () => {
  const model = fakeModel();
  const verify = fakeJevChecker();
  const daemon = await stubDaemon();
  try {
    const events: RunEvent[] = [];
    const report = await runFastLane({
      pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
      verify, strict: true,
      ensurePublisher: ensurePublisherFor(daemon.url, 'Riverbend Dental'),
      onEvent: (event) => events.push(event),
    });

    assert.equal(report.strict!.passed, true);
    assert.equal(report.strict!.checked, report.verify!.checked, 'a strict pass states how many slots verify actually checked');
    assert.ok(report.strict!.checked! > 0, 'this run has real editable text, so checked is not the 0-slots-locked case');
    assert.deepEqual(report.verify!.remaining, []);
    assert.ok(report.projectId, 'the deferred project id is reported');
    assert.ok(report.timings.registeredMs !== undefined);

    assert.equal(daemon.requests[0]!.url, '/api/projects', 'the project is created first, only after the gate passed');
    const fileRequests = daemon.requests.slice(1);
    const nameOf = (request: { body: JsonObject }) => (typeof request.body.name === 'string' ? request.body.name : undefined);
    const destinationAssetSaves = fileRequests.filter((request) => nameOf(request)?.startsWith('assets/agency-site/maben-r1/'));
    assert.equal(destinationAssetSaves.length, 17, 'every approved asset is uploaded');
    const pageSaves = fileRequests.filter((request) => nameOf(request) === ENTRY);
    assert.equal(pageSaves.length, 1, 'the final page is saved exactly once, never once per unit');
    const lastAssetIndex = Math.max(...destinationAssetSaves.map((save) => fileRequests.indexOf(save)));
    const pageIndex = fileRequests.indexOf(pageSaves[0]!);
    assert.ok(lastAssetIndex < pageIndex, 'assets are uploaded before the page is saved');
    for (const expected of ['agency-site-state/r1/recipe.json', 'agency-site-state/r1/approved-assets.json', 'AGENCY-SITE-STATE.md', 'agency-site-state/r1/assets/hero-frame.png']) {
      assert.ok(fileRequests.some((request) => nameOf(request) === expected), expected);
    }
    assert.equal(daemon.requests.length, 1 + 17 + 1 + 3 + 17, 'create, destination assets, one page, three state files, state-dir asset copies');

    // Strict never counts the fill step's own in-memory renders as paints (unlike a plain
    // dry-run's "single mode paints progressively" test): the report's `paints`, `firstPaintMs`
    // and `finalPaintMs` describe the daemon, not the in-memory fill, so they must reflect
    // exactly the one deferred save above.
    assert.equal(report.paints, 1, 'only the deferred save counts as a paint in a strict report');
    const paintEvents = events.filter((event) => event.type === 'paint');
    assert.equal(paintEvents.length, 1, 'no paint event fires for the in-memory fill in strict mode');
    assert.equal(paintEvents[0]?.label, 'registered');
    assert.ok(report.timings.firstPaintMs !== undefined && report.timings.finalPaintMs !== undefined);
    assert.equal(report.timings.firstPaintMs, report.timings.finalPaintMs, 'one save means first and final paint coincide');
    assert.ok(events.some((event) => event.type === 'registered'));
  } finally {
    daemon.server.close();
  }
});

test('strict + dry-run (no ensurePublisher): the same pass/fail decision, but nothing is ever published', async () => {
  const passReport = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: fakeModel(), modelName: 'fake', verify: fakeJevChecker(), strict: true });
  assert.equal(passReport.strict!.passed, true);
  assert.equal(passReport.strict!.checked, passReport.verify!.checked);
  assert.equal(passReport.projectId, undefined);
  assert.equal(passReport.timings.registeredMs, undefined);
  assert.equal(passReport.timings.assetsMs, undefined);
  // No save ever reaches a daemon here (there is none), so a dry-run strict report must not claim
  // a paint happened: paints stays 0 and the paint timings stay unset, never a stray in-memory
  // fill number.
  assert.equal(passReport.paints, 0, 'no save reached a daemon, so nothing was painted');
  assert.equal(passReport.timings.firstPaintMs, undefined);
  assert.equal(passReport.timings.finalPaintMs, undefined);

  const failModel = fakeModel({ fill: (key, _value, at, limit) => (at.endsWith('text.statement') ? 'FABRICATED phone 555-0100' : (typeof limit === 'number' ? `New ${key}`.slice(0, limit) : `New ${key}`)) });
  const failReport = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model: failModel, modelName: 'fake', verify: fakeJevChecker(), strict: true });
  assert.deepEqual(failReport.strict, { passed: false, reason: 'unresolved: sections[2].text.statement' });
  assert.equal(failReport.paints, 0);
  assert.equal(failReport.timings.firstPaintMs, undefined);
  assert.equal(failReport.timings.finalPaintMs, undefined);
});

test('strict: every editable path either locked or left null checks 0 slots and still passes, explicitly', async () => {
  const watsonPkg = await loadFamilyPackage(WATSON_DIR, 'watson');
  const NULLABLE_ATOMS = ['location', 'city', 'awardCaption', 'locations', 'campaigns', 'businessEmail', 'jobsEmail', 'addressFirst', 'addressSecond', 'phone'];
  const nullingFill: Filler = (key, _value, _at, limit) => (NULLABLE_ATOMS.includes(key) ? null : `New ${key} for Taproot`.slice(0, limit));

  // Every leaf outside the nullable atoms is locked; the nullable atoms are left editable and the
  // model answers every one of them null. What remains for `collectFaithfulnessSlots` to see is
  // nothing: every locked leaf is excluded by `lockPaths`, and a null leaf carries no text to
  // check in the first place.
  const templateForPaths = editableTemplate(watsonPkg.fixture, undefined, new Set());
  const atomKinds = atomKindsFor(watsonPkg.schema, templateForPaths as Json);
  const nullablePaths = nullablePathsOf(atomKinds);
  const leaves = (function walk(node: Json, at = ''): string[] {
    if (typeof node === 'string' || node === null) return [at];
    if (Array.isArray(node)) return node.flatMap((item, index) => walk(item, `${at}[${index}]`));
    if (isObject(node)) return Object.entries(node).flatMap(([key, child]) => walk(child, at ? `${at}.${key}` : key));
    return [];
  })(templateForPaths as Json);
  const lockPaths = leaves.filter((leaf) => !nullablePaths.has(leaf) && !(leaf === 'id' || leaf.endsWith('.id')));

  const model = fakeModel({ fill: nullingFill });
  const verify = fakeJevChecker();
  const report = await runFastLane({
    pkg: watsonPkg, brief: 'Taproot, a two-person design studio.', mode: 'sections', entry: 'watson-r1.html', revision: 1, model, modelName: 'fake',
    lockPaths, verify, strict: true,
  });

  assert.ok(report.calls > 0, 'units with only a locked/nullable body still make a fill call');
  assert.equal(report.repairs, 0);
  assert.equal(report.verify!.checked, 0);
  assert.deepEqual(report.verify!.flagged, []);
  assert.deepEqual(report.verify!.remaining, []);
  assert.equal(report.verify!.repaired, 0);
  assert.deepEqual(report.strict, { passed: true, checked: 0 });
});

/** Forces the daemon to refuse the deferred page save (the `POST .../files` request whose body
 * names the entry file), after everything up to that point has already succeeded. */
const forcePageSaveFailure = (request: DaemonRequest): number | undefined =>
  (request.method === 'POST' && request.url.endsWith('/files') && request.body.name === ENTRY ? 500 : undefined);

test('strict: a publish failure after this run created the project deletes it and says so', async () => {
  const model = fakeModel();
  const verify = fakeJevChecker();
  const daemon = await stubDaemon(forcePageSaveFailure);
  try {
    await assert.rejects(
      runFastLane({
        pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
        verify, strict: true,
        ensurePublisher: ensurePublisherFor(daemon.url, 'x'),
      }),
      /strict publish failed after creating project [0-9a-f-]+; the new project was removed: daemon 500 on /,
    );
    const created = daemon.requests.find((request) => request.url === '/api/projects');
    assert.ok(created, 'the project was created before the failure');
    const deletes = daemon.requests.filter((request) => request.method === 'DELETE');
    assert.equal(deletes.length, 1, 'exactly one delete was sent');
    assert.equal(deletes[0]!.url, `/api/projects/${created!.body.id}`, 'the deleted id is the one this run created');
  } finally {
    daemon.server.close();
  }
});

test('strict: a publish failure on a --project id this run reused is never deleted', async () => {
  const model = fakeModel();
  const verify = fakeJevChecker();
  const daemon = await stubDaemon(forcePageSaveFailure);
  try {
    await assert.rejects(
      runFastLane({
        pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
        verify, strict: true,
        ensurePublisher: ensurePublisherFor(daemon.url, 'x', 'given-project'),
      }),
      /strict publish failed on project given-project; it may hold a partial file set: daemon 500 on /,
    );
    assert.equal(daemon.requests.some((request) => request.url === '/api/projects'), false, 'a given --project id is never created');
    assert.equal(daemon.requests.some((request) => request.method === 'DELETE'), false, 'a caller-supplied project is never deleted');
  } finally {
    daemon.server.close();
  }
});

test('a repair event carries the unit and a fixed reason, never the text the model wrote', async () => {
  // `repair` is part of the run's public event union, which `buildSite` widens into `BuildEvent`
  // and 6b streams out of the daemon. The message behind a repair quotes whatever refused the
  // unit — for a faithfulness repair, the fabricated slot text itself — so the event may only
  // carry a classification. The full message still reaches an operator two ways: it is what a
  // failing run throws, and `onCall` still dumps the whole prompt and answer.
  const secret = 'FABRICATED-555-0100';
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits) as JsonObject;
      const hero = Array.isArray(filled.sections)
        ? (filled.sections as JsonObject[]).find((section) => section.id === 'maben-hero')
        : filled.id === 'maben-hero' ? filled : undefined;
      if (hero) (hero.text as JsonObject).statement = `Call ${secret} for a free consult`;
      return filled;
    },
  });
  const events: RunEvent[] = [];
  await runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake',
    verify: fakeJevChecker(), onEvent: (event) => events.push(event),
  });

  const repairs = events.filter((event) => event.type === 'repair');
  assert.equal(repairs.length, 1, 'the flagged unit was repaired once');
  assert.equal(repairs[0]!.label, 'maben-hero');
  assert.equal(repairs[0]!.reason, 'unfaithful');
  const serialised = JSON.stringify(events);
  assert.ok(!serialised.includes(secret), 'a generated fact leaked into the event stream');
  assert.ok(!serialised.includes('states a fact the brief does not contain'), 'the repair prompt leaked into the event stream');
});

test('a spent repair budget throws structured detail that never carries the refused value', () => {
  assert.deepEqual(refusalDetail('sections[8].text.phone: expected a phone number'), { slot: 'sections[8].text.phone', rule: 'expected a phone number' });
  assert.deepEqual(refusalDetail('sections[1].text.body: at most 200 characters, received 201'), { slot: 'sections[1].text.body', rule: 'at most 200 characters, received 201' });
  // A message that quotes what it refused keeps the path and drops the rule.
  assert.deepEqual(refusalDetail('brand.name: "Anchorline Legal Partners" is not allowed'), { slot: 'brand.name' });
  assert.deepEqual(refusalDetail('Unexpected token } in JSON at position 12'), {});
  const error = new UnitRefusedError('listings-inquiry', { reason: 'invalid', error: 'sections[8].text.phone: expected a phone number' });
  assert.equal(error.message, 'listings-inquiry: the family compiler refused the filled unit');
  assert.equal(error.unit, 'listings-inquiry');
  assert.equal(error.reason, 'invalid');
  assert.equal(error.slot, 'sections[8].text.phone');
  assert.equal(error.rule, 'expected a phone number');
  // A malformed answer's parse error is raw model text: no detail at all.
  const malformed = new UnitRefusedError('hero', { reason: 'malformed', error: 'hero.title: {"title": "..."}' });
  assert.equal(malformed.slot, undefined);
  assert.equal(malformed.rule, undefined);
});

// ---------------------------------------------------------------------------------------------
// withAdapterDeterministicGates: a round-9 audit pass (storefront-r5-grok.md NOTE — "Optional
// section-overlay fills call Jev only … and never the deterministic gates") found both
// `fillSectionAdapter` callers (the section-overlay fill in `runFastLane`, and the composed
// Cult-block page in `block-compose.ts`) pass the RAW `FaithfulnessChecker` straight through, so
// none of `makeCheckOnce`'s deterministic claim/commercial-word gates ever saw an overlay or
// composed-page fill. This wrapper is the fix; these tests exercise it directly, independent of
// the two call sites' own wiring.
// ---------------------------------------------------------------------------------------------

test('withAdapterDeterministicGates: an invented price the raw checker missed is caught once wrapped', async () => {
  const raw: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [], ms: 1, calls: 1 }; } };
  const gated = withAdapterDeterministicGates(raw, 'storefront');
  const result = await gated.checkFaithfulness({ brief: 'The Field Jacket is $248.', slots: [{ path: 'text.price', text: 'Now just $15.' }] });
  assert.deepEqual(result.flagged, [{ path: 'text.price', probability: 1 }], 'an unstated $15 price must be flagged even though the raw checker never flagged it');
});

// A round-10 audit pass (storefront-r6-grok.md BLOCK 3) found `deterministicCommercialWordFlags`
// scoped to `COMMERCIAL_WORD_FAMILIES` here meant the composed Cult-block page (`family` for this
// purpose is always `COMPOSED_FAMILY`, 'composed', never in that storefront-only allowlist) could
// still publish "Free shipping.", "Sold out." or "Lifetime warranty." whenever Jev itself missed
// it. This test is the one the audit named directly (run.test.ts:810): it used to assert the
// OPPOSITE — that a non-storefront family was left unchecked — locking the gap in as intended
// behavior. It now asserts every family gets the same commercial-word gate.
test('withAdapterDeterministicGates: a commercial-word claim ("Free shipping", "Sold out.", "Lifetime warranty.") is caught for EVERY family, not just storefront', async () => {
  const raw: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [], ms: 1, calls: 1 }; } };
  const brief = 'The Field Jacket is $248.';
  const slots = [
    { path: 'text.cta', text: 'Free shipping today.' },
    { path: 'text.availability', text: 'Sold out.' },
    { path: 'text.warranty', text: 'Lifetime warranty.' },
  ];
  const storefrontGated = withAdapterDeterministicGates(raw, 'storefront');
  const composedGated = withAdapterDeterministicGates(raw, 'composed');
  const storefrontResult = await storefrontGated.checkFaithfulness({ brief, slots });
  const composedResult = await composedGated.checkFaithfulness({ brief, slots });
  const expected = new Set(['text.cta', 'text.availability', 'text.warranty']);
  assert.deepEqual(new Set(storefrontResult.flagged.map((f) => f.path)), expected, 'storefront must gate every unstated commercial claim');
  assert.deepEqual(new Set(composedResult.flagged.map((f) => f.path)), expected, `a composed page must gate the SAME unstated commercial claims — no family is exempt any more; got ${JSON.stringify(composedResult.flagged)}`);
});

test('withAdapterDeterministicGates: never drops a flag the wrapped checker itself raised, and never masks a skip', async () => {
  const raw: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [{ path: 'text.heading', probability: 0.4 }], ms: 1, calls: 1, skipped: 'network timeout' }; } };
  const gated = withAdapterDeterministicGates(raw, 'storefront');
  const result = await gated.checkFaithfulness({ brief: 'A jacket brand.', slots: [{ path: 'text.heading', text: 'A jacket brand for everyone.' }] });
  assert.ok(result.flagged.some((f) => f.path === 'text.heading' && f.probability === 0.4), 'the wrapped checker\'s own flag must survive the merge');
  assert.equal(result.skipped, 'network timeout', 'a skip the wrapped checker reported must pass through unchanged');
});

test('withAdapterDeterministicGates: an honest fill matching the brief passes cleanly', async () => {
  const raw: FaithfulnessChecker = { async checkFaithfulness() { return { flagged: [], ms: 1, calls: 1 }; } };
  const gated = withAdapterDeterministicGates(raw, 'storefront');
  const result = await gated.checkFaithfulness({ brief: 'The Field Jacket is $248, made in Portland.', slots: [{ path: 'text.price', text: 'Just $248.' }, { path: 'text.body', text: 'Made in Portland.' }] });
  assert.deepEqual(result.flagged, [], 'text that matches the brief must not be flagged');
});

// A round-10 audit pass (FIX 4) found deterministic flags computed AFTER `checker.checkFaithfulness`
// resolved were dropped entirely when that call threw: the whole wrapped promise rejected with the
// raw error, the same failure mode `makeCheckOnce` already guards against. These two tests prove
// the fix: a thrown (non-cancellation) error still reports the deterministic flags, as a skip
// rather than a throw; a genuine cancellation still propagates, unmasked.
test('withAdapterDeterministicGates: (round 10 FIX 4) a thrown checker error still reports the deterministic flags, as a skip rather than dropping them', async () => {
  const raw: FaithfulnessChecker = { async checkFaithfulness() { throw new Error('jev 500 upstream error'); } };
  const gated = withAdapterDeterministicGates(raw, 'storefront');
  const result = await gated.checkFaithfulness({ brief: 'The Field Jacket is $248.', slots: [{ path: 'text.price', text: 'Now just $15.' }] });
  assert.deepEqual(result.flagged, [{ path: 'text.price', probability: 1 }], 'the deterministic price flag must survive a thrown checker error, not be dropped by an unhandled rejection');
  assert.equal(result.skipped, 'jev 500 upstream error');
});

test('withAdapterDeterministicGates: (round 10 FIX 4) a genuine cancellation still propagates, not folded into a skip', async () => {
  const controller = new AbortController();
  const raw: FaithfulnessChecker = { async checkFaithfulness() { controller.abort(); const error = new Error('aborted'); error.name = 'AbortError'; throw error; } };
  const gated = withAdapterDeterministicGates(raw, 'storefront', controller.signal);
  await assert.rejects(
    () => gated.checkFaithfulness({ brief: 'The Field Jacket is $248.', slots: [{ path: 'text.price', text: 'Now just $15.' }] }),
    /aborted/,
  );
});
