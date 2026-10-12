import { describe, expect, it } from 'vitest';

import { API_ERROR_CODES, type ApiErrorCode } from '../src/errors';
import {
  AGENCY_BUILD_AGUI_EVENT_NAME,
  AGENCY_BUILD_HISTORY_LIMIT,
  type AgencyBuildAguiInput,
  type AgencyBuildAguiState,
  type AgencyBuildAguiStepName,
  type AgencyBuildErrorCode,
  type AgencyBuildEvent,
  type AgencyBuildListItem,
  type AgencyBuildRequest,
  type AgencyBuildSnapshot,
  type AgencyBuildStatus,
} from '../src/api/agency-build';

// The build job's contract (docs/plans/2026-09-20-follow-ups-design.md §6.4, §8 "6b"). The two
// things worth pinning here are the ones a daemon-side refactor could quietly drop: the HTTP error
// codes the endpoints answer with, and the fact that the public event DTO has no field that could
// carry generated text.

describe('agency build error codes', () => {
  it('exposes the two codes the build endpoints answer with', () => {
    expect(API_ERROR_CODES).toEqual(expect.arrayContaining(['BUILD_BUSY', 'BUILD_NOT_FOUND']));
  });

  it('keeps them assignable to ApiErrorCode', () => {
    const busy: ApiErrorCode = 'BUILD_BUSY';
    const missing: ApiErrorCode = 'BUILD_NOT_FOUND';
    expect([busy, missing]).toEqual(['BUILD_BUSY', 'BUILD_NOT_FOUND']);
  });
});

describe('AgencyBuildSnapshot', () => {
  it('accepts every terminal status a build job can end on', () => {
    const statuses: AgencyBuildStatus[] = [
      'queued', 'routing', 'building', 'verifying', 'publishing',
      'done', 'unrouted', 'failed', 'cancelled',
    ];
    expect(statuses).toHaveLength(9);
  });

  it('names the project a failed rollback left behind, beside the fixed error code', () => {
    // `rollback-failed` is the one failure a person has to act on, so the project id has to
    // survive the mapping into the snapshot.
    const snapshot: AgencyBuildSnapshot = {
      id: 'build-1',
      status: 'failed',
      projectId: 'project-1',
      events: [],
      error: { code: 'ROLLBACK_FAILED', message: 'the build failed' },
      startedAt: '2026-09-20T10:00:00.000Z',
      finishedAt: '2026-09-20T10:01:00.000Z',
    };
    expect(snapshot.projectId).toBe('project-1');
    const codes: AgencyBuildErrorCode[] = [
      'JEV_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'BUILD_FAILED', 'VERIFY_FAILED', 'ROLLBACK_FAILED',
    ];
    expect(codes).toHaveLength(5);
  });

  it('is what a list item is, minus the events', () => {
    const snapshot: AgencyBuildSnapshot = {
      id: 'build-1',
      status: 'done',
      events: [{ seq: 1, at: '2026-09-20T10:00:00.000Z', type: 'registered', ms: 1200 }],
      startedAt: '2026-09-20T10:00:00.000Z',
    };
    const { events: _events, ...rest } = snapshot;
    const item: AgencyBuildListItem = rest;
    expect(item).not.toHaveProperty('events');
  });

  it('caps the remembered history', () => {
    expect(AGENCY_BUILD_HISTORY_LIMIT).toBe(50);
  });

  it('records the effective failover setting the build ran with', () => {
    const snapshot: AgencyBuildSnapshot = {
      id: 'build-1',
      status: 'done',
      events: [],
      startedAt: '2026-09-20T10:00:00.000Z',
      failover: false,
    };
    expect(snapshot.failover).toBe(false);
  });
});

describe('AgencyBuildEvent', () => {
  it('carries a repair as a fixed reason code, never the words that refused the unit', () => {
    const repair: AgencyBuildEvent = {
      seq: 3,
      at: '2026-09-20T10:00:03.000Z',
      type: 'repair',
      label: 'hero',
      reason: 'unfaithful',
    };
    expect(repair.reason).toBe('unfaithful');
    // The DTO has no `error`, no `paths` and no `html` field to put generated text in; this is the
    // whole of it.
    expect(Object.keys(repair).sort()).toEqual(['at', 'label', 'reason', 'seq', 'type']);
  });

  it('carries the verify counts', () => {
    const verify: AgencyBuildEvent = {
      seq: 9,
      at: '2026-09-20T10:00:09.000Z',
      type: 'verify',
      ms: 4200,
      counts: { checked: 12, illustrative: 0, flagged: 2, repaired: 2, remaining: 0 },
    };
    expect(verify.counts).toEqual({ checked: 12, illustrative: 0, flagged: 2, repaired: 2, remaining: 0 });
  });
});

describe('AgencyBuildRequest', () => {
  it('needs only a brief', () => {
    const request: AgencyBuildRequest = { brief: 'A dental practice in Riverbend.' };
    expect(request.family).toBeUndefined();
    expect(request.verify).toBeUndefined();
  });

  it('accepts an explicit failover boolean, on top of a brief', () => {
    // Defaults to `true` when omitted (today's behavior); `false` is the G8 matrix's own use case
    // — a live build per family x provider with failover disabled, so a primary failure surfaces
    // as a build failure rather than silently landing on the other provider.
    const withFailoverOff: AgencyBuildRequest = { brief: 'A dental practice in Riverbend.', failover: false };
    const withFailoverOn: AgencyBuildRequest = { brief: 'A dental practice in Riverbend.', failover: true };
    const omitted: AgencyBuildRequest = { brief: 'A dental practice in Riverbend.' };
    expect(withFailoverOff.failover).toBe(false);
    expect(withFailoverOn.failover).toBe(true);
    expect(omitted.failover).toBeUndefined();
  });
});

describe('the AG-UI view of a build', () => {
  it('names the CUSTOM frame that carries each build event', () => {
    expect(AGENCY_BUILD_AGUI_EVENT_NAME).toBe('od.agency-build.event');
  });

  it('carries the brief\'s length and never the brief', () => {
    const input: AgencyBuildAguiInput = {
      family: 'auto', mode: 'sections', verify: 'strict', provider: null, model: null, briefChars: 64,
    };
    // @ts-expect-error — there is no field a brief could travel in.
    const withBrief: AgencyBuildAguiInput = { ...input, brief: 'A family dental practice.' };
    void withBrief;
    const steps: AgencyBuildAguiStepName[] = ['route', 'fill', 'verify', 'publish', 'deploy'];
    const state: Pick<AgencyBuildAguiState, 'input' | 'projectId' | 'verdict'> = { input, projectId: null, verdict: null };
    expect(Object.keys(state.input)).not.toContain('brief');
    expect(steps).toHaveLength(5);
  });
});
