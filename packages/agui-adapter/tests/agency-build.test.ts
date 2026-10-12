// The agency build → AG-UI encoder: spec event names, balanced steps, one terminal frame, a state
// that snapshot-plus-deltas and a resume's fold agree on, and no brief anywhere.

import { describe, expect, it } from 'vitest';
import type { AgencyBuildEvent, AgencyBuildSnapshot } from '@mish/contracts';
import {
  applyJsonPatch,
  encodeAgencyBuildEvent,
  escapePointerToken,
  foldAgencyBuildState,
  type AgencyBuildAguiCursor,
  type AgencyBuildAguiMeta,
  type AguiEvent,
  type JsonPatchOp,
} from '../src/index.js';

const BRIEF = 'A family dental practice in Riverbend that wants more bookings.';
const NOW = 1_800_000_000_000;
const now = () => NOW;

const META: AgencyBuildAguiMeta = {
  buildId: 'build-1',
  startedAt: '2026-09-23T10:00:00.000Z',
  input: { family: 'auto', mode: 'sections', verify: 'strict', provider: null, model: null, briefChars: BRIEF.length },
};

let seq = 0;
function ev(patch: Partial<AgencyBuildEvent> & { type: AgencyBuildEvent['type'] }): AgencyBuildEvent {
  seq += 1;
  return { seq, at: new Date(NOW + seq * 1000).toISOString(), ...patch } as AgencyBuildEvent;
}

/** `extra` may set a field to `undefined` to drop it from the snapshot. */
function done(events: AgencyBuildEvent[], extra: { [K in keyof AgencyBuildSnapshot]?: AgencyBuildSnapshot[K] | undefined } = {}): AgencyBuildSnapshot {
  const snapshot: Record<string, unknown> = {
    id: 'build-1',
    status: 'done',
    family: 'wrenfield',
    route: { decision: 'routed', family: 'wrenfield', probability: 0.71, spine: 'TL' },
    projectId: 'project-1',
    events,
    startedAt: META.startedAt,
    finishedAt: '2026-09-23T10:01:00.000Z',
    ...extra,
  };
  for (const key of Object.keys(snapshot)) if (snapshot[key] === undefined) delete snapshot[key];
  return snapshot as unknown as AgencyBuildSnapshot;
}

/** Runs a whole stream: start (with `replayed`), the rest live, then the end. */
function stream(
  events: AgencyBuildEvent[],
  snapshot: AgencyBuildSnapshot,
  options: { meta?: AgencyBuildAguiMeta; replayed?: number } = {},
): AguiEvent[] {
  const meta = options.meta ?? META;
  const split = options.replayed ?? 0;
  let { events: frames, cursor } = encodeAgencyBuildEvent({ kind: 'start', meta, replayed: events.slice(0, split) }, undefined, now);
  const out: AguiEvent[] = [...frames];
  for (const event of events.slice(split)) {
    ({ events: frames, cursor } = encodeAgencyBuildEvent({ kind: 'event', event }, cursor, now));
    out.push(...frames);
  }
  ({ events: frames } = encodeAgencyBuildEvent({ kind: 'end', snapshot }, cursor, now));
  out.push(...frames);
  return out;
}

function autoBuild(): AgencyBuildEvent[] {
  seq = 0;
  return [
    ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }),
    ev({ type: 'first-token', ms: 900 }),
    ev({ type: 'unit', label: 'hero', ms: 8100, repairs: 0 }),
    ev({ type: 'verify', ms: 20_000, counts: { checked: 12, illustrative: 0, flagged: 0, repaired: 0, remaining: 0 } }),
    ev({ type: 'project', projectId: 'project-1', created: true }),
    ev({ type: 'registered', ms: 41_000 }),
  ];
}

/** Spec invariants every stream must keep. */
function expectWellFormed(frames: AguiEvent[]) {
  expect(frames[0]?.type).toBe('RUN_STARTED');
  const terminals = frames.filter((frame) => frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR');
  expect(terminals).toHaveLength(1);
  expect(frames.at(-1)).toBe(terminals[0]);
  let open: string | null = null;
  for (const frame of frames) {
    if (frame.type === 'STEP_STARTED') {
      expect(open).toBeNull();
      open = frame.stepName;
    }
    if (frame.type === 'STEP_FINISHED') {
      expect(frame.stepName).toBe(open);
      open = null;
    }
  }
  expect(open).toBeNull();
}

describe('encodeAgencyBuildEvent', () => {
  it('maps an auto build to the exact spec-named frame sequence', () => {
    const events = autoBuild();
    const frames = stream(events, done(events));
    expectWellFormed(frames);
    const summary = frames.map((frame) => {
      if (frame.type === 'STEP_STARTED' || frame.type === 'STEP_FINISHED') return `${frame.type}:${frame.stepName}`;
      if (frame.type === 'CUSTOM') return `CUSTOM:${(frame.value as AgencyBuildEvent).type}`;
      return frame.type;
    });
    expect(summary).toEqual([
      'RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED:route',
      'STATE_DELTA', 'STEP_FINISHED:route', 'CUSTOM:route',
      'STEP_STARTED:fill', 'STATE_DELTA', 'CUSTOM:first-token',
      'STATE_DELTA', 'CUSTOM:unit',
      'STEP_FINISHED:fill', 'STEP_STARTED:verify', 'STATE_DELTA', 'CUSTOM:verify',
      'STEP_FINISHED:verify', 'STEP_STARTED:publish', 'STATE_DELTA', 'CUSTOM:project',
      'STATE_DELTA', 'CUSTOM:registered',
      'STATE_DELTA', 'STEP_FINISHED:publish', 'RUN_FINISHED',
    ]);
    expect(frames[0]).toEqual({ type: 'RUN_STARTED', threadId: 'agency-build:build-1', runId: 'build-1', timestamp: NOW });
    const routeDelta = frames[3] as Extract<AguiEvent, { type: 'STATE_DELTA' }>;
    expect(routeDelta.delta).toEqual([
      { op: 'replace', path: '/route', value: { decision: 'routed', family: 'wrenfield' } },
      { op: 'replace', path: '/input/family', value: 'wrenfield' },
      { op: 'add', path: '/timings/routeMs', value: 610 },
      { op: 'replace', path: '/build/status', value: 'building' },
    ]);
    expect(routeDelta.timestamp).toBe(Date.parse(events[0]!.at));
    expect(frames.at(-1)).toEqual({
      type: 'RUN_FINISHED',
      threadId: 'agency-build:build-1',
      runId: 'build-1',
      result: { status: 'done', projectId: 'project-1', family: 'wrenfield', route: done(events).route },
      timestamp: NOW,
    });
  });

  it('carries every build event unchanged in a CUSTOM frame', () => {
    const events = autoBuild();
    const custom = stream(events, done(events)).filter((frame) => frame.type === 'CUSTOM');
    expect(custom.map((frame) => (frame as { name: string }).name)).toEqual(events.map(() => 'od.agency-build.event'));
    expect(custom.map((frame) => (frame as { value: unknown }).value)).toEqual(events);
  });

  it('opens no route step for a build given its family', () => {
    seq = 0;
    const events = [ev({ type: 'first-token', ms: 900 }), ev({ type: 'registered', ms: 2000 })];
    const frames = stream(events, done(events), { meta: { ...META, input: { ...META.input, family: 'wrenfield', provider: 'deepseek' } } });
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_STARTED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps).toEqual(['fill', 'publish']);
  });

  it('does not treat an advisory build\'s early project as the publish', () => {
    seq = 0;
    const events = [
      ev({ type: 'project', projectId: 'project-1', created: true }),
      ev({ type: 'assets', ms: 300, count: 4 }),
      ev({ type: 'first-token', ms: 900 }),
      ev({ type: 'paint', label: 'hero', ms: 1200, count: 1 }),
      ev({ type: 'registered', ms: 2000 }),
    ];
    const frames = stream(events, done(events), { meta: { ...META, input: { ...META.input, family: 'wrenfield', verify: 'advisory' } } });
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_STARTED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps).toEqual(['fill', 'publish']);
  });

  it('reports publish before a second verify step for verify: "after"', () => {
    seq = 0;
    const events = [
      ev({ type: 'first-token', ms: 900 }),
      ev({ type: 'registered', ms: 2000 }),
      ev({ type: 'preview', ms: 2100, url: 'project-1/wrenfield-r1.html' }),
      ev({ type: 'verify', ms: 9000, counts: { checked: 10, illustrative: 0, flagged: 1, repaired: 0, remaining: 1 } }),
    ];
    const snapshot = done(events, { verify: { status: 'done', flagged: ['sections[1].text.heading'], ms: 9000 } });
    const frames = stream(events, snapshot, { meta: { ...META, input: { ...META.input, family: 'wrenfield', verify: 'after' } } });
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_STARTED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps).toEqual(['fill', 'publish', 'verify']);
    const state = finalState(frames);
    expect(state.previewUrl).toBe('project-1/wrenfield-r1.html');
    expect(state.verdict).toEqual({ status: 'done', flagged: ['sections[1].text.heading'], ms: 9000 });
  });

  it('keeps the optional-section decision in the state, without opening a step', () => {
    seq = 0;
    const events = [
      ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }),
      ev({ type: 'sections', ms: 700, keptSections: ['final-cta'], droppedSections: ['reviews'], sectionSource: 'jev' }),
      ev({ type: 'first-token', ms: 900 }),
      ev({ type: 'registered', ms: 2000 }),
    ];
    const frames = stream(events, done(events));
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_STARTED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps).toEqual(['route', 'fill', 'publish']);
    const expected = { kept: ['final-cta'], dropped: ['reviews'], source: 'jev', reason: null };
    expect(finalState(frames).sections).toEqual(expected);
    // A resume after the decision gets it in its opening snapshot, and agrees with the live fold.
    expect(finalState(stream(events, done(events), { replayed: 2 })).sections).toEqual(expected);
    expect(foldAgencyBuildState(META, events).sections).toEqual(expected);
  });

  it('keeps the effects event\'s time without opening a step, and forwards it as a counts-only CUSTOM frame', () => {
    seq = 0;
    const events = [
      ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }),
      ev({ type: 'effects', ms: 740, label: '2 applied, 1 skipped' }),
      ev({ type: 'first-token', ms: 900 }),
      ev({ type: 'registered', ms: 2000 }),
    ];
    const frames = stream(events, done(events));
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_STARTED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps).toEqual(['route', 'fill', 'publish']);
    expect(finalState(frames).timings.effectsMs).toBe(740);
    expect(foldAgencyBuildState(META, events).timings.effectsMs).toBe(740);
    expect(finalState(stream(events, done(events), { replayed: 2 })).timings.effectsMs).toBe(740);
    const custom = frames.find((frame) => frame.type === 'CUSTOM' && (frame as { value: AgencyBuildEvent }).value.type === 'effects') as { value: AgencyBuildEvent };
    expect(custom.value.label).toBe('2 applied, 1 skipped');
    expect(foldAgencyBuildState(META, events.slice(0, 2)).build.status).toBe('building');
  });

  it('carries structure results through live deltas, replay and the terminal snapshot', () => {
    const passed = { passed: true, scope: 'site' as const, checks: ['unique-ids' as const], issueCounts: [] };
    const failed = { ...passed, passed: false, issueCounts: [{ check: 'unique-ids' as const, count: 2 }] };
    const events = [ev({ type: 'render-quality', renderQuality: passed })];
    expect(foldAgencyBuildState(META, events).renderQuality).toEqual(passed);
    const snapshot = done(events, { status: 'failed', renderQuality: failed, error: { code: 'RENDER_QUALITY_FAILED', message: 'structure failed' } });
    const frames = stream(events, snapshot);
    expectWellFormed(frames);
    expect(finalState(frames).renderQuality).toEqual(failed);
    expect(finalState(stream(events, snapshot, { replayed: 1 })).renderQuality).toEqual(failed);
    expect(finalState(stream([], done([], { renderQuality: passed }))).renderQuality).toEqual(passed);
    expect(finalState(stream(events, done(events))).renderQuality).toBeNull();
  });

  it('adds structure state to a cursor restored from an older stream', () => {
    const quality = { passed: true, scope: 'static-prototype' as const, checks: ['unique-ids' as const], issueCounts: [] };
    const started = encodeAgencyBuildEvent({ kind: 'start', meta: META }, undefined, now);
    const { renderQuality: _quality, ...oldState } = started.cursor.state;
    const oldCursor = { ...started.cursor, state: oldState };
    const live = encodeAgencyBuildEvent({ kind: 'event', event: ev({ type: 'render-quality', renderQuality: quality }) }, oldCursor, now);
    expect(live.cursor.state.renderQuality).toEqual(quality);
    const terminal = encodeAgencyBuildEvent({ kind: 'end', snapshot: done([], { renderQuality: quality }) }, oldCursor, now);
    expect(terminal.cursor.state.renderQuality).toEqual(quality);
  });

  it('sets the effects result from the terminal snapshot, and none before it', () => {
    seq = 0;
    const events = [ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }), ev({ type: 'registered', ms: 2000 })];
    expect(foldAgencyBuildState(META, events).effects).toBeNull();
    const effects = {
      mode: 'auto' as const,
      applied: [{ placement: 'hero-title' as const, componentId: 'shiny-text', kind: 'css-only' as const, source: 'jev' as const }],
      skipped: [{ placement: 'cta' as const, reason: 'none' as const }],
      bytesAdded: 900,
    };
    const frames = stream(events, done(events, { effects }));
    expectWellFormed(frames);
    expect(finalState(frames).effects).toEqual(effects);
  });

  it('reports a section decision Jev could not make, and none before the event', () => {
    seq = 0;
    expect(foldAgencyBuildState(META, []).sections).toBeNull();
    const events = [ev({ type: 'sections', ms: 420, keptSections: ['reviews'], droppedSections: [], sectionSource: 'default', reason: 'jev-unavailable' })];
    expect(foldAgencyBuildState(META, events).sections).toEqual({ kept: ['reviews'], dropped: [], source: 'default', reason: 'jev-unavailable' });
  });

  it('C16: carries the output scope — from the route for auto, from the meta for a named family', () => {
    seq = 0;
    expect(foldAgencyBuildState(META, []).outputScope).toBeNull();
    const events = [
      ev({ type: 'route', decision: 'routed', family: 'crm-dashboard', outputScope: 'static-prototype', ms: 610 }),
      ev({ type: 'first-token', ms: 900 }),
      ev({ type: 'registered', ms: 2000 }),
    ];
    const snapshot = done(events, { family: 'crm-dashboard', outputScope: 'static-prototype', route: { decision: 'routed', family: 'crm-dashboard', spine: 'TU' } });
    const frames = stream(events, snapshot);
    expectWellFormed(frames);
    expect(finalState(frames).outputScope).toBe('static-prototype');
    expect(foldAgencyBuildState(META, events).outputScope).toBe('static-prototype');
    expect(finalState(stream(events, snapshot, { replayed: 1 })).outputScope).toBe('static-prototype');

    const named: AgencyBuildAguiMeta = { ...META, input: { ...META.input, family: 'app-shell' }, outputScope: 'static-prototype' };
    expect(foldAgencyBuildState(named, []).outputScope).toBe('static-prototype');
    const site: AgencyBuildAguiMeta = { ...META, input: { ...META.input, family: 'marketing-site' }, outputScope: 'site' };
    expect(foldAgencyBuildState(site, []).outputScope).toBe('site');
  });

  it('ends a failed build with RUN_ERROR and nothing after it', () => {
    seq = 0;
    const events = [ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }), ev({ type: 'first-token', ms: 900 })];
    const snapshot = done(events, {
      status: 'failed',
      projectId: undefined,
      error: { code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' },
    });
    const frames = stream(events, snapshot);
    expectWellFormed(frames);
    expect(frames.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'the model key is not available on this daemon', code: 'MODEL_UNAVAILABLE', timestamp: NOW });
    expect(frames.at(-2)).toEqual({ type: 'STEP_FINISHED', stepName: 'fill', timestamp: NOW });
    expect(finalState(frames).build.status).toBe('failed');
  });

  it('emits nothing once the stream has ended', () => {
    const events = autoBuild();
    let { cursor } = encodeAgencyBuildEvent({ kind: 'start', meta: META, replayed: events }, undefined, now);
    ({ cursor } = encodeAgencyBuildEvent({ kind: 'end', snapshot: done(events) }, cursor, now));
    expect(encodeAgencyBuildEvent({ kind: 'end', snapshot: done(events) }, cursor, now).events).toEqual([]);
    expect(encodeAgencyBuildEvent({ kind: 'event', event: events[0]! }, cursor, now).events).toEqual([]);
  });

  it('closes the route step of an unrouted build and finishes the run', () => {
    seq = 0;
    const events = [ev({ type: 'route', decision: 'unrouted', ms: 500 })];
    const frames = stream(events, done(events, { status: 'unrouted', family: undefined, projectId: undefined, route: { decision: 'unrouted', spine: 'TL' } }));
    expectWellFormed(frames);
    expect(frames.at(-1)).toMatchObject({ type: 'RUN_FINISHED', result: { status: 'unrouted' } });
  });

  it('carries a failover build\'s provider list in the terminal state, and an empty one otherwise', () => {
    seq = 0;
    const events = [
      ev({ type: 'route', decision: 'routed', family: 'wrenfield', ms: 610 }),
      ev({ type: 'failover', label: 'cerebras', reason: 'server-error' }),
      ev({ type: 'unit', label: 'hero', ms: 8100, repairs: 0 }),
    ];
    const providers = [
      { provider: 'deepseek' as const, model: 'deepseek-v4-flash', sections: ['hero'] },
      { provider: 'cerebras' as const, model: 'gpt-oss-120b', sections: ['footer'] },
    ];
    const frames = stream(events, done(events, { providers }));
    expectWellFormed(frames);
    expect(foldAgencyBuildState(META, events).providers).toEqual([]);
    expect(finalState(frames).providers).toEqual(providers);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'CUSTOM', value: events[1] }));
    const plain = autoBuild();
    expect(finalState(stream(plain, done(plain))).providers).toEqual([]);
  });

  it('closes the route step on a composition event and carries the decision in the state', () => {
    seq = 0;
    const composition = { requested: 'blocks' as const, used: 'blocks' as const, spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-shadcn', 'cult:marketing-cta-cosmic'], source: 'jev' as const };
    const events = [
      ev({ type: 'composition', ms: 700, composition }),
      ev({ type: 'unit', label: 'chrome', ms: 900, repairs: 0 }),
    ];
    const frames = stream(events, done(events, { family: 'composed', route: undefined, composition }));
    expectWellFormed(frames);
    const steps = frames.filter((frame) => frame.type === 'STEP_FINISHED').map((frame) => (frame as { stepName: string }).stepName);
    expect(steps[0]).toBe('route');
    expect(foldAgencyBuildState(META, events).composition).toEqual(composition);
    expect(foldAgencyBuildState(META, [events[1]!]).composition).toBeNull();
  });

  it('ends with the snapshot\'s published plan, not the event\'s pre-budget one', () => {
    seq = 0;
    const planned = { requested: 'blocks' as const, used: 'blocks' as const, spine: 'PA', directionId: 'tech-utility', blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-shadcn', 'cult:marketing-faq-vite', 'cult:marketing-cta-cosmic'], source: 'jev' as const };
    const published = { ...planned, blocks: ['hyperui:marketing/sections/1', 'cult:marketing-bento-shadcn', 'cult:marketing-cta-cosmic'], budgetDropped: ['cult:marketing-faq-vite'], effects: { mode: 'off' as const, reason: 'no-placements' as const } };
    const events = [ev({ type: 'composition', ms: 700, composition: planned }), ev({ type: 'unit', label: 'chrome', ms: 900, repairs: 0 })];
    const frames = stream(events, done(events, { family: 'composed', route: undefined, composition: published }));
    expectWellFormed(frames);
    expect(foldAgencyBuildState(META, events).composition).toEqual(planned);
    expect(finalState(frames).composition).toEqual(published);
  });

  it('escapes unit labels as JSON Pointer tokens', () => {
    expect(escapePointerToken('a/b~c')).toBe('a~1b~0c');
    seq = 0;
    const events = [ev({ type: 'unit', label: 'a/b~c', ms: 5, repairs: 1 })];
    const state = foldAgencyBuildState({ ...META, input: { ...META.input, family: 'wrenfield' } }, events);
    expect(state.units['a/b~c']).toEqual({ ms: 5, repairs: 1 });
  });
});

/** Applies every snapshot and delta in `frames`, as a client would. */
function finalState(frames: AguiEvent[]) {
  let state: any;
  for (const frame of frames) {
    if (frame.type === 'STATE_SNAPSHOT') state = frame.snapshot;
    if (frame.type === 'STATE_DELTA') state = applyJsonPatch(state, frame.delta);
  }
  return state;
}

describe('resume', () => {
  it('snapshot plus later deltas equals the fold, for every resume point', () => {
    const events = autoBuild();
    for (let split = 0; split <= events.length; split += 1) {
      let { events: frames, cursor } = encodeAgencyBuildEvent({ kind: 'start', meta: META, replayed: events.slice(0, split) }, undefined, now);
      const snapshot = frames.find((frame) => frame.type === 'STATE_SNAPSHOT') as { snapshot: unknown };
      expect(snapshot.snapshot).toEqual(foldAgencyBuildState(META, events.slice(0, split)));
      let state: any = snapshot.snapshot;
      for (const event of events.slice(split)) {
        ({ events: frames, cursor } = encodeAgencyBuildEvent({ kind: 'event', event }, cursor, now));
        for (const frame of frames) if (frame.type === 'STATE_DELTA') state = applyJsonPatch(state, frame.delta);
      }
      expect(state).toEqual(foldAgencyBuildState(META, events));
    }
  });

  it('keeps a resumed stream balanced by replaying finished steps as pairs', () => {
    const events = autoBuild();
    const frames = stream(events, done(events), { replayed: 3 });
    expectWellFormed(frames);
    const head = frames.slice(0, 5).map((frame) => (frame.type.startsWith('STEP') ? `${frame.type}:${(frame as { stepName: string }).stepName}` : frame.type));
    expect(head).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED:route', 'STEP_FINISHED:route', 'STEP_STARTED:fill']);
    // Only the events after the resume point come again as CUSTOM frames.
    const custom = frames.filter((frame) => frame.type === 'CUSTOM').map((frame) => ((frame as { value: AgencyBuildEvent }).value).seq);
    expect(custom).toEqual([4, 5, 6]);
  });
});

describe('redaction', () => {
  it('never carries the brief, only its length', () => {
    const events = autoBuild();
    const text = JSON.stringify(stream(events, done(events)));
    expect(text).not.toContain(BRIEF);
    expect(text).not.toContain('Riverbend');
    expect(text).toContain(`"briefChars":${BRIEF.length}`);
  });
});

describe('applyJsonPatch', () => {
  it('adds, replaces and removes without mutating its input', () => {
    const doc = { a: { b: 1 }, list: [1, 2] };
    const ops: JsonPatchOp[] = [
      { op: 'add', path: '/a/c', value: 2 },
      { op: 'replace', path: '/a/b', value: 3 },
      { op: 'add', path: '/list/-', value: 3 },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'remove', path: '/list/1' },
    ];
    expect(applyJsonPatch(doc, ops)).toEqual({ a: { b: 3, c: 2 }, list: [0, 2, 3] });
    expect(doc).toEqual({ a: { b: 1 }, list: [1, 2] });
  });

  it('refuses a replace or remove on a path that does not exist', () => {
    expect(() => applyJsonPatch({}, [{ op: 'replace', path: '/x', value: 1 }])).toThrow();
    expect(() => applyJsonPatch({ a: [] }, [{ op: 'remove', path: '/a/0' }])).toThrow();
  });
});

// Type-level: the cursor is exported for callers that hold it between frames.
export type _Cursor = AgencyBuildAguiCursor;
