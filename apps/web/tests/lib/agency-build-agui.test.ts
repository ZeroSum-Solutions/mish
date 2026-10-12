// The Build panel's AG-UI reducer: STEP frames drive the timeline, STATE_* the state, CUSTOM the
// progress events, and a reconnect's second RUN_STARTED starts steps over but keeps the events.

import { describe, expect, it } from 'vitest';
import type { AgencyBuildAguiState, AgencyBuildEvent, AgencyBuildSnapshot } from '@open-design/contracts';

import {
  agencyBuildSnapshotFromAgui,
  agencyBuildTimeline,
  applyAguiPatch,
  EMPTY_AGENCY_BUILD_AGUI_VIEW,
  parseAgencyBuildAguiFrame,
  readAgencyBuildAguiData,
  reduceAgencyBuildAgui,
  type AgencyBuildAguiFrame,
  type AgencyBuildAguiView,
} from '../../src/lib/agency-build-agui';

const STATE: AgencyBuildAguiState = {
  build: { id: 'build-1', status: 'routing', startedAt: '2026-09-23T10:00:00.000Z', finishedAt: null },
  input: { family: 'auto', mode: 'sections', verify: 'strict', provider: null, model: null, briefChars: 42 },
  route: null,
  outputScope: null,
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
  summary: null,
  providers: [],
};

const event = (seq: number, type: AgencyBuildEvent['type']): AgencyBuildEvent => ({ seq, at: '2026-09-23T10:00:01.000Z', type });
const custom = (value: AgencyBuildEvent): AgencyBuildAguiFrame => ({ type: 'CUSTOM', name: 'od.agency-build.event', value });

function run(frames: AgencyBuildAguiFrame[], from: AgencyBuildAguiView = EMPTY_AGENCY_BUILD_AGUI_VIEW) {
  return frames.reduce(reduceAgencyBuildAgui, from);
}

const START: AgencyBuildAguiFrame[] = [
  { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' },
  { type: 'STATE_SNAPSHOT', snapshot: STATE },
  { type: 'STEP_STARTED', stepName: 'route' },
];

describe('reduceAgencyBuildAgui', () => {
  it('drives the timeline from STEP frames only', () => {
    const view = run([
      ...START,
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'building' }] },
      { type: 'STEP_FINISHED', stepName: 'route' },
      custom(event(1, 'route')),
      { type: 'STEP_STARTED', stepName: 'fill' },
      // An event that implies a later phase changes no step on its own.
      custom(event(2, 'registered')),
    ]);
    expect(agencyBuildTimeline(view)).toEqual([
      { name: 'route', status: 'done' },
      { name: 'fill', status: 'active' },
      { name: 'verify', status: 'pending' },
      { name: 'publish', status: 'pending' },
    ]);
    expect(view.state?.build.status).toBe('building');
    expect(view.events.map((seen) => seen.seq)).toEqual([1, 2]);
    expect(view.runStatus).toBe('running');
  });

  it('marks the step that just finished as failed on RUN_ERROR', () => {
    const view = run([
      ...START,
      { type: 'STEP_FINISHED', stepName: 'route' },
      { type: 'STEP_STARTED', stepName: 'fill' },
      { type: 'STEP_FINISHED', stepName: 'fill' },
      { type: 'RUN_ERROR', message: 'the model key is not available on this daemon', code: 'MODEL_UNAVAILABLE' },
    ]);
    expect(view.steps).toEqual({ route: 'done', fill: 'failed' });
    expect(view.runStatus).toBe('error');
    expect(view.error).toEqual({ message: 'the model key is not available on this daemon', code: 'MODEL_UNAVAILABLE' });
  });

  it('starts steps over on a reconnect but keeps the events it already has', () => {
    const before = run([...START, { type: 'STEP_FINISHED', stepName: 'route' }, custom(event(1, 'route')), custom(event(1, 'route'))]);
    expect(before.events).toHaveLength(1);
    const after = run([
      { type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1' },
      { type: 'STATE_SNAPSHOT', snapshot: { ...STATE, build: { ...STATE.build, status: 'building' } } },
      { type: 'STEP_STARTED', stepName: 'route' },
      { type: 'STEP_FINISHED', stepName: 'route' },
      custom(event(2, 'unit')),
    ], before);
    expect(after.steps).toEqual({ route: 'done' });
    expect(after.events.map((seen) => seen.seq)).toEqual([1, 2]);
  });

  it('applies the optional-section decision a STATE_DELTA carries', () => {
    const sections = { kept: ['final-cta'], dropped: ['reviews'], source: 'jev' as const, reason: null };
    const view = run([
      { type: 'RUN_STARTED', threadId: 't', runId: 'build-1' },
      { type: 'STATE_SNAPSHOT', snapshot: STATE },
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/sections', value: sections }] },
    ]);
    expect(view.stale).toBe(false);
    expect(view.state?.sections).toEqual(sections);
  });

  it('keeps the last good state when a delta does not apply, and marks the view stale', () => {
    const view = run([...START, { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/nope/deeper', value: 1 }] }]);
    expect(view.state).toEqual(STATE);
    expect(view.stale).toBe(true);
  });

  it('stays stale through later deltas and the terminal frame; only a STATE_SNAPSHOT clears it', () => {
    const stale = run([
      ...START,
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/nope/deeper', value: 1 }] },
      // Relative to a state this view does not hold, so it must not apply even though it could.
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'done' }] },
      { type: 'RUN_FINISHED', result: { status: 'done' } },
    ]);
    expect(stale.stale).toBe(true);
    expect(stale.runStatus).toBe('finished');
    expect(stale.state?.build.status).toBe(STATE.build.status);

    const healed = run([{ type: 'STATE_SNAPSHOT', snapshot: { ...STATE, build: { ...STATE.build, status: 'done' } } }], stale);
    expect(healed.stale).toBe(false);
    expect(healed.state?.build.status).toBe('done');
  });

  it('orders the timeline by STEP_STARTED order: verify after publish for verify:"after"', () => {
    const view = run([
      ...START,
      { type: 'STEP_FINISHED', stepName: 'route' },
      { type: 'STEP_STARTED', stepName: 'fill' },
      { type: 'STEP_FINISHED', stepName: 'fill' },
      { type: 'STEP_STARTED', stepName: 'publish' },
    ]);
    // Not started yet: verify keeps its default place among the pending steps, after publish.
    expect(agencyBuildTimeline(view).map((step) => step.name)).toEqual(['route', 'fill', 'publish', 'verify']);
    const later = run([
      { type: 'STEP_FINISHED', stepName: 'publish' },
      { type: 'STEP_STARTED', stepName: 'verify' },
      // A repeated start (a second verify after preview) keeps its first place.
      { type: 'STEP_STARTED', stepName: 'publish' },
    ], view);
    expect(later.stepOrder).toEqual(['route', 'fill', 'publish', 'verify']);
    expect(agencyBuildTimeline(later).map((step) => step.name)).toEqual(['route', 'fill', 'publish', 'verify']);
    // A reconnect starts the order over, from the re-sent STEP frames.
    expect(run([{ type: 'RUN_STARTED', threadId: 't', runId: 'build-1' }], later).stepOrder).toEqual([]);
  });

  it('marks the view stale on a REJECTED frame, and a STATE_SNAPSHOT heals it', () => {
    const stale = run([...START, { type: 'REJECTED', frameType: null }]);
    expect(stale.stale).toBe(true);
    expect(stale.state).toEqual(STATE);
    const ignored = run([{ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'done' }] }], stale);
    expect(ignored.state?.build.status).toBe(STATE.build.status);
    expect(run([{ type: 'STATE_SNAPSHOT', snapshot: STATE }], ignored).stale).toBe(false);
  });

  it('marks a delta with no state to apply to as stale', () => {
    const view = run([{ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/build/status', value: 'done' }] }]);
    expect(view.state).toBeNull();
    expect(view.stale).toBe(true);
  });

  it('projects the streamed structure verdict and lets terminal state replace an earlier result', () => {
    const passed = { passed: true, scope: 'site' as const, checks: ['unique-ids' as const], issueCounts: [] };
    const failed = { ...passed, passed: false, issueCounts: [{ check: 'unique-ids' as const, count: 2 }] };
    const base: AgencyBuildSnapshot = { id: 'build-1', status: 'queued', events: [], startedAt: STATE.build.startedAt, renderQuality: passed };
    const view = run([...START, custom({ ...event(1, 'render-quality'), renderQuality: passed }),
      { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/renderQuality', value: failed }, { op: 'replace', path: '/build/status', value: 'failed' }] },
      { type: 'RUN_ERROR', message: 'structure failed', code: 'RENDER_QUALITY_FAILED' },
    ]);
    expect(agencyBuildSnapshotFromAgui(view, base).renderQuality).toEqual(failed);
    const cleared = run([{ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/renderQuality', value: null }] }], view);
    expect(agencyBuildSnapshotFromAgui(cleared, base).renderQuality).toBeUndefined();
  });

  it('uses the latest structure event when an older stream has no structure state field', () => {
    const quality = { passed: true, scope: 'site' as const, checks: ['unique-ids' as const], issueCounts: [] };
    const base: AgencyBuildSnapshot = { id: 'build-1', status: 'queued', events: [], startedAt: STATE.build.startedAt };
    const view = run([...START, custom({ ...event(1, 'render-quality'), renderQuality: quality }), { type: 'RUN_FINISHED' }]);
    expect(agencyBuildSnapshotFromAgui(view, base).renderQuality).toEqual(quality);
  });

  it('turns the final state into the snapshot the panel shows', () => {
    const view = run([
      ...START,
      {
        type: 'STATE_DELTA',
        delta: [
          { op: 'replace', path: '/build/status', value: 'failed' },
          { op: 'replace', path: '/projectId', value: 'project-7' },
          { op: 'replace', path: '/error', value: { code: 'ROLLBACK_FAILED', message: 'x' } },
        ],
      },
      { type: 'RUN_ERROR', message: 'x', code: 'ROLLBACK_FAILED' },
    ]);
    const base: AgencyBuildSnapshot = { id: 'build-1', status: 'queued', events: [], startedAt: STATE.build.startedAt };
    expect(agencyBuildSnapshotFromAgui(view, base)).toEqual({
      id: 'build-1',
      status: 'failed',
      events: [],
      startedAt: STATE.build.startedAt,
      projectId: 'project-7',
      error: { code: 'ROLLBACK_FAILED', message: 'x' },
    });
  });
});

describe('parseAgencyBuildAguiFrame', () => {
  it('drops what it cannot read', () => {
    expect(parseAgencyBuildAguiFrame(null)).toBeNull();
    expect(parseAgencyBuildAguiFrame({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' })).toBeNull();
    expect(parseAgencyBuildAguiFrame({ type: 'STEP_STARTED' })).toBeNull();
    expect(parseAgencyBuildAguiFrame({ type: 'STATE_DELTA', delta: [{ nope: true }] })).toBeNull();
    expect(parseAgencyBuildAguiFrame({ type: 'STEP_STARTED', stepName: 'fill' })).toEqual({ type: 'STEP_STARTED', stepName: 'fill' });
  });
});

describe('readAgencyBuildAguiData', () => {
  it('turns invalid JSON and a state frame that fails validation into REJECTED; ignores unread types', () => {
    expect(readAgencyBuildAguiData('{"type":"STATE_DELTA",')).toEqual({ type: 'REJECTED', frameType: null });
    expect(readAgencyBuildAguiData(JSON.stringify({ type: 'STATE_DELTA', delta: [{ nope: true }] })))
      .toEqual({ type: 'REJECTED', frameType: 'STATE_DELTA' });
    expect(readAgencyBuildAguiData(JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { build: 'x' } })))
      .toEqual({ type: 'REJECTED', frameType: 'STATE_SNAPSHOT' });
    expect(readAgencyBuildAguiData(JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' }))).toBeNull();
    expect(readAgencyBuildAguiData(JSON.stringify({ type: 'STEP_STARTED', stepName: 'fill' })))
      .toEqual({ type: 'STEP_STARTED', stepName: 'fill' });
  });
});

describe('applyAguiPatch', () => {
  it('applies add, replace and remove without mutating its input', () => {
    const doc = { units: {} as Record<string, unknown>, list: ['a'] };
    const next = applyAguiPatch(doc, [
      { op: 'add', path: '/units/a~1b', value: { ms: 1 } },
      { op: 'add', path: '/list/-', value: 'b' },
      { op: 'remove', path: '/list/0' },
    ]);
    expect(next).toEqual({ units: { 'a/b': { ms: 1 } }, list: ['b'] });
    expect(doc).toEqual({ units: {}, list: ['a'] });
  });
});
