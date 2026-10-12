// An agency build's events, as AG-UI spec events (`RUN_STARTED`, `STEP_*`, `STATE_SNAPSHOT`,
// `STATE_DELTA` as RFC 6902, `CUSTOM`, `RUN_FINISHED` / `RUN_ERROR`).
//
// Pure: no I/O, no clock unless one is passed in. The daemon's `GET /api/agency/builds/:id/agui`
// drives it with the build's own public DTOs (`AgencyBuildEvent`, `AgencyBuildSnapshot`), so the
// frames can carry nothing those do not — in particular never the brief, only its length.
//
// Three rules the frames keep, all from the spec:
// - `RUN_STARTED` comes first and nothing follows `RUN_FINISHED` or `RUN_ERROR`;
// - every `STEP_FINISHED` names the step its `STEP_STARTED` opened, and at most one step is open;
// - a `STATE_DELTA` applies to the state the previous `STATE_SNAPSHOT` and deltas built.
//
// The shared state is advanced ONLY by applying the deltas this module emits, so a resume's
// `foldAgencyBuildState` and a live client's snapshot-plus-deltas cannot drift apart.

import type {
  AgencyBuildAguiInput,
  AgencyBuildAguiState,
  AgencyBuildAguiStepName,
  AgencyBuildAguiUnit,
  AgencyBuildEvent,
  AgencyBuildSnapshot,
  AgencyBuildStatus,
  AgencyOutputScope,
} from '@mish/contracts';
import type { AguiEvent, JsonPatchOp } from './spec-types.js';

/** `CUSTOM.name` of the frame that carries each build event unchanged. Mirrors the contract's
 * `AGENCY_BUILD_AGUI_EVENT_NAME`; repeated as a literal so this package needs no runtime import. */
export const AGENCY_BUILD_EVENT_CUSTOM_NAME = 'od.agency-build.event';

/** What a stream needs to know about a build besides its events. Never the brief itself. */
export interface AgencyBuildAguiMeta {
  buildId: string;
  startedAt: string;
  input: AgencyBuildAguiInput;
  /** The family's output scope when the family is already known (a named-family build). An `auto`
   * build learns it from its `route` event instead. */
  outputScope?: AgencyOutputScope | null;
}

/** Where an encoding is: the state so far, and the step bookkeeping the spec rules need. */
export interface AgencyBuildAguiCursor {
  meta: AgencyBuildAguiMeta;
  state: AgencyBuildAguiState;
  openStep: AgencyBuildAguiStepName | null;
  /** Steps finished so far, in order. A resume replays them as start/finish pairs. */
  stepsDone: AgencyBuildAguiStepName[];
  /** Whether a `preview` event has been seen: a `verify` after it opens a second verify step. */
  sawPreview: boolean;
  /** Set once the terminal frames are out; nothing is emitted after that. */
  ended: boolean;
}

export type AgencyBuildAguiSource =
  /** The stream opens; `replayed` are the events the client already has (a resume), folded into
   * the snapshot rather than sent again. */
  | { kind: 'start'; meta: AgencyBuildAguiMeta; replayed?: readonly AgencyBuildEvent[] }
  | { kind: 'event'; event: AgencyBuildEvent }
  /** The build ended. `input` replaces what the stream opened with (a provider resolved at the
   * end, for example) when given. */
  | { kind: 'end'; snapshot: AgencyBuildSnapshot; input?: AgencyBuildAguiInput };

export interface AgencyBuildAguiEncoded {
  events: AguiEvent<AgencyBuildAguiState>[];
  cursor: AgencyBuildAguiCursor;
}

const STEP_RANK: Record<AgencyBuildAguiStepName, number> = { route: 0, fill: 1, verify: 2, publish: 3, deploy: 4 };

/** The running phases, as the daemon orders them. Mirrored from `routes/agency-build.ts`. */
const PHASE_ORDER: AgencyBuildStatus[] = ['queued', 'routing', 'building', 'verifying', 'publishing'];

/** The phase an event proves, as the daemon's `phaseOf` decides it, so `state.build.status`
 * matches what `GET /api/agency/builds/:id` reports at the same event. */
function phaseOf(event: AgencyBuildEvent): AgencyBuildStatus | undefined {
  switch (event.type) {
    case 'lock-wait': return undefined;
    case 'verify': return 'verifying';
    case 'project':
    case 'assets':
    case 'registered':
    case 'preview': return 'publishing';
    default: return 'building';
  }
}

function advance(current: AgencyBuildStatus, next: AgencyBuildStatus | undefined): AgencyBuildStatus {
  if (next === undefined || !PHASE_ORDER.includes(current)) return current;
  return PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current) ? next : current;
}

/** Escapes one JSON Pointer reference token (RFC 6901): `~` then `/`. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function applyOne(target: unknown, tokens: string[], op: JsonPatchOp): unknown {
  if (tokens.length === 0) {
    if (op.op === 'remove') throw new Error('cannot remove the document root');
    return clone(op.value);
  }
  const [head, ...rest] = tokens as [string, ...string[]];
  if (Array.isArray(target)) {
    const copy = [...target];
    const last = rest.length === 0;
    const index = head === '-' ? copy.length : Number(head);
    if (!Number.isInteger(index) || index < 0 || index > copy.length) throw new Error(`bad array index ${head}`);
    if (last) {
      if (op.op === 'add') copy.splice(index, 0, clone(op.value));
      else if (index >= copy.length) throw new Error(`no array element ${head}`);
      else if (op.op === 'replace') copy[index] = clone(op.value);
      else copy.splice(index, 1);
      return copy;
    }
    if (index >= copy.length) throw new Error(`no array element ${head}`);
    copy[index] = applyOne(copy[index], rest, op);
    return copy;
  }
  if (!isRecord(target)) throw new Error(`path runs through a non-container at ${head}`);
  const copy: Record<string, unknown> = { ...target };
  if (rest.length === 0) {
    if (op.op !== 'add' && !(head in copy)) throw new Error(`no member ${head}`);
    if (op.op === 'remove') delete copy[head];
    else copy[head] = clone(op.value);
    return copy;
  }
  if (!(head in copy)) throw new Error(`no member ${head}`);
  copy[head] = applyOne(copy[head], rest, op);
  return copy;
}

/**
 * Applies RFC 6902 `add` / `replace` / `remove` operations and returns a new document. The input
 * is never mutated. Throws on a path that does not resolve, as the RFC requires.
 */
export function applyJsonPatch<T>(document: T, ops: readonly JsonPatchOp[]): T {
  let result: unknown = document;
  for (const op of ops) {
    if (op.path !== '' && !op.path.startsWith('/')) throw new Error(`bad JSON Pointer ${op.path}`);
    const tokens = op.path === '' ? [] : op.path.slice(1).split('/').map(unescapePointerToken);
    result = applyOne(result, tokens, op);
  }
  return result as T;
}

/** The state a stream starts from, before any event. */
export function initialAgencyBuildState(meta: AgencyBuildAguiMeta): AgencyBuildAguiState {
  return {
    // A stream only exists once the build has been accepted, and the daemon moves a build to
    // `routing` in the same turn it answers 202 — so `routing` is the status before any event.
    build: { id: meta.buildId, status: 'routing', startedAt: meta.startedAt, finishedAt: null },
    input: { ...meta.input },
    route: null,
    outputScope: meta.outputScope ?? null,
    projectId: null,
    units: {},
    paints: 0,
    repairs: [],
    clipped: [],
    sections: null,
    verify: null,
    verdict: null,
    previewUrl: null,
    timings: {},
    error: null,
    failure: null,
    summary: null,
    renderQuality: null,
    providers: [],
    composition: null,
    effects: null,
  };
}

/** A cursor at the very start of a build. An `auto` build opens the `route` step at once. */
export function createAgencyBuildCursor(meta: AgencyBuildAguiMeta): AgencyBuildAguiCursor {
  return {
    meta,
    state: initialAgencyBuildState(meta),
    openStep: meta.input.family === 'auto' ? 'route' : null,
    stepsDone: [],
    sawPreview: false,
    ended: false,
  };
}

/** The step an event asks for, or null when it changes no step. */
function targetStep(event: AgencyBuildEvent, cursor: AgencyBuildAguiCursor): AgencyBuildAguiStepName | null {
  switch (event.type) {
    case 'first-token':
    case 'unit':
    case 'merged':
    case 'paint':
    case 'repair':
    case 'clipped':
      return 'fill';
    case 'verify':
      return 'verify';
    case 'registered':
      return 'publish';
    case 'project': {
      // An advisory build creates its project before the first model call, where it does not
      // mean publishing has started; a strict build creates it only once the gate passed. Same
      // rule as the daemon's max-phase `phaseOf`: it is a publish only after the fill began.
      const filled = cursor.openStep === 'fill' || cursor.openStep === 'verify' || cursor.stepsDone.includes('fill');
      return filled ? 'publish' : null;
    }
    default:
      // `route` closes its own step; `assets`, `preview` and `lock-wait` change none. Assets
      // upload alongside the fill on a non-strict build, so they prove no step on their own.
      return null;
  }
}

function maxRank(cursor: AgencyBuildAguiCursor): number {
  const ranks = cursor.stepsDone.map((step) => STEP_RANK[step]);
  if (cursor.openStep) ranks.push(STEP_RANK[cursor.openStep]);
  return ranks.length === 0 ? -1 : Math.max(...ranks);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The patch one event makes to the state. Built from the current state, never mutating it. */
function deltaFor(event: AgencyBuildEvent, cursor: AgencyBuildAguiCursor): JsonPatchOp[] {
  const { state } = cursor;
  const ops: JsonPatchOp[] = [];
  const unitPath = (label: string) => `/units/${escapePointerToken(label)}`;
  const unitOf = (label: string): AgencyBuildAguiUnit => ({ ...(state.units[label] ?? {}) });
  switch (event.type) {
    case 'route':
      ops.push({ op: 'replace', path: '/route', value: { decision: event.decision ?? 'unrouted', ...(event.family ? { family: event.family } : {}) } });
      if (event.family) ops.push({ op: 'replace', path: '/input/family', value: event.family });
      if (event.outputScope && event.outputScope !== state.outputScope) ops.push({ op: 'replace', path: '/outputScope', value: event.outputScope });
      if (typeof event.ms === 'number') ops.push({ op: 'add', path: '/timings/routeMs', value: event.ms });
      break;
    case 'project':
      if (event.projectId) ops.push({ op: 'replace', path: '/projectId', value: event.projectId });
      break;
    case 'assets':
      if (typeof event.ms === 'number') ops.push({ op: 'add', path: '/timings/assetsMs', value: event.ms });
      if (typeof event.count === 'number') ops.push({ op: 'add', path: '/timings/assets', value: event.count });
      break;
    case 'first-token':
      if (typeof event.ms === 'number') ops.push({ op: 'add', path: '/timings/firstTokenMs', value: event.ms });
      break;
    case 'unit':
      if (event.label !== undefined) {
        const unit = unitOf(event.label);
        if (typeof event.ms === 'number') unit.ms = event.ms;
        if (typeof event.repairs === 'number') unit.repairs = event.repairs;
        ops.push({ op: 'add', path: unitPath(event.label), value: unit });
      }
      break;
    case 'merged':
      if (event.label !== undefined) {
        const unit = unitOf(event.label);
        if (typeof event.ms === 'number') unit.merged = event.ms;
        ops.push({ op: 'add', path: unitPath(event.label), value: unit });
      }
      break;
    case 'paint':
      ops.push({ op: 'replace', path: '/paints', value: typeof event.count === 'number' ? event.count : state.paints + 1 });
      break;
    case 'repair':
      if (event.label !== undefined) {
        ops.push({ op: 'add', path: '/repairs/-', value: { label: event.label, reason: event.reason ?? 'invalid' } });
      }
      break;
    case 'clipped':
      if (event.label !== undefined) ops.push({ op: 'add', path: '/clipped/-', value: event.label });
      break;
    case 'sections':
      ops.push({
        op: 'replace',
        path: '/sections',
        value: {
          kept: [...(event.keptSections ?? [])],
          dropped: [...(event.droppedSections ?? [])],
          source: event.sectionSource ?? 'default',
          reason: event.reason ?? null,
        },
      });
      break;
    case 'effects':
      // Like `sections`, the effect plan settles once, before the fill. The state has no slot for
      // its ids (they land on the snapshot's `effects` at the end); the event's own time is kept
      // with the other stamps, and the counts travel in the CUSTOM frame's `label`.
      if (typeof event.ms === 'number') ops.push({ op: 'add', path: '/timings/effectsMs', value: event.ms });
      break;
    case 'render-quality':
      // Add works for reconnects whose restored state predates this field.
      if (event.renderQuality) ops.push({ op: 'add', path: '/renderQuality', value: event.renderQuality });
      break;
    case 'verify':
      ops.push({
        op: 'replace',
        path: '/verify',
        value: { ms: event.ms ?? null, counts: event.counts ?? null, reason: event.reason ?? null },
      });
      if (cursor.sawPreview) {
        // The flagged paths are not on the event; the terminal frames carry them from the
        // snapshot. Until then the verdict says whether the check ran, not what it found.
        ops.push({
          op: 'replace',
          path: '/verdict',
          value: { status: event.reason !== undefined ? 'skipped' : 'done', flagged: [], ...(typeof event.ms === 'number' ? { ms: event.ms } : {}) },
        });
      }
      break;
    case 'registered':
      if (typeof event.ms === 'number') ops.push({ op: 'add', path: '/timings/registeredMs', value: event.ms });
      break;
    case 'composition':
      // `add`, not `replace`: a cursor restored from an older state may have no `composition` key.
      if (event.composition) ops.push({ op: 'add', path: '/composition', value: event.composition });
      break;
    case 'preview':
      if (event.url !== undefined) ops.push({ op: 'replace', path: '/previewUrl', value: event.url });
      ops.push({ op: 'replace', path: '/verdict', value: { status: 'pending', flagged: [] } });
      break;
    default:
      break;
  }
  const status = advance(state.build.status, phaseOf(event));
  if (status !== state.build.status) ops.push({ op: 'replace', path: '/build/status', value: status });
  return ops;
}

type Frame = AguiEvent<AgencyBuildAguiState>;

/** Folds the start plus `events` into a cursor, as a live stream would have left it. */
export function foldAgencyBuildCursor(meta: AgencyBuildAguiMeta, events: readonly AgencyBuildEvent[]): AgencyBuildAguiCursor {
  let cursor = createAgencyBuildCursor(meta);
  for (const event of events) cursor = encodeEvent(event, cursor, 0).cursor;
  return cursor;
}

/** The state after `events`: what a client that saw all of them holds. */
export function foldAgencyBuildState(meta: AgencyBuildAguiMeta, events: readonly AgencyBuildEvent[]): AgencyBuildAguiState {
  return foldAgencyBuildCursor(meta, events).state;
}

function encodeEvent(event: AgencyBuildEvent, cursor: AgencyBuildAguiCursor, timestamp: number): AgencyBuildAguiEncoded {
  if (cursor.ended) return { events: [], cursor };
  const frames: Frame[] = [];
  let next: AgencyBuildAguiCursor = { ...cursor };

  const sawPreview = cursor.sawPreview || event.type === 'preview';
  const target = targetStep(event, cursor);
  const forced = target === 'verify' && cursor.sawPreview && cursor.openStep !== 'verify';
  if (target !== null && target !== cursor.openStep && (forced || STEP_RANK[target] > maxRank(cursor))) {
    if (next.openStep) {
      frames.push({ type: 'STEP_FINISHED', stepName: next.openStep, timestamp });
      next = { ...next, stepsDone: [...next.stepsDone, next.openStep] };
    }
    frames.push({ type: 'STEP_STARTED', stepName: target, timestamp });
    next = { ...next, openStep: target };
  }

  const delta = deltaFor(event, next);
  if (delta.length > 0) {
    frames.push({ type: 'STATE_DELTA', delta, timestamp });
    next = { ...next, state: applyJsonPatch(next.state, delta) };
  }

  // A composed build decides its page without a family route, so its `composition` event is what
  // ends the route step; after a `route` event the step is already closed and this does nothing.
  if ((event.type === 'route' || event.type === 'composition') && next.openStep === 'route') {
    frames.push({ type: 'STEP_FINISHED', stepName: 'route', timestamp });
    next = { ...next, openStep: null, stepsDone: [...next.stepsDone, 'route'] };
  }

  frames.push({ type: 'CUSTOM', name: AGENCY_BUILD_EVENT_CUSTOM_NAME, value: event, timestamp });
  return { events: frames, cursor: { ...next, sawPreview } };
}

function encodeStart(meta: AgencyBuildAguiMeta, replayed: readonly AgencyBuildEvent[], timestamp: number): AgencyBuildAguiEncoded {
  const cursor = foldAgencyBuildCursor(meta, replayed);
  const frames: Frame[] = [
    { type: 'RUN_STARTED', threadId: `agency-build:${meta.buildId}`, runId: meta.buildId, timestamp },
    { type: 'STATE_SNAPSHOT', snapshot: cursor.state, timestamp },
  ];
  // A resumed stream is still a whole stream: the steps the client already saw finish are sent
  // again as pairs, so every STEP_FINISHED in THIS stream has its STEP_STARTED before it.
  for (const step of cursor.stepsDone) {
    frames.push({ type: 'STEP_STARTED', stepName: step, timestamp }, { type: 'STEP_FINISHED', stepName: step, timestamp });
  }
  if (cursor.openStep) frames.push({ type: 'STEP_STARTED', stepName: cursor.openStep, timestamp });
  return { events: frames, cursor };
}

function encodeEnd(snapshot: AgencyBuildSnapshot, input: AgencyBuildAguiInput | undefined, cursor: AgencyBuildAguiCursor, timestamp: number): AgencyBuildAguiEncoded {
  if (cursor.ended) return { events: [], cursor };
  const { state } = cursor;
  const frames: Frame[] = [];
  const ops: JsonPatchOp[] = [];
  const set = (path: string, current: unknown, value: unknown) => {
    if (!sameJson(current, value)) ops.push({ op: 'replace', path, value });
  };
  set('/build/status', state.build.status, snapshot.status);
  set('/build/finishedAt', state.build.finishedAt, snapshot.finishedAt ?? null);
  const family = snapshot.family ?? input?.family ?? state.input.family;
  set('/input/family', state.input.family, family);
  if (input) {
    set('/input/provider', state.input.provider, input.provider);
    set('/input/model', state.input.model, input.model);
  }
  if (snapshot.route) set('/route', state.route, snapshot.route);
  if (snapshot.outputScope) set('/outputScope', state.outputScope, snapshot.outputScope);
  // A rolled-back project is gone: the daemon drops its id from the snapshot, and so does this.
  set('/projectId', state.projectId, snapshot.projectId ?? null);
  if (snapshot.verify) set('/verdict', state.verdict, snapshot.verify);
  set('/error', state.error, snapshot.error ?? null);
  // `add`, not `replace`: a cursor restored from an older state may have no `failure` key at all.
  if (!sameJson(state.failure ?? null, snapshot.failure ?? null)) ops.push({ op: 'add', path: '/failure', value: snapshot.failure ?? null });
  set('/summary', state.summary, snapshot.summary ?? null);
  if (!sameJson(state.renderQuality ?? null, snapshot.renderQuality ?? null)) ops.push({ op: 'add', path: '/renderQuality', value: snapshot.renderQuality ?? null });
  set('/providers', state.providers, snapshot.providers ?? []);
  // `add`, like `failure`: a cursor restored from an older state may have no `effects` key.
  if (!sameJson(state.effects ?? null, snapshot.effects ?? null)) ops.push({ op: 'add', path: '/effects', value: snapshot.effects ?? null });
  // The terminal snapshot's composition is the PUBLISHED plan (after the page budget dropped any
  // block); the `composition` event carried the plan before the fill. The snapshot wins, so a
  // client never shows a dropped block as published. Kept as is when the snapshot has none.
  if (snapshot.composition && !sameJson(state.composition ?? null, snapshot.composition)) ops.push({ op: 'add', path: '/composition', value: snapshot.composition });

  let next: AgencyBuildAguiCursor = cursor;
  if (ops.length > 0) {
    frames.push({ type: 'STATE_DELTA', delta: ops, timestamp });
    next = { ...next, state: applyJsonPatch(next.state, ops) };
  }
  if (next.openStep) {
    frames.push({ type: 'STEP_FINISHED', stepName: next.openStep, timestamp });
    next = { ...next, stepsDone: [...next.stepsDone, next.openStep], openStep: null };
  }
  if (snapshot.status === 'failed') {
    frames.push({
      type: 'RUN_ERROR',
      message: snapshot.error?.message ?? 'the build failed',
      code: snapshot.error?.code ?? 'BUILD_FAILED',
      timestamp,
    });
  } else {
    frames.push({
      type: 'RUN_FINISHED',
      threadId: `agency-build:${cursor.meta.buildId}`,
      runId: cursor.meta.buildId,
      result: {
        status: snapshot.status,
        ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
        ...(snapshot.family ? { family: snapshot.family } : {}),
        ...(snapshot.route ? { route: snapshot.route } : {}),
      },
      timestamp,
    });
  }
  return { events: frames, cursor: { ...next, ended: true } };
}

/**
 * Encodes one step of a build stream. Start with `{ kind: 'start' }` (no cursor needed), feed
 * each build event, and finish with `{ kind: 'end' }`. Returns the frames to send and the cursor
 * for the next call. Event frames are stamped with the event's own `at`; `now` stamps the rest.
 */
export function encodeAgencyBuildEvent(
  source: AgencyBuildAguiSource,
  cursor?: AgencyBuildAguiCursor,
  now: () => number = Date.now,
): AgencyBuildAguiEncoded {
  if (source.kind === 'start') return encodeStart(source.meta, source.replayed ?? [], now());
  if (!cursor) throw new Error('encodeAgencyBuildEvent needs the cursor a start returned');
  if (source.kind === 'event') {
    const at = Date.parse(source.event.at);
    return encodeEvent(source.event, cursor, Number.isFinite(at) ? at : now());
  }
  return encodeEnd(source.snapshot, source.input, cursor, now());
}
