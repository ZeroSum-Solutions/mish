// @vitest-environment jsdom

// Flagship step 4, Improve prompt (B8-1), in the Design Index first-draft card: the card makes the
// first-draft project, opens the shared Improve-prompt dialog on the brief, and the build binds the
// accepted revision. Changing the kit drops the binding (the brief's project is bound to a kit).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { approvedDesignSystemFixtures } from '../helpers/approved-design-systems';
import type { DesignSystemSummary, RouteDecision } from '@open-design/contracts';

vi.mock('../../src/components/workbench/WorkbenchImprovePrompt', () => ({
  WorkbenchImprovePrompt: ({ projectId, draft, onUse }: { projectId: string; draft: string; onUse: (b: unknown) => void }) => (
    <div data-testid="improve-prompt">
      <span data-testid="improve-project">{projectId}</span>
      <span data-testid="improve-draft">{draft}</span>
      <button type="button" onClick={() => onUse({ id: 'brief_1', revision: 2, hash: 'd'.repeat(64) })}>Use prompt</button>
    </div>
  ),
}));

import { FirstDraftCard } from '../../src/components/design-index/FirstDraftCard';
import { I18nProvider } from '../../src/i18n';

const ROUTED = {
  decision: 'routed',
  spine: { code: 'TL', name: 'Trust to lead', confidence: 0.9, probabilities: { TL: 0.9 } },
  spines: [], skin: { choice: 'calm', confidence: 0.6 },
  family: { id: 'practice', probability: 1, basis: 'exact', transfer: 3 },
  candidates: [], warnings: [], ms: 1, calls: 1, model: 'jev',
} as RouteDecision;
let fixtures: Awaited<ReturnType<typeof approvedDesignSystemFixtures>>;
let KITS: DesignSystemSummary[];
beforeAll(async () => {
  fixtures = await approvedDesignSystemFixtures(['Other']);
  KITS = [...fixtures.kits.values()];
}, 120_000);
afterAll(async () => { await fixtures?.stop(); });
const BRIEF = 'Bright Smile Family Dentistry in Portland.';

function mockFetch() {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split('?')[0]!;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const reply = method === 'GET' && url === '/api/design-systems' ? { status: 200, body: { designSystems: KITS } }
      : method === 'POST' && url === '/api/build-on-brand/project' ? { status: 201, body: { projectId: 'bob-empty' } }
      : method === 'POST' && url === '/api/build-on-brand' ? { status: 202, body: { projectId: 'bob-empty', conversationId: 'c', runId: 'r', plan: { pages: [] } } }
      : { status: 200, body: { status: 'running' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pickKit(id: string) {
  const select = await screen.findByTestId('first-draft-kit');
  await waitFor(() => expect(select.querySelector(`option[value="${id}"]`)).not.toBeNull());
  fireEvent.change(select, { target: { value: id } });
}

describe('FirstDraftCard Improve prompt', () => {
  it('makes the project, improves the brief there, and builds bound to the accepted revision', async () => {
    const calls = mockFetch();
    render(<I18nProvider initial="en"><FirstDraftCard brief={BRIEF} decision={ROUTED} sectionHints={{}} pollMs={5} /></I18nProvider>);
    await pickKit('neutral-product');
    fireEvent.click(screen.getByTestId('first-draft-improve'));
    expect(await screen.findByTestId('improve-project')).toHaveProperty('textContent', 'bob-empty');
    expect(screen.getByTestId('improve-draft').textContent).toBe(BRIEF);
    expect(calls.find((call) => call.url === '/api/build-on-brand/project')?.body).toEqual({ designSystemId: 'neutral-product', brief: BRIEF });
    fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
    expect(await screen.findByTestId('first-draft-brief-accepted')).toBeTruthy();
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/build-on-brand')).toBe(true));
    const build = calls.find((call) => call.method === 'POST' && call.url === '/api/build-on-brand')!;
    expect(build.body.designBrief).toEqual({ projectId: 'bob-empty', id: 'brief_1', revision: 2, hash: 'd'.repeat(64) });
  });

  it('drops the accepted brief when the kit changes', async () => {
    const calls = mockFetch();
    render(<I18nProvider initial="en"><FirstDraftCard brief={BRIEF} decision={ROUTED} sectionHints={{}} pollMs={5} /></I18nProvider>);
    await pickKit('neutral-product');
    fireEvent.click(screen.getByTestId('first-draft-improve'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
    await screen.findByTestId('first-draft-brief-accepted');
    await pickKit('user:other');
    expect(screen.queryByTestId('first-draft-brief-accepted')).toBeNull();
    fireEvent.click(screen.getByTestId('first-draft-build'));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url === '/api/build-on-brand')).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.url === '/api/build-on-brand')!.body.designBrief).toBeUndefined();
  });
});
