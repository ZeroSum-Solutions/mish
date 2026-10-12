/**
 * The web side of `GET /api/agency/builds/:id/agui`: a pure reducer from AG-UI frames to what
 * the Build panel shows, and the `EventSource` that feeds it.
 *
 * The daemon encodes with `@mish/agui-adapter`; this file does not import it (the web app
 * would then depend on that package's built output), so the small JSON Patch applier below is
 * this side's own. Frames are untrusted input and are checked here before the reducer sees them.
 *
 * The stream is a watch-only view of a build `POST /api/agency/build` started. It is not a
 * general AG-UI agent endpoint: it takes no run input.
 */

import type {
  AgencyBuildAguiState,
  AgencyBuildAguiStepName,
  AgencyBuildEvent,
  AgencyBuildSnapshot,
  AgencyBuildStatus,
} from '@mish/contracts';

/** The four statuses a build ends on. Anything else means it is still running. */
export const AGENCY_BUILD_TERMINAL: readonly AgencyBuildStatus[] = ['done', 'unrouted', 'failed', 'cancelled'];

export function isAgencyBuildTerminal(status: AgencyBuildStatus): boolean {
  return AGENCY_BUILD_TERMINAL.includes(status);
}

/** `CUSTOM.name` of the frame that carries each build event. Mirrors the contract's constant. */
const BUILD_EVENT_NAME = 'od.agency-build.event';

type JsonPatchOp =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

/** The AG-UI frames this view reads. Anything else is ignored. */
export type AgencyBuildAguiFrame =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId?: string; runId?: string; result?: unknown }
  | { type: 'RUN_ERROR'; message: string; code?: string }
  | { type: 'STEP_STARTED'; stepName: string }
  | { type: 'STEP_FINISHED'; stepName: string }
  | { type: 'STATE_SNAPSHOT'; snapshot: AgencyBuildAguiState }
  | { type: 'STATE_DELTA'; delta: JsonPatchOp[] }
  | { type: 'CUSTOM'; name: string; value: unknown }
  /**
   * Not an AG-UI frame: this side's marker for a frame it could not read — invalid JSON
   * (`frameType: null`) or a known frame that failed validation. See `rejectedAguiFrame`.
   */
  | { type: 'REJECTED'; frameType: string | null };

export type AgencyBuildStepStatus = 'pending' | 'active' | 'done' | 'failed';

/**
 * The steps the Build panel's timeline shows, in their default order. Steps the stream started
 * are shown in the order it started them (`verify: 'after'` publishes before it verifies); the
 * rest follow in this order. `deploy` is never sent today.
 */
export const AGENCY_BUILD_TIMELINE_STEPS: readonly AgencyBuildAguiStepName[] = ['route', 'fill', 'verify', 'publish'];

export interface AgencyBuildAguiView {
  state: AgencyBuildAguiState | null;
  /** Driven only by STEP_STARTED / STEP_FINISHED (and RUN_ERROR marking the last one failed). */
  steps: Partial<Record<AgencyBuildAguiStepName, AgencyBuildStepStatus>>;
  /** The step most recently finished — the one a RUN_ERROR right after it failed in. */
  lastFinished: AgencyBuildAguiStepName | null;
  /** Each step once, in the order its first STEP_STARTED arrived. */
  stepOrder: AgencyBuildAguiStepName[];
  /** The build's own events, from the CUSTOM frames, deduplicated by `seq`. */
  events: AgencyBuildEvent[];
  runStatus: 'idle' | 'running' | 'finished' | 'error';
  error: { message: string; code?: string } | null;
  /**
   * Any unreadable or invalid frame marks the view stale and forces a snapshot fetch at terminal —
   * a STATE_DELTA that did not apply, a STATE_SNAPSHOT or STATE_DELTA that failed validation, or a
   * frame that was not valid JSON at all, whatever its type. That last case is deliberately
   * conservative: a frame that cannot even be parsed might have carried state, so `state` is
   * treated as out of step with the daemon. Only a later STATE_SNAPSHOT (or a new RUN_STARTED)
   * clears it. A terminal frame that lands while this is set must not be trusted for the final
   * build: fetch the build snapshot instead.
   */
  stale: boolean;
}

export const EMPTY_AGENCY_BUILD_AGUI_VIEW: AgencyBuildAguiView = {
  state: null,
  steps: {},
  lastFinished: null,
  stepOrder: [],
  events: [],
  runStatus: 'idle',
  error: null,
  stale: false,
};

const STEP_NAMES = new Set<string>(['route', 'fill', 'verify', 'publish', 'deploy']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates one parsed frame at the boundary; `null` for anything this view does not read. */
export function parseAgencyBuildAguiFrame(value: unknown): AgencyBuildAguiFrame | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'RUN_STARTED':
      return typeof value.runId === 'string' ? { type: 'RUN_STARTED', threadId: String(value.threadId ?? ''), runId: value.runId } : null;
    case 'RUN_FINISHED':
      return { type: 'RUN_FINISHED', result: value.result };
    case 'RUN_ERROR':
      return {
        type: 'RUN_ERROR',
        message: typeof value.message === 'string' ? value.message : '',
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
      };
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return typeof value.stepName === 'string' ? { type: value.type, stepName: value.stepName } : null;
    case 'STATE_SNAPSHOT':
      return isRecord(value.snapshot) && isRecord(value.snapshot.build)
        ? { type: 'STATE_SNAPSHOT', snapshot: value.snapshot as unknown as AgencyBuildAguiState }
        : null;
    case 'STATE_DELTA':
      return Array.isArray(value.delta) && value.delta.every((op) => isRecord(op) && typeof op.op === 'string' && typeof op.path === 'string')
        ? { type: 'STATE_DELTA', delta: value.delta as JsonPatchOp[] }
        : null;
    case 'CUSTOM':
      return typeof value.name === 'string' ? { type: 'CUSTOM', name: value.name, value: value.value } : null;
    default:
      return null;
  }
}

const STATE_FRAME_TYPES = new Set<string>(['STATE_SNAPSHOT', 'STATE_DELTA']);

/**
 * What the stream does with SSE data `parseAgencyBuildAguiFrame` did not accept. Any frame that
 * was not valid JSON becomes a REJECTED marker with `frameType: null` regardless of what it might
 * have been — it could not be inspected, so it is treated as if it may have carried state, and the
 * reducer marks the view stale; a known state frame (STATE_SNAPSHOT/STATE_DELTA) that failed
 * validation becomes a REJECTED marker with its type for the same reason; any other frame type
 * this view does not read is ignored (`null`).
 */
export function rejectedAguiFrame(parsed: unknown, validJson: boolean): AgencyBuildAguiFrame | null {
  if (!validJson) return { type: 'REJECTED', frameType: null };
  const frameType = isRecord(parsed) && typeof parsed.type === 'string' ? parsed.type : null;
  return frameType !== null && STATE_FRAME_TYPES.has(frameType) ? { type: 'REJECTED', frameType } : null;
}

/** One SSE `data` string to the frame the reducer gets, or `null` when it is to be ignored. */
export function readAgencyBuildAguiData(data: string): AgencyBuildAguiFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return rejectedAguiFrame(undefined, false);
  }
  return parseAgencyBuildAguiFrame(parsed) ?? rejectedAguiFrame(parsed, true);
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function applyOne(target: unknown, tokens: string[], op: JsonPatchOp): unknown {
  if (tokens.length === 0) {
    if (op.op === 'remove') throw new Error('cannot remove the root');
    return op.value;
  }
  const [head, ...rest] = tokens as [string, ...string[]];
  if (Array.isArray(target)) {
    const copy = [...target];
    const index = head === '-' ? copy.length : Number(head);
    if (!Number.isInteger(index) || index < 0 || index > copy.length) throw new Error('bad index');
    if (rest.length === 0) {
      if (op.op === 'add') copy.splice(index, 0, op.value);
      else if (index >= copy.length) throw new Error('no element');
      else if (op.op === 'replace') copy[index] = op.value;
      else copy.splice(index, 1);
      return copy;
    }
    if (index >= copy.length) throw new Error('no element');
    copy[index] = applyOne(copy[index], rest, op);
    return copy;
  }
  if (!isRecord(target)) throw new Error('not a container');
  const copy: Record<string, unknown> = { ...target };
  if (rest.length === 0) {
    if (op.op !== 'add' && !(head in copy)) throw new Error('no member');
    if (op.op === 'remove') delete copy[head];
    else copy[head] = op.value;
    return copy;
  }
  if (!(head in copy)) throw new Error('no member');
  copy[head] = applyOne(copy[head], rest, op);
  return copy;
}

/** RFC 6902 add / replace / remove, without mutating `document`. Throws on a bad path. */
export function applyAguiPatch<T>(document: T, ops: readonly JsonPatchOp[]): T {
  let result: unknown = document;
  for (const op of ops) {
    if (op.path !== '' && !op.path.startsWith('/')) throw new Error('bad pointer');
    const tokens = op.path === '' ? [] : op.path.slice(1).split('/').map(unescapeToken);
    result = applyOne(result, tokens, op);
  }
  return result as T;
}

function isBuildEvent(value: unknown): value is AgencyBuildEvent {
  return isRecord(value) && typeof value.seq === 'number' && typeof value.type === 'string' && typeof value.at === 'string';
}

/**
 * One frame into the view. Pure. A repeated RUN_STARTED (the browser reconnected with
 * `Last-Event-ID`) starts the steps and state over — the daemon re-sends both — but keeps the
 * events already seen, since a resume sends only the later ones.
 */
export function reduceAgencyBuildAgui(view: AgencyBuildAguiView, frame: AgencyBuildAguiFrame): AgencyBuildAguiView {
  switch (frame.type) {
    case 'RUN_STARTED':
      // Resets stepOrder to []. The started-first timeline order (agencyBuildTimeline below)
      // depends on the daemon re-sending STEP_STARTED frames after a reconnect; if a reconnect
      // ever delivered only STATE_SNAPSHOT + a terminal frame with no STEP frames replayed, the
      // timeline would silently fall back to its default step order.
      return { ...EMPTY_AGENCY_BUILD_AGUI_VIEW, events: view.events, runStatus: 'running' };
    case 'STATE_SNAPSHOT':
      return { ...view, state: frame.snapshot, stale: false };
    case 'STATE_DELTA': {
      // Once out of step, every later delta is relative to a state this view does not hold.
      if (view.stale) return view;
      if (!view.state) return { ...view, stale: true };
      try {
        return { ...view, state: applyAguiPatch(view.state, frame.delta) };
      } catch {
        // A patch that does not apply means this view is out of step: keep the last good state
        // for display, but mark it so the terminal frame is not read from it.
        return { ...view, stale: true };
      }
    }
    case 'REJECTED':
      // The lost frame may have carried state (a terminal status, a project id): later deltas are
      // relative to a state this view does not hold, and the terminal frame must not be read from it.
      return view.stale ? view : { ...view, stale: true };
    case 'STEP_STARTED': {
      if (!STEP_NAMES.has(frame.stepName)) return view;
      const name = frame.stepName as AgencyBuildAguiStepName;
      return {
        ...view,
        steps: { ...view.steps, [name]: 'active' },
        stepOrder: view.stepOrder.includes(name) ? view.stepOrder : [...view.stepOrder, name],
      };
    }
    case 'STEP_FINISHED':
      if (!STEP_NAMES.has(frame.stepName)) return view;
      return {
        ...view,
        steps: { ...view.steps, [frame.stepName]: 'done' },
        lastFinished: frame.stepName as AgencyBuildAguiStepName,
      };
    case 'CUSTOM': {
      if (frame.name !== BUILD_EVENT_NAME || !isBuildEvent(frame.value)) return view;
      const event = frame.value;
      if (view.events.some((seen) => seen.seq === event.seq)) return view;
      return { ...view, events: [...view.events, event] };
    }
    case 'RUN_FINISHED':
      return { ...view, runStatus: 'finished' };
    case 'RUN_ERROR':
      return {
        ...view,
        runStatus: 'error',
        error: { message: frame.message, ...(frame.code !== undefined ? { code: frame.code } : {}) },
        steps: view.lastFinished ? { ...view.steps, [view.lastFinished]: 'failed' } : view.steps,
      };
    default:
      return view;
  }
}

/**
 * The status of each timeline step; a step no STEP frame named is `pending`. Started steps come
 * first, in the order the stream started them; the others follow in the default order.
 */
export function agencyBuildTimeline(view: AgencyBuildAguiView | null): Array<{ name: AgencyBuildAguiStepName; status: AgencyBuildStepStatus }> {
  const started = (view?.stepOrder ?? []).filter((name) => AGENCY_BUILD_TIMELINE_STEPS.includes(name));
  const rest = AGENCY_BUILD_TIMELINE_STEPS.filter((name) => !started.includes(name));
  return [...started, ...rest].map((name) => ({ name, status: view?.steps[name] ?? 'pending' }));
}

/**
 * The finished build as a snapshot, from the stream's own state — what the panel shows once
 * RUN_FINISHED or RUN_ERROR arrives, without a second request. `base` is the snapshot the panel
 * attached with; every field the state knows replaces it.
 */
export function agencyBuildSnapshotFromAgui(view: AgencyBuildAguiView, base: AgencyBuildSnapshot): AgencyBuildSnapshot {
  const state = view.state;
  const { projectId: _p, family: _f, route: _r, summary: _s, error: _e, failure: _fl, verify: _v, finishedAt: _fa, providers: _pr, effects: _ef, renderQuality: _rq, ...rest } = base;
  if (!state) return { ...base, events: view.events };
  const family = state.input.family !== 'auto' ? state.input.family : undefined;
  // A present null explicitly clears a result; older streams can recover it from their
  // latest fixed-code event, then the snapshot they attached with.
  const renderQuality = state.renderQuality !== undefined ? state.renderQuality
    : [...view.events].reverse().find((event) => event.type === 'render-quality' && event.renderQuality)?.renderQuality ?? base.renderQuality;
  return {
    ...rest,
    status: state.build.status,
    events: view.events,
    ...(state.build.finishedAt ? { finishedAt: state.build.finishedAt } : {}),
    ...(family ? { family } : {}),
    ...(state.route ? { route: state.route } : {}),
    ...(state.projectId ? { projectId: state.projectId } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    ...(renderQuality ? { renderQuality } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.effects ? { effects: state.effects } : {}),
    // The composition decision (`blocks`/`auto` builds): the stream's once its event landed,
    // otherwise whatever the base snapshot already carried (kept through `rest`).
    ...(state.composition ? { composition: state.composition } : {}),
    ...(state.verdict ? { verify: state.verdict } : {}),
    // Older streams (and a build that never reached the model) carry no list: keep the base's.
    ...(state.providers?.length ? { providers: state.providers } : base.providers ? { providers: base.providers } : {}),
  };
}

/**
 * Opens the build's AG-UI stream. Every frame arrives as the default SSE `message` event; the
 * browser reconnects on its own with `Last-Event-ID`, and the caller closes the source once a
 * terminal frame lands (the daemon ends the response there, and an open source would reconnect).
 */
export function agencyBuildAgui(
  buildId: string,
  handlers: { onFrame: (frame: AgencyBuildAguiFrame) => void; onError?: () => void },
): EventSource {
  const source = new EventSource(`/api/agency/builds/${encodeURIComponent(buildId)}/agui`);
  source.addEventListener('message', (message) => {
    const frame = readAgencyBuildAguiData(String((message as MessageEvent).data));
    if (frame) handlers.onFrame(frame);
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) handlers.onError?.();
  };
  return source;
}
