// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspacePermissions, type CaptureDraftRevision, type CaptureView, type WorkspaceCollabContext } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchCaptureHub } from '../../../src/components/workbench/WorkbenchCaptureHub';
import { WorkbenchCaptureDraftPanel } from '../../../src/components/workbench/WorkbenchCaptureDraftPanel';

const capture: CaptureView = {
  capture: {
    schema: 'workbench-capture/1', id: 'cap_AAAAAAAAAAAAAAAAAAAA', assetId: 'asset-1', projectId: 'p1', captureMode: 'upload',
    sourceUrl: 'https://example.com/pricing', sourceUrlRedacted: false, sourceTitle: 'Pricing', viewport: null,
    frame: { width: 640, height: 400 }, region: null, image: { mediaType: 'image/png', width: 640, height: 400, bytes: 100 },
    contentHash: 'a'.repeat(64), capturePermission: 'user-supplied-file', rightsDeclaration: null, rightsDeclaredVia: null,
    parentCaptureId: null, createdAt: '2026-10-09T10:00:00.000Z',
  }, bytesAvailable: true, imageUrl: '/api/workbench/captures/cap_AAAAAAAAAAAAAAAAAAAA/image?projectId=p1',
};
const revision = (number = 1): Extract<CaptureDraftRevision, { status: 'ready' }> => ({
  schema: 'capture-draft/1', draftId: 'draft_AAAAAAAAAAAAAAAAAAAA', projectId: 'p1', captureId: capture.capture.id,
  revision: number, parentRevision: number === 1 ? null : number - 1, createdAt: '2026-10-09T11:00:00.000Z', status: 'ready',
  prompt: 'Build pricing', html: `<html><head></head><body><section id="pricing">Revision ${number}</section></body></html>`,
  outputSha256: 'b'.repeat(64), assumptions: ['The font is approximated.'], failure: null,
  generator: { provider: 'claude-max', modelId: 'claude-opus-5-5', billingLane: 'max-subscription' },
});
const workspace: WorkspaceCollabContext = { workspaceId: 'w1', workspaceMemberId: 'm1', role: 'owner', workspaceType: 'team', lifecycleState: 'active', memberStatus: 'active', billingState: 'active', planId: 'team', providerMode: 'platform_credits', seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false }, permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }) };
let drafts: CaptureDraftRevision[];
let calls: Array<{ url: string; init: RequestInit }>;
let nextResult: CaptureDraftRevision;
let pollResult: CaptureDraftRevision;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  drafts = [revision()]; nextResult = revision(2); pollResult = revision(2); calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.startsWith('/api/workbench/capture-drafts?')) return json({ drafts });
    if (url === '/api/workbench/capture-drafts' && init.method === 'POST') { drafts = [...drafts, nextResult]; return json(nextResult, 201); }
    if (url.startsWith('/api/workbench/capture-drafts/')) return json(pollResult);
    if (url.startsWith('/api/workbench/captures?')) return json({ projectId: 'p1', captures: [capture], nextCursor: null });
    if (url.startsWith('/api/workbench/captures/')) return json(capture);
    if (url === '/api/workbench/units') return json({ units: [] });
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const editor = () => <I18nProvider initial="en"><WorkbenchCaptureDraftPanel projectId="p1" captureId={capture.capture.id} workspaceContext={workspace} onClose={vi.fn()} /></I18nProvider>;

describe('AC-R14.2 persistent capture drafts', () => {
  it('discloses EXIF/GPS removal beside the model submission controls', async () => {
    render(editor());
    await screen.findByTitle('Draft preview');
    const instructions = screen.getByLabelText('Draft instructions');
    const disclosure = document.getElementById(instructions.getAttribute('aria-describedby')!);
    expect(disclosure?.textContent).toMatch(/EXIF.*GPS.*removed.*before/i);
  });

  it('clears the previous workspace preview and ignores an in-flight create result after the member changes', async () => {
    const implementation = vi.mocked(fetch).getMockImplementation()!;
    let resolveCreate!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/workbench/capture-drafts') return new Promise<Response>(resolve => { resolveCreate = resolve; });
      if (String(input).startsWith('/api/workbench/capture-drafts?') && (init?.headers as Record<string, string>)['x-od-workspace-member-id'] === 'm2') return json({ drafts: [] });
      return implementation(input, init);
    });
    const mounted = render(editor());
    await screen.findByTitle('Draft preview');
    fireEvent.change(screen.getByLabelText('Draft instructions'), { target: { value: 'Old workspace instructions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iterate draft' }));
    mounted.rerender(<I18nProvider initial="en"><WorkbenchCaptureDraftPanel projectId="p1" captureId={capture.capture.id} workspaceContext={{ ...workspace, workspaceMemberId: 'm2' }} onClose={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(screen.queryByTitle('Draft preview')).toBeNull());
    await act(async () => { resolveCreate(json(revision(2))); });
    expect(screen.queryByTitle('Draft preview')).toBeNull();
    expect((screen.getByLabelText('Draft instructions') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Draft instructions'), { target: { value: 'New workspace instructions' } });
    expect((screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens a saved capture and restores original, current output, assumptions and historical revisions after reopening', async () => {
    drafts = [revision(2), revision()];
    const mounted = render(<I18nProvider initial="en"><WorkbenchCaptureHub projectId="p1" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Create or resume draft' }));
    const frame = await screen.findByTitle('Draft preview');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'");
    expect(frame.getAttribute('srcdoc')).toContain('Revision 2');
    expect(screen.getByAltText('Original capture').getAttribute('src')).toBe(capture.imageUrl);
    expect(screen.getByText('The font is approximated.')).toBeTruthy();
    expect(screen.getByText(/specify hidden behavior/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Draft revision'), { target: { value: `${revision().draftId}:1` } });
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Revision 1'));
    mounted.unmount();
    render(<I18nProvider initial="en"><WorkbenchCaptureHub projectId="p1" /></I18nProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Drafts' }));
    const list = await screen.findByTestId('workbench-draft-library');
    expect(within(list).getAllByRole('button', { name: /Resume draft/ })).toHaveLength(2);
    fireEvent.click(within(list).getAllByRole('button', { name: /Resume draft/ })[1]!);
    expect((await screen.findByTitle('Draft preview')).getAttribute('srcdoc')).toContain('Revision 1');
  });

  it('creates a new draft from a capture and iterates with the selected parent and workspace authority', async () => {
    drafts = []; nextResult = revision();
    render(editor());
    const instructions = await screen.findByLabelText('Draft instructions');
    expect(within(instructions.closest('form')!).getByText(/Your screenshot and instructions are sent to Claude Code Max.*EXIF.*GPS.*removed before/)).toBeTruthy();
    fireEvent.change(instructions, { target: { value: 'Build pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByTitle('Draft preview');
    const first = calls.find(call => call.init.method === 'POST')!;
    expect(JSON.parse(String(first.init.body))).toEqual({ projectId: 'p1', captureId: capture.capture.id, prompt: 'Build pricing' });
    const headers = first.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(headers['x-od-project-id']).toBe('p1');
    expect(headers['x-od-workspace-id']).toBe('w1');
    nextResult = revision(2);
    fireEvent.change(screen.getByLabelText('Draft instructions'), { target: { value: 'Make prices larger' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iterate draft' }));
    await waitFor(() => expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(2));
    expect(JSON.parse(String(calls.filter(call => call.init.method === 'POST')[1]!.init.body))).toMatchObject({ prompt: 'Make prices larger', parent: { draftId: revision().draftId, revision: 1 } });
  });

  it('polls a pending revision, shows a terminal failure and preserves the ready revision for retry', async () => {
    nextResult = { ...revision(2), status: 'pending', html: null, outputSha256: null, assumptions: [] };
    pollResult = { ...revision(2), status: 'failed', html: null, outputSha256: null, failure: { reason: 'provider-unavailable', message: 'Claude is unavailable.', recovery: 'Sign in and retry.' } };
    render(editor());
    await screen.findByTitle('Draft preview');
    fireEvent.change(screen.getByLabelText('Draft instructions'), { target: { value: 'Add hover action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iterate draft' }));
    expect((await screen.findByRole('status')).textContent).toBe('Generating draft…');
    expect((await screen.findByRole('alert', {}, { timeout: 3500 })).textContent).toContain('Sign in and retry.');
    expect((screen.getByLabelText('Draft instructions') as HTMLTextAreaElement).value).toBe('Build pricing');
    expect((screen.getByRole('button', { name: 'Retry draft' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Draft revision'), { target: { value: `${revision().draftId}:1` } });
    expect((await screen.findByTitle('Draft preview')).getAttribute('srcdoc')).toContain('Revision 1');
    expect(screen.getByRole('button', { name: 'Iterate draft' })).toBeTruthy();
  });

  it('keeps the instructions and idempotency key when a create response is lost, and lets the user recover the saved revision', async () => {
    drafts = [];
    const implementation = vi.mocked(fetch).getMockImplementation()!;
    let lost = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/workbench/capture-drafts' && lost) {
        calls.push({ url: String(input), init: init ?? {} }); lost = false; throw new Error('Connection lost');
      }
      return implementation(input, init);
    });
    nextResult = revision(); render(editor());
    fireEvent.change(await screen.findByLabelText('Draft instructions'), { target: { value: 'Build pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByTitle('Draft preview');
    const posts = calls.filter(call => call.init.method === 'POST');
    expect((posts[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe((posts[1]!.init.headers as Record<string, string>)['idempotency-key']);
  });
});
