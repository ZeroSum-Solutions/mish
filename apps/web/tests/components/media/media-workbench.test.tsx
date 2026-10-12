// @vitest-environment jsdom
// AC-R10.1 / AC-R10.2 canvas media workbench (B6-3). Every spec drives the
// B5-3 HTTP surface (`/api/media/models`, `/api/projects/:id/media/generate`,
// `/api/media/tasks/:id/{cancel,retry}`, `/api/projects/:id/media/gallery…`)
// through a mocked fetch. No spec reaches a provider: the owner hold on image
// and video generation runs until 2026-10-29.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaGalleryEntry, MediaGalleryEntryDetail, MediaGalleryResponse, ProjectFile } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { MediaWorkbench, MediaWorkbenchPanel } from '../../../src/components/media/MediaWorkbench';
import { MediaEntryRow } from '../../../src/components/media/MediaEntryRow';
import { listProjects } from '../../../src/state/projects';

vi.mock('../../../src/state/projects', async (original) => ({
  ...await original<typeof import('../../../src/state/projects')>(),
  listProjects: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const CREATED = Date.UTC(2026, 9, 8, 10, 0, 0);

function entry(over: Partial<MediaGalleryEntry> = {}): MediaGalleryEntry {
  return {
    id: 't1',
    projectId: 'p',
    kind: 'image',
    status: 'done',
    createdAt: CREATED,
    endedAt: CREATED + 5_000,
    provenance: { providerId: 'fal', model: 'fal/flux', promptDigest: null, stub: false },
    lineage: { rootId: 't1', parentId: null, relation: 'original', attempt: 1, parentInProject: true },
    file: { name: 'hero.png', mime: 'image/png', kind: 'image', size: 10 },
    output: { state: 'current', recordedName: 'hero.png' },
    unlinked: false,
    replayable: true,
    ...over,
  };
}

const CATALOG = {
  providers: [
    { id: 'fal', label: 'Fal', hint: '', integrated: true },
    { id: 'stub', label: 'Stub', hint: '', integrated: false },
  ],
  image: [
    { id: 'fal/flux', label: 'Flux', hint: '', provider: 'fal', caps: ['t2i'] },
    { id: 'fal/flux-edit', label: 'Flux Edit', hint: '', provider: 'fal', caps: ['t2i', 'i2i'] },
    { id: 'stub/image', label: 'Stub image', hint: '', provider: 'stub', caps: ['t2i'] },
  ],
  video: [
    { id: 'fal/kling', label: 'Kling', hint: '', provider: 'fal', caps: ['t2v', 'i2v'] },
  ],
  audio: { music: [], speech: [], sfx: [] },
  aspects: ['1:1', '16:9', '9:16'],
  videoLengthsSec: [5, 10],
  audioDurationsSec: [],
};

const FILES = [
  { name: 'ref.png', kind: 'image', mime: 'image/png', size: 1, mtime: 1 },
  { name: 'index.html', kind: 'html', mime: 'text/html', size: 1, mtime: 1 },
] as ProjectFile[];

type Call = { url: string; method: string; headers: Headers; body: unknown };
type Handler = (call: Call) => Response | Promise<Response> | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stub fetch: the catalogue and an empty gallery answer by default; `handler` overrides. */
function stubFetch(gallery: MediaGalleryResponse | ((url: URL) => MediaGalleryResponse), handler: Handler = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const call: Call = {
      url: input,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const custom = handler(call);
    if (custom) return custom;
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/media/models') return json(CATALOG);
    if (url.pathname === '/api/projects/p/media/gallery') {
      return json(typeof gallery === 'function' ? gallery(url) : gallery);
    }
    return json({ error: { code: 'NOT_MOCKED', message: `${call.method} ${input}` } }, 500);
  }));
  return calls;
}

function page(entries: MediaGalleryEntry[], nextCursor: string | null = null): MediaGalleryResponse {
  return { entries, nextCursor, limit: 50 };
}

function renderPanel() {
  return render(<I18nProvider><MediaWorkbenchPanel projectId="p" files={FILES} pollMs={0} /></I18nProvider>);
}

const row = (id: string) => screen.findByTestId(`media-entry-${id}`);

describe('MediaWorkbench — creation form (AC-R10.1)', () => {
  it('creates through the existing generate route with prompt, provider/model, aspect, length and a reference the model supports', async () => {
    const calls = stubFetch(page([]), (call) => (
      call.url === '/api/projects/p/media/generate'
        ? json({ taskId: 'new-1', status: 'running', startedAt: CREATED }, 202)
        : undefined
    ));
    renderPanel();
    const form = await screen.findByRole('form', { name: 'Create media' });
    await waitFor(() => expect(within(form).getByLabelText('Model')).toBeTruthy());

    // A text-only image model offers no reference input at all.
    expect(within(form).queryByLabelText('Reference image')).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Video' }));
    fireEvent.change(within(form).getByLabelText('Provider'), { target: { value: 'fal' } });
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'fal/kling' } });
    fireEvent.change(within(form).getByLabelText('Aspect ratio'), { target: { value: '16:9' } });
    fireEvent.change(within(form).getByLabelText('Length (seconds)'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Reference image'), { target: { value: 'ref.png' } });
    // Only image files are offered as references.
    expect(within(within(form).getByLabelText('Reference image')).queryByText('index.html')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'a slow dolly over hills' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/projects/p/media/generate')).toBe(true));
    const generate = calls.find((call) => call.url === '/api/projects/p/media/generate')!;
    expect(generate.method).toBe('POST');
    expect(generate.body).toEqual({
      surface: 'video',
      model: 'fal/kling',
      prompt: 'a slow dolly over hills',
      aspect: '16:9',
      length: 10,
      image: 'ref.png',
    });
  });

  it('labels a provider with no real integration as placeholder output in the picker', async () => {
    stubFetch(page([]));
    renderPanel();
    const form = await screen.findByRole('form', { name: 'Create media' });
    await waitFor(() => expect(within(form).getByLabelText('Provider')).toBeTruthy());
    const option = within(within(form).getByLabelText('Provider')).getByRole('option', { name: /Stub/ });
    expect(option.textContent).toMatch(/placeholder output/i);
  });
});

describe('MediaWorkbench — task rows (AC-R10.1)', () => {
  it('cancels a running task and then shows it as Cancelled, not as a failure', async () => {
    let cancelled = false;
    const running = entry({ id: 'run-1', status: 'running', endedAt: null, file: undefined, output: { state: 'none' } });
    const calls = stubFetch(() => page([cancelled
      ? { ...running, status: 'interrupted', interruptReason: 'user-cancelled', error: { message: 'cancelled by the user', code: 'MEDIA_TASK_CANCELLED', nextStep: 'retry-later' } }
      : running]), (call) => {
      if (call.url === '/api/media/tasks/run-1/cancel') {
        cancelled = true;
        return json({ taskId: 'run-1', projectId: 'p', status: 'interrupted', interruptReason: 'user-cancelled', endedAt: CREATED + 1, cancellation: { mode: 'local-abort', providerCancel: 'unsupported', alreadyCancelled: false } });
      }
      return undefined;
    });
    renderPanel();
    const item = await row('run-1');
    expect(within(item).getByText('Running')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(within(item).getByText('Cancelled')).toBeTruthy());
    expect(calls.find((call) => call.url === '/api/media/tasks/run-1/cancel')?.method).toBe('POST');
    expect(within(item).queryByText('Failed')).toBeNull();
    expect(within(item).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(item).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps following a running task until it settles', async () => {
    const running = entry({ id: 'slow', status: 'running', endedAt: null, file: undefined, output: { state: 'none' } });
    let reads = 0;
    stubFetch(page([running]), (call) => {
      if (call.url !== '/api/projects/p/media/gallery/slow') return undefined;
      reads += 1;
      const current = reads < 3 ? running : entry({ id: 'slow' });
      return json({ entry: current, chain: [current], request: null });
    });
    render(<I18nProvider><MediaWorkbenchPanel projectId="p" files={FILES} pollMs={5} /></I18nProvider>);
    const item = await row('slow');
    await waitFor(() => expect(within(item).getByText('Done')).toBeTruthy());
    expect(reads).toBe(3);
  });

  it('never lets a poll answer that was in flight before a cancel overwrite the cancelled state', async () => {
    const running = entry({ id: 'race', status: 'running', endedAt: null, file: undefined, output: { state: 'none' } });
    let releasePoll: (response: Response) => void = () => {};
    let releaseCancel: (response: Response) => void = () => {};
    let pollReads = 0;
    let cancelSent = false;
    stubFetch(page([running]), (call) => {
      if (call.url === '/api/projects/p/media/gallery/race') {
        pollReads += 1;
        return new Promise<Response>((resolve) => { releasePoll = resolve; });
      }
      if (call.url === '/api/media/tasks/race/cancel') {
        cancelSent = true;
        return new Promise<Response>((resolve) => { releaseCancel = resolve; });
      }
      return undefined;
    });
    render(<I18nProvider><MediaWorkbenchPanel projectId="p" files={FILES} pollMs={5} /></I18nProvider>);
    const item = await row('race');
    // The poll asks for the entry while it is still running, and the user
    // cancels before either answer arrives.
    await waitFor(() => expect(pollReads).toBe(1));
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelSent).toBe(true));
    // Both answers land in the same tick: the cancel first, then the stale
    // running snapshot the poll asked for before the cancel.
    await act(async () => {
      releaseCancel(json({ taskId: 'race', projectId: 'p', status: 'interrupted', interruptReason: 'user-cancelled', endedAt: CREATED + 1, cancellation: { mode: 'local-abort', providerCancel: 'unsupported', alreadyCancelled: false } }));
      releasePoll(json({ entry: running, chain: [running], request: null }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(within(item).getByText('Cancelled')).toBeTruthy();
    expect(within(item).queryByText('Running')).toBeNull();
    expect(within(item).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('retries with an Idempotency-Key and keeps the same key when the click is repeated after a network failure', async () => {
    let attempt = 0;
    const failed = entry({ id: 'f-1', status: 'failed', file: undefined, output: { state: 'none' }, error: { message: 'upstream 503', code: 'UPSTREAM_UNAVAILABLE', nextStep: 'retry-later' } });
    const calls = stubFetch(page([failed]), (call) => {
      if (call.url === '/api/media/tasks/f-1/retry') {
        attempt += 1;
        if (attempt === 1) return json({ error: { code: 'UPSTREAM', message: 'socket hang up' } }, 503);
        return json({ taskId: 'r-1', projectId: 'p', status: 'running', startedAt: CREATED, retryOf: 'f-1', lineage: { rootId: 'f-1', parentId: 'f-1', relation: 'retry', attempt: 2, parentInProject: true }, idempotencyKey: call.headers.get('idempotency-key'), replayed: false }, 202);
      }
      return undefined;
    });
    renderPanel();
    const item = await row('f-1');
    expect(within(item).getByText('Failed')).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(item).getByRole('alert').textContent).toMatch(/socket hang up/));
    fireEvent.click(within(item).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/media/tasks/f-1/retry')).toHaveLength(2));

    const [first, second] = calls.filter((call) => call.url === '/api/media/tasks/f-1/retry');
    const key = first!.headers.get('idempotency-key');
    expect(key).toBeTruthy();
    expect(first!.method).toBe('POST');
    expect(second!.headers.get('idempotency-key')).toBe(key);
  });

  it('shows a safety rejection with its category and offers no futile Retry', async () => {
    stubFetch(page([entry({
      id: 's-1',
      status: 'failed',
      file: undefined,
      output: { state: 'none' },
      provenance: { providerId: 'higgsfield', model: 'higgsfield/gpt-image-2', promptDigest: 'a'.repeat(64), stub: false, safetyCategory: 'safety.nsfw' },
      error: { message: 'nsfw', code: 'safety_rejection', category: 'safety.nsfw', nextStep: 'revise-request' },
    })]));
    renderPanel();
    const item = await row('s-1');
    expect(within(item).getByText('Blocked: flagged as NSFW')).toBeTruthy();
    expect(within(item).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(item).getByText(/Revise the prompt or reference/)).toBeTruthy();
  });
});

describe('MediaWorkbench — gallery (AC-R10.2)', () => {
  it('sends kind, status, provider and date filters to the gallery route and pages with load more', async () => {
    const calls = stubFetch((url) => {
      if (url.searchParams.get('cursor') === 'c2') return page([entry({ id: 'older', createdAt: CREATED - 1 })]);
      return page([entry({ id: 'newer' })], 'c2');
    });
    renderPanel();
    await row('newer');
    const gallery = screen.getByRole('region', { name: 'Gallery' });

    fireEvent.change(within(gallery).getByLabelText('Type'), { target: { value: 'video' } });
    fireEvent.click(within(gallery).getByRole('button', { name: 'Failed' }));
    fireEvent.click(within(gallery).getByRole('button', { name: 'Interrupted' }));
    fireEvent.change(within(gallery).getByLabelText('Provider'), { target: { value: 'fal' } });
    fireEvent.change(within(gallery).getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(gallery).getByLabelText('To'), { target: { value: '2026-10-08' } });

    await waitFor(() => {
      const last = new URL(calls.filter((call) => call.url.startsWith('/api/projects/p/media/gallery?')).at(-1)!.url, 'http://localhost');
      expect(last.searchParams.get('kind')).toBe('video');
      expect(last.searchParams.get('status')).toBe('failed,interrupted');
      expect(last.searchParams.get('provider')).toBe('fal');
      expect(last.searchParams.get('from')).toBe(String(new Date(2026, 9, 1).getTime()));
      // `to` is exclusive, so the chosen end day is included whole.
      expect(last.searchParams.get('to')).toBe(String(new Date(2026, 9, 9).getTime()));
    });
    expect(within(gallery).getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true');

    await row('newer');
    fireEvent.click(within(gallery).getByRole('button', { name: 'Load more' }));
    await row('older');
    expect(screen.getByTestId('media-entry-newer')).toBeTruthy();
    const more = new URL(calls.at(-1)!.url, 'http://localhost');
    expect(more.searchParams.get('cursor')).toBe('c2');
    expect(more.searchParams.get('kind')).toBe('video');
    expect(within(gallery).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the version chain from the gallery entry endpoint with the open entry marked', async () => {
    const original = entry({ id: 'o-1', status: 'failed', file: undefined, output: { state: 'none' } });
    const retry = entry({ id: 'r-1', lineage: { rootId: 'o-1', parentId: 'o-1', relation: 'retry', attempt: 2, parentInProject: true } });
    const edit = entry({ id: 'e-1', lineage: { rootId: 'o-1', parentId: 'r-1', relation: 'edit', attempt: 1, parentInProject: true } });
    const detail: MediaGalleryEntryDetail = { entry: retry, chain: [original, retry, edit], request: { surface: 'image', model: 'fal/flux', prompt: 'hero' } };
    const calls = stubFetch(page([retry]), (call) => (call.url === '/api/projects/p/media/gallery/r-1' ? json(detail) : undefined));
    renderPanel();
    const item = await row('r-1');
    const toggle = within(item).getByRole('button', { name: 'Versions' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const chain = await within(item).findByRole('list', { name: 'Version chain' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(calls.some((call) => call.url === '/api/projects/p/media/gallery/r-1')).toBe(true);
    const links = within(chain).getAllByRole('listitem');
    expect(links.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Original.*Failed/),
      expect.stringMatching(/Retry.*Attempt 2/),
      expect.stringMatching(/Edit/),
    ]);
    expect(links[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('labels stub entries so they can never pass for generated assets', async () => {
    stubFetch(page([
      entry({ id: 'stubbed', provenance: { providerId: 'stub', model: 'stub/image', promptDigest: null, stub: true } }),
      entry({ id: 'real' }),
    ]));
    renderPanel();
    const stub = await row('stubbed');
    expect(within(stub).getByText('Placeholder, not generated')).toBeTruthy();
    expect(stub.getAttribute('data-stub')).toBe('true');
    // Placeholder bytes are never handed out as an asset: no download, no reuse.
    expect(within(stub).queryByRole('link', { name: 'Download' })).toBeNull();
    expect(within(stub).queryByRole('button', { name: 'Reuse in project' })).toBeNull();
    expect(within(stub).getByRole('button', { name: 'Unlink' })).toBeTruthy();
    const real = await row('real');
    expect(within(real).queryByText('Placeholder, not generated')).toBeNull();
    expect(within(real).getByRole('link', { name: 'Download' })).toBeTruthy();
  });

  it('shows superseded and missing outputs as such and offers no download or reuse for them', async () => {
    stubFetch(page([
      entry({ id: 'sup', file: undefined, output: { state: 'superseded', recordedName: 'hero.png' }, error: { message: 'x', code: 'MEDIA_OUTPUT_SUPERSEDED', nextStep: 'output-superseded' } }),
      entry({ id: 'gone', file: undefined, output: { state: 'missing', recordedName: 'old.png' } }),
    ]));
    renderPanel();
    const sup = await row('sup');
    expect(within(sup).getByText(/Output replaced/)).toBeTruthy();
    expect(within(sup).queryByRole('link', { name: 'Download' })).toBeNull();
    expect(within(sup).queryByRole('button', { name: 'Reuse in project' })).toBeNull();
    const gone = await row('gone');
    expect(within(gone).getByText(/Output missing/)).toBeTruthy();
    expect(within(gone).queryByRole('link', { name: 'Download' })).toBeNull();
    // Unlink still works for an entry whose file is gone.
    expect(within(gone).getByRole('button', { name: 'Unlink' })).toBeTruthy();
  });

  it('Sol B5/6 WARN: an unverifiable output keeps its preview and warning but offers no Download or Reuse', async () => {
    stubFetch(page([
      entry({ id: 'unproven', output: { state: 'unverifiable', recordedName: 'hero.png' } }),
      entry({ id: 'moved', file: { name: 'nested/hero.png', mime: 'image/png', kind: 'image', size: 10 }, output: { state: 'moved', recordedName: 'hero.png' } }),
    ]));
    renderPanel();
    const unproven = await row('unproven');
    expect(unproven.querySelector('img')?.getAttribute('src')).toContain('hero.png');
    expect(within(unproven).getByText('Output not verified')).toBeTruthy();
    expect(within(unproven).queryByRole('link', { name: 'Download' })).toBeNull();
    expect(within(unproven).queryByRole('button', { name: 'Reuse in project' })).toBeNull();
    const moved = await row('moved');
    expect(within(moved).getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(within(moved).getByRole('button', { name: 'Reuse in project' })).toBeTruthy();
  });

  it('keeps Download, Place, Reuse in project and Unlink distinct', async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: 'p', name: 'This project' },
      { id: 'q', name: 'Landing page' },
    ] as never);
    const calls = stubFetch(page([entry({ id: 'done-1' })]), (call) => {
      if (call.url === '/api/projects/p/media/gallery/done-1/reuse') {
        return json({ entry: entry({ id: 'copy-1', projectId: 'q' }), sourceId: 'done-1', sourceProjectId: 'p', bytesCopied: 10 }, 201);
      }
      if (call.url === '/api/projects/p/media/gallery/done-1/unlink') {
        return json({ id: 'done-1', unlinked: true, bytesRetained: true });
      }
      return undefined;
    });
    renderPanel();
    const item = await row('done-1');
    expect(within(item).getByRole('button', { name: /Place in/  })).toBeTruthy();

    const download = within(item).getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe('/api/projects/p/raw/hero.png');
    expect(download.getAttribute('download')).toBe('hero.png');

    fireEvent.click(within(item).getByRole('button', { name: 'Reuse in project' }));
    const target = await within(item).findByLabelText('Target project');
    // The source project is not a reuse target.
    expect(within(target).queryByRole('option', { name: 'This project' })).toBeNull();
    fireEvent.change(target, { target: { value: 'q' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(within(item).getByRole('status').textContent).toMatch(/Copied to Landing page/));
    const reuse = calls.find((call) => call.url === '/api/projects/p/media/gallery/done-1/reuse')!;
    expect(reuse.method).toBe('POST');
    expect(reuse.body).toEqual({ targetProjectId: 'q' });
    expect(reuse.headers.get('idempotency-key')).toBeTruthy();

    fireEvent.click(within(item).getByRole('button', { name: 'Unlink' }));
    // Unlink asks first and says the file is kept.
    expect(calls.some((call) => call.url.endsWith('/unlink'))).toBe(false);
    expect(within(item).getByText(/file stays in the project/)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Confirm unlink' }));
    await waitFor(() => expect(screen.queryByTestId('media-entry-done-1')).toBeNull());
    expect(calls.find((call) => call.url.endsWith('/unlink'))?.method).toBe('POST');
    // Unlink never deletes the project file.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('status').textContent).toMatch(/file was kept/);
  });
});

describe('MediaWorkbench — launcher', () => {
  it('opens the workbench dialog and keeps it mounted when closed so its exit can play', async () => {
    stubFetch(page([]));
    render(<I18nProvider><MediaWorkbench projectId="p" files={FILES} /></I18nProvider>);
    const open = screen.getByRole('button', { name: 'Media' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Media workbench' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    const closed = document.querySelector('[data-testid="media-workbench-dialog"]');
    expect(closed).toBeTruthy();
    expect(closed!.getAttribute('data-open')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'Media workbench' })).toBeNull();
  });

  it('contains focus and locks the page behind the open dialog, and releases both on close', async () => {
    stubFetch(page([]));
    const { container } = render(
      <I18nProvider>
        <button type="button">Outside</button>
        <MediaWorkbench projectId="p" files={FILES} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Media' }));
    const dialog = await screen.findByRole('dialog', { name: 'Media workbench' });
    await within(dialog).findByLabelText('Model');

    // Everything behind the dialog is inert and the page does not scroll.
    expect(container.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'))
      .filter((element) => !element.closest('[inert], [aria-hidden="true"]'));
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    expect(first).toBe(within(dialog).getByRole('button', { name: 'Close' }));

    last.focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Close' })); });
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Media' }));
  });
});

describe('AC-R10.2 placement and playable previews', () => {
  it('offers placement separately from download, reuse and unlink, retaining its key after a transport failure', async () => {
    let attempts = 0;
    const calls = stubFetch(page([entry()]), call => {
      if (call.url.endsWith('/t1/place')) {
        attempts += 1;
        if (attempts === 1) return json({ error: { message: 'connection lost' } }, 503);
        return json({ action: 'place', entry: entry({ id: 'placed', file: { name: 'asset.png' } }), sourceId: 't1', sourceProjectId: 'p', bytesCopied: 10 }, 201);
      }
      return undefined;
    });
    renderPanel();
    const item = await row('t1');
    expect(within(item).getByRole('link', { name: 'Download' })).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Reuse in project' })).toBeTruthy();
    expect(within(item).getByRole('button', { name: 'Unlink' })).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: /Place in/  }));
    fireEvent.change(within(item).getByLabelText('Asset filename'), { target: { value: 'asset.png' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Place copy' }));
    await within(item).findByRole('alert');
    fireEvent.click(within(item).getByRole('button', { name: 'Place copy' }));
    await waitFor(() => expect(attempts).toBe(2));
    const sent = calls.filter(call => call.url.endsWith('/t1/place'));
    expect(sent[0]!.body).toEqual({ targetProjectId: 'p', output: 'asset.png' });
    expect(sent[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(sent[1]!.headers.get('idempotency-key')).toBe(sent[0]!.headers.get('idempotency-key'));
  });
  it('plays saved video bytes and gives labelled placeholders no placement control', async () => {
    stubFetch(page([entry({ id: 'video', kind: 'video', file: { name: 'clip.mp4', mime: 'video/mp4' } }), entry({ id: 'stub-place', provenance: { providerId: 'stub', model: 'stub', promptDigest: null, stub: true } })]));
    renderPanel();
    const video = (await row('video')).querySelector('video')!;
    expect(video.controls).toBe(true);
    expect(video.getAttribute('aria-hidden')).not.toBe('true');
    expect(within(await row('stub-place')).queryByRole('button', { name: /Place in/  })).toBeNull();
  });
});

describe('AC-R10.2 project filter', () => {
  it('places an asset browsed in Q into current canvas P and names P as the destination', async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: 'p', name: 'Current canvas' }, { id: 'q', name: 'Other project' }] as never);
    const calls = stubFetch(page([]), call => {
      if (call.url === '/api/projects/q/media/gallery') return json(page([entry({ projectId: 'q' })]));
      if (call.url === '/api/projects/q/media/gallery/t1/place') {
        return json({ action: 'place', entry: entry({ id: 'placed', projectId: 'p', file: { name: 'asset.png' } }), sourceId: 't1', sourceProjectId: 'q', bytesCopied: 10 }, 201);
      }
      return undefined;
    });
    renderPanel();
    const gallery = screen.getByRole('region', { name: 'Gallery' });
    await within(gallery).findByRole('option', { name: 'Other project' });
    fireEvent.change(within(gallery).getByLabelText('Project'), { target: { value: 'q' } });
    const item = await row('t1');
    // Check the request independently of the copy result and destination label.
    fireEvent.click(within(item).getByRole('button', { name: /Place in/ }));
    fireEvent.change(within(item).getByLabelText('Asset filename'), { target: { value: 'asset.png' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Place copy' }));
    await waitFor(() => expect(calls.find(call => call.url.endsWith('/t1/place'))?.body).toEqual({ targetProjectId: 'p', output: 'asset.png' }));
    expect(within(item).getByRole('button', { name: 'Place in Current canvas' })).toBeTruthy();
    expect(within(item).getByRole('status').textContent).toBe('Placed asset.png in Current canvas.');
    expect(within(gallery).getByLabelText('Project')).toHaveProperty('value', 'q');
  });

  it('loads another authorized project and never offers stale entries when the new project read fails', async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: 'p', name: 'Current canvas' }, { id: 'q', name: 'Other project' }] as never);
    const calls = stubFetch(page([entry()]), call => call.url === '/api/projects/q/media/gallery'
      ? json({ error: { message: 'access revoked' } }, 403) : undefined);
    renderPanel();
    await row('t1');
    const gallery = screen.getByRole('region', { name: 'Gallery' });
    await waitFor(() => expect(within(gallery).getByRole('option', { name: 'Other project' })).toBeTruthy());
    fireEvent.change(within(gallery).getByLabelText('Project'), { target: { value: 'q' } });
    await waitFor(() => expect(calls.some(call => call.url === '/api/projects/q/media/gallery')).toBe(true));
    expect(screen.queryByTestId('media-entry-t1')).toBeNull();
    expect((await within(gallery).findByRole('alert')).textContent).toContain('access revoked');
  });
});


describe('AC-R10 review regressions', () => {
  it('uses the completed filename when a queued video becomes placeable', () => {
    const callbacks = { onEntryChange: vi.fn(), onTaskStarted: vi.fn(), onUnlinked: vi.fn() };
    const queued = entry({ status: 'queued', kind: 'video', file: undefined, output: { state: 'none' } });
    const rendered = render(<I18nProvider><MediaEntryRow projectId="p" canvasProjectId="p" canvasProjectName="Current canvas" entry={queued} {...callbacks} /></I18nProvider>);
    rendered.rerender(<I18nProvider><MediaEntryRow projectId="p" canvasProjectId="p" canvasProjectName="Current canvas" entry={entry({ kind: 'video', file: { name: 'completed.mp4' } })} {...callbacks} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Place in/  }));
    expect((screen.getByLabelText('Asset filename') as HTMLInputElement).value).toBe('completed.mp4');
  });
  it('keeps Tab in the modal sequence when native playback has focus', async () => {
    stubFetch(page([entry({ kind: 'video', file: { name: 'clip.mp4' } })]));
    render(<I18nProvider><MediaWorkbench projectId="p" files={[]} pollMs={0} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Media' }));
    const video = (await row('t1')).querySelector('video')!;
    const focused = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(video);
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    focused.mockRestore();
  });
});
