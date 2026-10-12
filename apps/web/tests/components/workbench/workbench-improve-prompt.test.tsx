// @vitest-environment jsdom
// AC-R15.2 web surface: Improve prompt shows the original, assumptions,
// questions and an editable transformed brief before Use prompt; reference
// proposals are a reviewable diff; failure and cancel keep the original. The
// panel uses the same /api/workbench/briefs endpoints as `od workbench transform`.
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignBrief, DesignBriefRecordView, WorkspaceCollabContext } from '@open-design/contracts';
import { homeBriefPreview } from '../../helpers/home-brief-preview';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchImprovePrompt } from '../../../src/components/workbench/WorkbenchImprovePrompt';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const at = '2026-10-08T10:00:00.000Z';
const field = (value: string | null, basis: DesignBrief['audience']['basis'] = 'assumed') => ({ value, basis });
function brief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  return {
    schema: 'design-brief/1', id: 'brief_1', revision: 1, projectId: 'p', state: 'draft',
    originalText: 'A Windows 95 bakery site.', contextRevision: null, rubricRevision: null,
    audience: field('Neighbours', 'stated'), purpose: field('Show the menu', 'stated'), conversion: field(null),
    sections: [{ name: 'Hero', purpose: null, basis: 'assumed' }],
    design: { typography: field('Pixel font'), color: field('Teal desktop'), spacing: field(null), layout: field('Windows'), motion: field('None') },
    responsive: field('Stack on phones'), accessibility: field('AA contrast'), implementationConstraints: [],
    intent: { styleDirections: ['Windows 95'], targetRuntime: null },
    resourceRefs: [], references: [{ ref: { sourceType: 'reference', sourceId: 'design-md', itemId: 'stripe', revisionOrDigest: 'sha-1' }, title: 'Stripe', attribution: 'Awesome DESIGN.md (MIT)', excerptOmitted: false }],
    referenceChanges: [{ id: 'chg_1', path: 'design.color', oldValue: 'Teal desktop', proposedValue: 'One saturated accent', rationale: 'From Stripe', refs: [{ sourceType: 'reference', sourceId: 'design-md', itemId: 'stripe', revisionOrDigest: 'sha-1' }], conflict: false, status: 'proposed', contrast: [{ foreground: '#777777', background: '#888888', ratio: 1.3, passesAA: false }] }],
    assumptions: ['Opening hours were not given'], questions: ['What is the main call to action?'],
    userEditedPaths: [], renderedPrompt: 'rendered', rendererVersion: 'design-brief-renderer/1', hash: 'a'.repeat(64), createdAt: at,
    ...overrides,
  };
}
function record(b: DesignBrief | null, status: DesignBriefRecordView['status'] = 'ready', failure: DesignBriefRecordView['failure'] = null): DesignBriefRecordView {
  return { id: 'brief_1', projectId: 'p', status, originalText: 'A Windows 95 bakery site.', brief: b, failure, revisions: b ? Array.from({ length: b.revision }, (_, i) => i + 1) : [], createdAt: at, updatedAt: at };
}
const ui = (props: Partial<Parameters<typeof WorkbenchImprovePrompt>[0]> = {}) => render(
  <I18nProvider initial="en"><WorkbenchImprovePrompt projectId="p" draft="A Windows 95 bakery site." onUse={vi.fn()} onClose={vi.fn()} pollMs={1} {...props} /></I18nProvider>,
);

describe('WorkbenchImprovePrompt', () => {
  it('shows unverified and contradicted field and section reasons before Use prompt', async () => {
    const result = brief({
      audience: { value: 'Neighbours', basis: 'unverified', groundingReason: 'Grounding checker unavailable. Confirm this audience.' },
      purpose: { value: 'Open Sundays', basis: 'assumed', groundingReason: 'Contradicted: the brief says not open Sundays.' },
      sections: [{ name: 'Sunday opening', purpose: null, basis: 'unverified', groundingReason: 'The section could not be verified.' }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(record(result)), { status: 202 })));
    ui();
    expect(await screen.findByText('Grounding checker unavailable. Confirm this audience.')).toBeTruthy();
    expect(screen.getAllByText('Unverified')).toHaveLength(2);
    expect(screen.getByText('Contradicted: the brief says not open Sundays.')).toBeTruthy();
    expect(screen.getByText('The section could not be verified.', { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Closed Sundays' } });
    expect(screen.queryByText('Contradicted: the brief says not open Sundays.')).toBeNull();
  });

  it('shows original, assumptions, questions and the transformed brief; edits and Use prompt bind the accepted revision', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let current = record(null, 'pending');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (method === 'POST' && url === '/api/workbench/briefs') return new Response(JSON.stringify(current), { status: 202 });
      if (method === 'GET') { current = record(brief()); return new Response(JSON.stringify(current)); }
      if (method === 'PATCH' && body.accept) { current = record(brief({ revision: 3, state: 'accepted', hash: 'b'.repeat(64) })); return new Response(JSON.stringify(current)); }
      if (method === 'PATCH') { current = record(brief({ revision: 2, purpose: field('Take orders', 'user'), userEditedPaths: ['purpose'] })); return new Response(JSON.stringify(current)); }
      return new Response('{}', { status: 500 });
    }));
    const onUse = vi.fn();
    const onClose = vi.fn();
    ui({ onUse, onClose });
    expect(await screen.findByTestId('improve-prompt-original')).toHaveTextContent('A Windows 95 bakery site.');
    expect(await screen.findByText('Opening hours were not given')).toBeTruthy();
    expect(screen.getByText('What is the main call to action?')).toBeTruthy();
    expect(screen.getByTestId('improve-prompt-style')).toHaveTextContent('Windows 95');
    expect(calls[0]).toMatchObject({ url: '/api/workbench/briefs', method: 'POST', body: { projectId: 'p', originalText: 'A Windows 95 bakery site.' } });

    // Reference proposals are a reviewable diff with attribution and contrast evidence.
    const diff = screen.getByTestId('improve-prompt-change-chg_1');
    expect(diff).toHaveTextContent('Teal desktop');
    expect(diff).toHaveTextContent('One saturated accent');
    expect(diff).toHaveTextContent('Stripe');
    expect(diff).toHaveTextContent('1.3');

    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Take orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && (c.body as { edits?: Record<string, unknown> }).edits?.purpose === 'Take orders')).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith({ id: 'brief_1', revision: 3, hash: 'b'.repeat(64) }));
    expect(onClose).not.toHaveBeenCalled();
    expect(calls.find(c => c.method === 'PATCH' && (c.body as { accept?: boolean }).accept)!.body).toEqual({ expectedRevision: 2, accept: true });
  });

  it('accepts a proposed reference change through PATCH', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, body });
      return new Response(JSON.stringify(record(brief())), { status: method === 'POST' ? 202 : 200 });
    }));
    ui();
    const diff = await screen.findByTestId('improve-prompt-change-chg_1');
    fireEvent.click(diff.querySelector('button[data-decision="accepted"]')!);
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PATCH', body: { expectedRevision: 1, referenceDecisions: [{ id: 'chg_1', status: 'accepted' }] } }));
  });

  it('on failure keeps the original text and offers it back unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(record(null, 'failed', { code: 'transformer-unavailable', message: 'The Claude Code CLI is not installed', recovery: 'Use your original prompt.' })), { status: init?.method === 'POST' ? 202 : 200 })));
    const onClose = vi.fn();
    ui({ onClose });
    expect(await screen.findByText('The Claude Code CLI is not installed')).toBeTruthy();
    expect(screen.getByTestId('improve-prompt-original')).toHaveTextContent('A Windows 95 bakery site.');
    expect(screen.queryByRole('button', { name: 'Use prompt' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep original' }));
    expect(onClose).toHaveBeenCalled();
  });

  // The web app runs with reactStrictMode (next.config.ts), which mounts, unmounts and remounts
  // every component once in development. The dialog must still follow the pending brief to ready.
  it('follows a pending brief to ready under React StrictMode', async () => {
    let current = record(null, 'pending');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === '/api/workbench/briefs') return new Response(JSON.stringify(current), { status: 202 });
      if (method === 'GET') { current = record(brief()); return new Response(JSON.stringify(current)); }
      return new Response('{}', { status: 500 });
    }));
    render(
      <StrictMode>
        <I18nProvider initial="en"><WorkbenchImprovePrompt projectId="p" draft="A Windows 95 bakery site." onUse={vi.fn()} onClose={vi.fn()} pollMs={1} /></I18nProvider>
      </StrictMode>,
    );
    expect(await screen.findByText('Opening hours were not given')).toBeTruthy();
  });
});

it('finds references from generated sections and unsaved edits, then discards stale results', async () => {
  const { referenceFanout } = await import('../../helpers/reference-fanout');
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === '/api/workbench/briefs') return new Response(JSON.stringify(record(brief())));
    if (url === '/api/workbench/references/fanout') return new Response(JSON.stringify(referenceFanout()));
    throw new Error('Unexpected request');
  }));
  ui({ spineCode: 'TL' });
  await screen.findByLabelText(/Sections/);
  expect(calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(calls[1]?.body).toMatchObject({ spineCode: 'TL', sections: [{ id: 'section-1', name: 'Hero', purpose: null }] });
  fireEvent.change(screen.getByLabelText(/Sections/), { target: { value: 'Services: Explain treatment\nContact: Book an appointment' } });
  expect(screen.queryByRole('link', { name: 'Dental practice' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Book local patients' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(calls[2]?.body).toMatchObject({ sections: [{ id: 'section-1', name: 'Services', purpose: 'Explain treatment' }, { id: 'section-2', name: 'Contact', purpose: 'Book an appointment' }] });
  expect(calls[2]?.body?.brief).toContain('purpose: Book local patients');
});

it('lets an empty generated section list use suggested spine sections', async () => {
  const { referenceFanout } = await import('../../helpers/reference-fanout');
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return new Response(JSON.stringify(url === '/api/workbench/briefs' ? record(brief({ sections: [] })) : referenceFanout()));
  }));
  ui();
  await screen.findByLabelText(/Sections/);
  const button = screen.getByRole('button', { name: 'Find references' });
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(calls.find(call => call.url.includes('/references/'))?.body).not.toHaveProperty('sections');
});

it('starts only one project-less transformer turn under StrictMode', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(homeBriefPreview)));
  vi.stubGlobal('fetch', fetchMock);
  const onUsePreview = vi.fn();
  render(<StrictMode><I18nProvider initial="en"><WorkbenchImprovePrompt draft="A bakery site" onUsePreview={onUsePreview} onClose={vi.fn()} /></I18nProvider></StrictMode>);
  fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]).toEqual(['/api/workbench/briefs/preview', expect.objectContaining({ method: 'POST' })]);
  expect(onUsePreview).toHaveBeenCalledWith(homeBriefPreview);
});

it('keeps an in-flight preview when the same workspace context is refreshed, but aborts on identity change', async () => {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal);
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const context = { workspaceId: 'workspace_1', workspaceMemberId: 'member_1', workspaceType: 'team', role: 'member', lifecycleState: 'active', memberStatus: 'active', permissions: { canShareProjects: true, canWriteSyncedFiles: true } } as WorkspaceCollabContext;
  const panel = (workspaceContext: WorkspaceCollabContext) => <I18nProvider initial="en"><WorkbenchImprovePrompt draft="A bakery site" workspaceContext={workspaceContext} onClose={vi.fn()} /></I18nProvider>;
  const view = render(panel(context));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  view.rerender(panel({ ...context }));
  await Promise.resolve();
  expect(signals[0]!.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  view.rerender(panel({ ...context, workspaceId: 'workspace_2' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(signals[0]!.aborted).toBe(true);
});
