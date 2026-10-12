// Drives a fake EventSource the way `GET /api/agency/builds/:id/agui` would: every frame is the
// default SSE `message` event with an AG-UI payload.

import type { AgencyBuildAguiState, AgencyBuildEvent, AgencyBuildSnapshot } from '@open-design/contracts';

interface FrameSink {
  emit(name: string, data: unknown): void;
}

/** The `sections` decision the stream folds from the build's last `sections` event, if any. */
function sectionsOf(events: readonly AgencyBuildEvent[]): AgencyBuildAguiState['sections'] {
  const event = [...events].reverse().find((entry) => entry.type === 'sections');
  if (!event) return null;
  return {
    kept: event.keptSections ?? [],
    dropped: event.droppedSections ?? [],
    source: event.sectionSource ?? 'default',
    reason: event.reason ?? null,
  };
}

/** The AG-UI state a finished stream would hold for `snapshot`. */
export function aguiStateOf(snapshot: AgencyBuildSnapshot): AgencyBuildAguiState {
  return {
    build: { id: snapshot.id, status: snapshot.status, startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt ?? null },
    input: { family: snapshot.family ?? 'auto', mode: 'sections', verify: 'strict', provider: null, model: null, briefChars: 0 },
    route: snapshot.route ?? null,
    outputScope: snapshot.outputScope ?? null,
    projectId: snapshot.projectId ?? null,
    units: {},
    paints: 0,
    repairs: [],
    clipped: [],
    sections: sectionsOf(snapshot.events),
    verify: null,
    verdict: snapshot.verify ?? null,
    previewUrl: null,
    timings: {},
    error: snapshot.error ?? null,
    failure: snapshot.failure ?? null,
    effects: snapshot.effects ?? null,
    composition: snapshot.composition ?? null,
    summary: snapshot.summary ?? null,
    providers: snapshot.providers ?? [],
  };
}

/** One build event, as the stream's CUSTOM passthrough carries it. */
export function emitBuildEvent(source: FrameSink, event: AgencyBuildEvent) {
  source.emit('message', { type: 'CUSTOM', name: 'od.agency-build.event', value: event });
}

/** Ends the stream on `snapshot`: its state, then RUN_ERROR for `failed`, RUN_FINISHED otherwise. */
export function emitBuildEnd(source: FrameSink, snapshot: AgencyBuildSnapshot) {
  source.emit('message', { type: 'STATE_SNAPSHOT', snapshot: aguiStateOf(snapshot) });
  source.emit('message', snapshot.status === 'failed'
    ? { type: 'RUN_ERROR', message: snapshot.error?.message ?? '', ...(snapshot.error ? { code: snapshot.error.code } : {}) }
    : { type: 'RUN_FINISHED', threadId: `agency-build:${snapshot.id}`, runId: snapshot.id, result: { status: snapshot.status } });
}
