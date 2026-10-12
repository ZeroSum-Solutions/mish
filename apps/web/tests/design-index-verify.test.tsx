// @vitest-environment jsdom

// The Route panel's verify-after verdict and repair button (`docs/plans/2026-09-22-generative-
// ui-plan-part-2.md` Task 7). `agency-build.ts` (daemon) and the contracts already carry `verify:
// 'after'` and `POST .../:id/repair` — this covers only what the Route panel does with them: a
// verify-mode select in place of the old advisory checkbox, a verdict line built from `build.
// verify` and the last `verify` event's own counts, the flagged-path list, and the repair button.
//
// The daemon's real `EventSource` never runs here: a fake one is stubbed in, and `streamHandlers`
// drives it with the AG-UI frames `GET .../:id/agui` would send (a CUSTOM frame per build event,
// then the final state and RUN_FINISHED / RUN_ERROR).

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgencyBuildEvent,
  AgencyBuildListItem,
  AgencyBuildRepairResponse,
  AgencyBuildSnapshot,
  RouteDecision,
} from '@open-design/contracts';

const registryMocks = vi.hoisted(() => {
  class AgencyBuildRepairError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AgencyBuildRepairError';
      this.code = code;
    }
  }
  return {
    listAgencyBuilds: vi.fn(),
    startAgencyBuild: vi.fn(),
    fetchAgencyBuild: vi.fn(),
    forkAgencyBuild: vi.fn(),
    cancelAgencyBuild: vi.fn(),
    agencyBuildEvents: vi.fn(),
    repairAgencyBuild: vi.fn(),
    fetchAgencyFamilySections: vi.fn(async () => []),
    fetchAgencyFamilyEffects: vi.fn(async () => ({ ok: false as const })),
    fetchSections: vi.fn(async () => ({ ok: false as const })),
    fetchMotionSitesConnectionStatus: vi.fn(async () => null),
    AgencyBuildRepairError,
  };
});

vi.mock('../src/providers/registry', () => registryMocks);

import { DesignIndexView } from '../src/components/DesignIndexView';
import { emitBuildEnd, emitBuildEvent } from './helpers/agency-build-agui-frames';

/** A stand-in `EventSource` that hands its frames straight to the view's listener. */
class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners: Array<(event: MessageEvent) => void> = [];
  constructor(public url: string) {
    streamHandlers = {
      onEvent: (event) => emitBuildEvent(this, event),
      onStatus: (build) => emitBuildEnd(this, build),
    };
  }
  addEventListener(_name: string, handler: (event: MessageEvent) => void) {
    this.listeners.push(handler);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(_name: string, data: unknown) {
    for (const handler of this.listeners) handler({ data: JSON.stringify(data) } as MessageEvent);
  }
}

type StreamHandlers = {
  onEvent: (event: AgencyBuildEvent) => void;
  onStatus: (build: AgencyBuildSnapshot) => void;
  onError?: () => void;
};

const ROUTED_DECISION: RouteDecision = {
  decision: 'routed',
  spine: { code: 'TL', name: 'Testline', confidence: 0.9, probabilities: {} },
  spines: [],
  skin: { choice: 'Minimal', confidence: 0.8 },
  family: { id: 'crm-dashboard', probability: 0.9, basis: 'exact', transfer: 1 },
  candidates: [],
  warnings: [],
  ms: 10,
  calls: 1,
  model: 'jev',
};

const QUEUED_BUILD: AgencyBuildSnapshot = {
  id: 'build-1',
  status: 'queued',
  family: 'crm-dashboard',
  events: [],
  startedAt: '2026-09-22T00:00:00.000Z',
};

const FLAGGED_PATHS = ['crm-dashboard-kpis--kpis-1--value', 'crm-dashboard-contact--email'];

// Fixtures for test (f): a second, already-published build a person could start a new build
// from via "Start from this build" — a path that reaches `attachBuild` without going through the
// Run button, and so is never gated by the Run button's own `repairing` disable.
const RECENT_BUILD_ITEM: AgencyBuildListItem = {
  id: 'build-2',
  status: 'done',
  family: 'crm-dashboard',
  projectId: 'project-2',
  startedAt: '2026-09-22T00:00:00.000Z',
  finishedAt: '2026-09-22T00:00:05.000Z',
};

const FORKED_BUILD: AgencyBuildSnapshot = {
  id: 'build-3',
  status: 'queued',
  family: 'crm-dashboard',
  events: [],
  startedAt: '2026-09-22T00:01:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function verifyEvent(fields: Partial<AgencyBuildEvent>): AgencyBuildEvent {
  return { seq: 1, at: '2026-09-22T00:00:01.000Z', type: 'verify', ...fields };
}

let streamHandlers: StreamHandlers | null = null;

beforeEach(() => {
  streamHandlers = null;
  registryMocks.listAgencyBuilds.mockReset().mockResolvedValue([]);
  registryMocks.startAgencyBuild.mockReset().mockResolvedValue({ ok: true, build: QUEUED_BUILD });
  registryMocks.fetchAgencyBuild.mockReset().mockResolvedValue(null);
  registryMocks.forkAgencyBuild.mockReset();
  registryMocks.cancelAgencyBuild.mockReset().mockResolvedValue(undefined);
  registryMocks.repairAgencyBuild.mockReset();
  vi.stubGlobal('EventSource', FakeEventSource);

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/agency/route')) {
      return jsonResponse(200, { decision: ROUTED_DECISION });
    }
    return jsonResponse(500, {});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders the view, opens the Route panel, routes the fixed brief, and returns once the Build
 * panel (with a routed family) is on screen. */
async function routeToBuildPanel() {
  render(<DesignIndexView />);
  fireEvent.click(screen.getByTestId('design-index-panel-route'));
  fireEvent.change(screen.getByTestId('design-index-route-brief'), {
    target: { value: 'A CRM dashboard for a small sales team.' },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('design-index-route-run'));
    await Promise.resolve();
    await Promise.resolve();
  });
  await screen.findByTestId('design-index-build');
}

/** Continues from `routeToBuildPanel`: sets verify mode to `after` and presses Run, landing on
 * the attached (queued) build with its event stream captured in `streamHandlers`. */
async function startAfterBuild() {
  fireEvent.change(screen.getByTestId('design-index-build-verify-mode'), { target: { value: 'after' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('design-index-build-run'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(streamHandlers).not.toBeNull();
}

describe('Route panel — verify-after verdict and repair', () => {
  it('(a) verify mode select defaults to strict, offers three modes, and after→run sends verify: "after"', async () => {
    await routeToBuildPanel();

    const select = screen.getByTestId('design-index-build-verify-mode') as HTMLSelectElement;
    expect(select.value).toBe('strict');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['strict', 'advisory', 'after']);

    await startAfterBuild();

    expect(registryMocks.startAgencyBuild).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'crm-dashboard', verify: 'after' }),
    );
  });

  it('(b2) a verdict names the illustrative slots the check skipped', async () => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: { checked: 14, illustrative: 69, flagged: 0, repaired: 0, remaining: 0 } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: [] },
      });
    });

    expect(screen.getByTestId('design-index-build-verdict')).toHaveTextContent('Checked 14 slots, nothing flagged · 69 illustrative, not fact-checked');
  });

  // A verdict whose event carries no count (a build persisted before it existed) says so; it
  // never reads as a build that skipped nothing.
  it.each([
    ['absent', { checked: 14, flagged: 0, repaired: 0, remaining: 0 }, 'Checked 14 slots, nothing flagged · illustrative count not reported'],
    ['0', { checked: 14, illustrative: 0, flagged: 0, repaired: 0, remaining: 0 }, 'Checked 14 slots, nothing flagged'],
  ])('(b3) a verdict with the illustrative count %s', async (_label, counts, text) => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: counts as { checked: number; illustrative: number; flagged: number; repaired: number; remaining: number } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: [] },
      });
    });

    expect(screen.getByTestId('design-index-build-verdict').textContent).toBe(text);
  });

  it('(b) a done verdict with flagged paths reads "2 of 82 slots unverified" and lists both paths', async () => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: { checked: 82, illustrative: 0, flagged: 2, repaired: 0, remaining: 2 } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: FLAGGED_PATHS },
      });
    });

    expect(screen.getByTestId('design-index-build-verdict')).toHaveTextContent('2 of 82 slots unverified');
    const list = screen.getByTestId('design-index-build-flagged');
    for (const path of FLAGGED_PATHS) {
      expect(within(list).getByText(path)).toBeInTheDocument();
    }
  });

  it('(c) repair calls repairAgencyBuild(buildId), shows "Repairing…" while pending, then "Repaired 2, 0 remaining" and empties the list', async () => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: { checked: 82, illustrative: 0, flagged: 2, repaired: 0, remaining: 2 } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: FLAGGED_PATHS },
      });
    });

    let resolveRepair!: (value: AgencyBuildRepairResponse) => void;
    registryMocks.repairAgencyBuild.mockReturnValue(
      new Promise<AgencyBuildRepairResponse>((resolve) => { resolveRepair = resolve; }),
    );
    registryMocks.fetchAgencyBuild.mockResolvedValue({
      ...QUEUED_BUILD,
      status: 'done',
      finishedAt: '2026-09-22T00:00:02.000Z',
      verify: { status: 'done', flagged: [] },
    });

    fireEvent.click(screen.getByTestId('design-index-build-repair'));
    expect(registryMocks.repairAgencyBuild).toHaveBeenCalledWith('build-1');
    await screen.findByText('Repairing…');

    await act(async () => {
      resolveRepair({ repaired: FLAGGED_PATHS, remaining: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('design-index-build-verdict')).toHaveTextContent('Repaired 2, 0 remaining');
    expect(screen.queryByTestId('design-index-build-flagged')).not.toBeInTheDocument();
  });

  it('(d) a verify event with reason "cancelled" and a skipped verdict renders the skipped text', async () => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ reason: 'cancelled' }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'cancelled',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'skipped', flagged: [] },
      });
    });

    expect(screen.getByTestId('design-index-build-verdict')).toHaveTextContent('Check skipped: cancelled');
  });

  it('(e) a repair rejected with BUILD_REPAIR_IN_PROGRESS renders that error and leaves the flagged list', async () => {
    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: { checked: 82, illustrative: 0, flagged: 2, repaired: 0, remaining: 2 } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: FLAGGED_PATHS },
      });
    });

    registryMocks.repairAgencyBuild.mockRejectedValue(
      new registryMocks.AgencyBuildRepairError('BUILD_REPAIR_IN_PROGRESS', 'a repair for this build is already running'),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('design-index-build-repair'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('A repair is already running')).toBeInTheDocument();
    const list = screen.getByTestId('design-index-build-flagged');
    for (const path of FLAGGED_PATHS) {
      expect(within(list).getByText(path)).toBeInTheDocument();
    }
  });

  it('(f) a build attached while a repair is pending is not overwritten when that repair resolves', async () => {
    registryMocks.listAgencyBuilds.mockResolvedValue([RECENT_BUILD_ITEM]);
    registryMocks.forkAgencyBuild.mockResolvedValue({ ok: true, build: FORKED_BUILD });

    await routeToBuildPanel();
    await startAfterBuild();

    await act(async () => {
      streamHandlers!.onEvent(verifyEvent({ counts: { checked: 82, illustrative: 0, flagged: 2, repaired: 0, remaining: 2 } }));
    });
    await act(async () => {
      streamHandlers!.onStatus({
        ...QUEUED_BUILD,
        status: 'done',
        finishedAt: '2026-09-22T00:00:02.000Z',
        verify: { status: 'done', flagged: FLAGGED_PATHS },
      });
    });

    // "Start from this build" reaches `attachBuild` exactly the way the Run button does, but —
    // unlike Run — is never disabled by `repairing`, so it is the live path this guard defends.
    await screen.findByTestId('design-index-recent-build-start-from');

    let resolveRepair!: (value: AgencyBuildRepairResponse) => void;
    registryMocks.repairAgencyBuild.mockReturnValue(
      new Promise<AgencyBuildRepairResponse>((resolve) => { resolveRepair = resolve; }),
    );

    fireEvent.click(screen.getByTestId('design-index-build-repair'));
    expect(registryMocks.repairAgencyBuild).toHaveBeenCalledWith('build-1');
    await screen.findByText('Repairing…');

    // (b) the Run button and the verify-mode select refuse a second build while this repair runs.
    expect(screen.getByTestId('design-index-build-run')).toBeDisabled();
    expect(screen.getByTestId('design-index-build-verify-mode')).toBeDisabled();

    // Attach a different build — build-1's repair is still in flight.
    await act(async () => {
      fireEvent.click(screen.getByTestId('design-index-recent-build-start-from'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The panel now watches build-3, which has no verdict of its own yet.
    expect(screen.queryByTestId('design-index-build-verdict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-index-build-flagged')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-index-build-repair')).not.toBeInTheDocument();

    // build-1's repair now resolves. (a) the guard must see build-3 attached and bail out before
    // ever reading or writing state that belongs to build-1.
    await act(async () => {
      resolveRepair({ repaired: FLAGGED_PATHS, remaining: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(registryMocks.repairAgencyBuild).toHaveBeenCalledTimes(1);
    expect(registryMocks.fetchAgencyBuild).not.toHaveBeenCalled();
    expect(screen.queryByText(/Repaired/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-index-build-verdict')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-index-build-flagged')).not.toBeInTheDocument();
  });
});
