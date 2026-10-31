// @vitest-environment jsdom

// Link pages view: sources, the Connect step for Instagram / TikTok, the options form, Build, the
// sandboxed preview, warnings and needs, Save and Export. The daemon and the connector state are
// faked; nothing leaves the test.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPageSpec } from '@mish/contracts';

const connectors = vi.hoisted(() => ({
  statuses: {} as Record<string, { status: string }>,
  connect: vi.fn(async (_id: string): Promise<{ connector: null; error?: string }> => ({ connector: null })),
}));

vi.mock('../../src/providers/registry', () => ({
  fetchConnectorStatuses: vi.fn(async () => connectors.statuses),
  connectConnector: connectors.connect,
}));

import { LinkPageView } from '../../src/components/LinkPageView';

const SPEC: LinkPageSpec = {
  version: 1,
  slug: 'sam',
  profile: { name: 'Sam Potter', headline: 'Ceramics', bio: 'Pots and bowls', about: '', themes: [], avatar_url: '', site_url: '' },
  theme: {
    mood: 'modern',
    radius: 12,
    background: 'mesh',
    palette: { bg: '#fcfbf9', surface: '#f2f1ef', text: '#1a1a1a', muted: '#555555', accent: '#2255aa', accentText: '#ffffff', dark: false },
    fonts: {
      heading: { family: 'Inter', kind: 'sans', stack: '"Inter", sans-serif', google: true },
      body: { family: 'Inter', kind: 'sans', stack: '"Inter", sans-serif', google: true },
    },
  },
  blocks: [],
};

interface Call { method: string; url: string; body: unknown; contentType: string | undefined }
let calls: Call[];
let answers: Record<string, (call: Call) => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  connectors.statuses = {};
  connectors.connect.mockClear();
  answers = {
    'GET /api/linkpages': () => json({ pages: [{ slug: 'sam', name: 'Sam Potter', headline: 'Ceramics', updatedAt: '2026-10-30T00:00:00.000Z' }] }),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call: Call = { method, url, body, contentType: (init.headers as Record<string, string> | undefined)?.['content-type'] };
    calls.push(call);
    const answer = answers[`${method} ${url}`] ?? answers[`${method} ${url.split('?')[0]}`];
    if (!answer) throw new Error(`unexpected fetch ${method} ${url}`);
    return answer(call);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function fillAndBuild(extra: () => void = () => {}) {
  type('Page address', 'sam');
  type(/Website: Address or handle/, 'https://sam.example.com');
  extra();
  fireEvent.click(screen.getByRole('button', { name: 'Build page' }));
}

describe('LinkPageView', () => {
  it('fetches nothing until it is shown, then lists the saved pages', async () => {
    const { rerender } = render(<LinkPageView isActive={false} />);
    expect(calls).toEqual([]);
    rerender(<LinkPageView isActive />);
    expect(await screen.findByRole('button', { name: 'Open sam' })).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/linkpages']);
  });

  it('explains that a business or creator account is needed and connects through the existing connector', async () => {
    connectors.statuses = { tiktok: { status: 'connected' } };
    render(<LinkPageView />);
    expect(screen.getByTestId('link-page-connect').textContent).toMatch(/business or creator account/);
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Connect TikTok' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    await waitFor(() => expect(connectors.connect).toHaveBeenCalledWith('instagram'));
  });

  it('shows why a connection could not start', async () => {
    connectors.connect.mockResolvedValueOnce({ connector: null, error: 'Popup blocked' });
    render(<LinkPageView />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Popup blocked/);
  });

  it('does not call the daemon for a missing source, a bad address or a bad web address', async () => {
    render(<LinkPageView />);
    await screen.findByRole('button', { name: 'Open sam' });
    calls.length = 0;
    type('Page address', 'sam');
    fireEvent.click(screen.getByRole('button', { name: 'Build page' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Add at least one source.');
    type(/Website: Address or handle/, 'not a url');
    expect(screen.getByText('Enter a web address starting with http or https.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build page' }));
    type('Page address', 'Bad Slug!');
    expect(screen.getByText('Use lowercase letters, numbers and dashes, up to 60 characters.')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('builds with the form options and shows warnings, needs and a sandboxed preview', async () => {
    answers['POST /api/linkpages/build'] = () => json({
      spec: SPEC,
      warnings: ['no model is available'],
      needs: [{ platform: 'instagram', why: 'Sign in to read your posts' }],
      saved: true,
    });
    render(<LinkPageView />);
    await fillAndBuild(() => {
      type('Name', 'Sam Potter');
      fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
      fireEvent.click(screen.getByRole('button', { name: 'Use my own colours' }));
    });
    const preview = (await screen.findByTestId('link-page-preview')) as HTMLIFrameElement;
    expect(preview.getAttribute('src')).toMatch(/^\/api\/linkpages\/sam\/render\?v=\d+$/);
    const sandbox = preview.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(screen.getByTestId('link-page-warnings').textContent).toContain('no model is available');
    expect(screen.getByTestId('link-page-needs').textContent).toContain('instagram: Sign in to read your posts');
    const build = calls.find((c) => c.url === '/api/linkpages/build')!;
    expect(build.body).toEqual({
      slug: 'sam',
      sources: [{ connector: 'website', ref: 'https://sam.example.com' }],
      options: { name: 'Sam Potter', theme: { palette: { bg: '#ffffff', text: '#1a1a1a', accent: '#2255aa' }, background: 'grid' } },
    });
    // No connected-account id travels from the browser: the daemon uses the login connected in Mish.
    expect(build.body).not.toHaveProperty('connectedAccounts');
  });

  it('shows the daemon error when the build fails', async () => {
    answers['POST /api/linkpages/build'] = () => json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'nothing could be read' } }, 502);
    render(<LinkPageView />);
    await fillAndBuild();
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing could be read/);
    expect(screen.queryByTestId('link-page-preview')).toBeNull();
  });

  it('saves edited text and background without a rebuild', async () => {
    answers['POST /api/linkpages/build'] = () => json({ spec: SPEC, warnings: [], needs: [], saved: true });
    answers['PUT /api/linkpages/sam'] = (call) => json({ page: { slug: 'sam', spec: (call.body as { spec: LinkPageSpec }).spec, warnings: [], createdAt: 'x', updatedAt: 'y' } });
    render(<LinkPageView />);
    await fillAndBuild();
    await screen.findByTestId('link-page-preview');
    type('Headline', 'Potter in Lisbon');
    fireEvent.click(screen.getByRole('button', { name: 'Bubbles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    const put = calls.find((c) => c.method === 'PUT')!;
    const spec = (put.body as { spec: LinkPageSpec }).spec;
    expect(spec.profile.headline).toBe('Potter in Lisbon');
    expect(spec.profile.name).toBe('Sam Potter');
    expect(spec.theme.background).toBe('bubbles');
    expect(spec.theme.palette).toEqual(SPEC.theme.palette);
  });

  it('keeps Save and Export off until a page is built', () => {
    render(<LinkPageView />);
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Export site' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('exports the site as a zip download', async () => {
    answers['POST /api/linkpages/build'] = () => json({ spec: SPEC, warnings: [], needs: [], saved: true });
    answers['GET /api/linkpages/sam/export'] = () => json({
      slug: 'sam',
      files: [
        { path: 'index.html', contentType: 'text/html', encoding: 'utf8', content: '<html>é</html>' },
        { path: 'assets/avatar.png', contentType: 'image/png', encoding: 'base64', content: 'AQID' },
      ],
    });
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:link-page'; },
      revokeObjectURL: () => {},
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('sam.zip');
    });
    render(<LinkPageView />);
    await fillAndBuild();
    await screen.findByTestId('link-page-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Export site' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const bytes = new Uint8Array(await created[0]!.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('index.html');
    expect(text).toContain('assets/avatar.png');
    click.mockRestore();
  });

  it('uploads a picture to the open page\'s saved address, not to whatever is typed in the address field', async () => {
    answers['PUT /api/linkpages/sam/assets/avatar.png'] = () => json({ slug: 'sam', name: 'avatar.png', path: 'assets/avatar.png', contentType: 'image/png', bytes: 3 });
    answers['POST /api/linkpages/build'] = () => json({ spec: SPEC, warnings: [], needs: [], saved: true });
    render(<LinkPageView />);
    await fillAndBuild();
    await screen.findByTestId('link-page-preview');
    // The address field now says something else; the picture still belongs to the saved page.
    type('Page address', 'other');
    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Photo'), { target: { files: [file] } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/linkpages/sam/assets/avatar.png')).toBe(true));
    expect(calls.some((c) => c.url.includes('/other/'))).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')!.contentType).toBe('image/png');
    await waitFor(() => expect(document.querySelector('img[src*="/api/linkpages/sam/assets/avatar.png"]')).toBeTruthy());
  });

  it('does not take a picture before the page exists, because there is no saved page to hold it', async () => {
    render(<LinkPageView />);
    type('Page address', 'sam');
    expect((screen.getByLabelText('Photo') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Photo'), { target: { files: [new File([new Uint8Array([1])], 'me.png', { type: 'image/png' })] } });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('saves a cleared headline, bio and photo as empty values, and leaves untouched fields as they were', async () => {
    const WITH = { ...SPEC, profile: { ...SPEC.profile, avatar_url: 'assets/avatar.png' } };
    answers['GET /api/linkpages/sam'] = () => json({ page: { slug: 'sam', spec: WITH, warnings: [], createdAt: 'x', updatedAt: 'y' } });
    answers['PUT /api/linkpages/sam'] = (call) => json({ page: { slug: 'sam', spec: (call.body as { spec: LinkPageSpec }).spec, warnings: [], createdAt: 'x', updatedAt: 'y' } });
    render(<LinkPageView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open sam' }));
    await screen.findByTestId('link-page-preview');
    type('Headline', '');
    type('Bio', '');
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    const sent = (calls.find((c) => c.method === 'PUT')!.body as { spec: LinkPageSpec }).spec;
    expect(sent.profile).toMatchObject({ name: 'Sam Potter', headline: '', bio: '', avatar_url: '' });
    expect(calls.find((c) => c.method === 'PUT')!.body).not.toHaveProperty('connectedAccounts');
  });

  it('keeps a generated headline, bio and web photo on Save when the person did not touch those fields', async () => {
    const GENERATED = { ...SPEC, profile: { ...SPEC.profile, headline: 'Potter in Porto', bio: 'Generated bio', avatar_url: 'https://cdn.example.com/a.jpg' } };
    answers['POST /api/linkpages/build'] = () => json({ spec: GENERATED, warnings: [], needs: [], saved: true });
    answers['PUT /api/linkpages/sam'] = (call) => json({ page: { slug: 'sam', spec: (call.body as { spec: LinkPageSpec }).spec, warnings: [], createdAt: 'x', updatedAt: 'y' } });
    render(<LinkPageView />);
    await fillAndBuild();
    await screen.findByTestId('link-page-preview');
    type('Name', 'Sam P');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('status');
    const sent = (calls.find((c) => c.method === 'PUT')!.body as { spec: LinkPageSpec }).spec;
    expect(sent.profile).toMatchObject({ name: 'Sam P', headline: 'Potter in Porto', bio: 'Generated bio', avatar_url: 'https://cdn.example.com/a.jpg' });
  });

  it('opens a saved page into the form and the preview', async () => {
    answers['GET /api/linkpages/sam'] = () => json({ page: { slug: 'sam', spec: SPEC, warnings: ['old warning'], createdAt: 'x', updatedAt: 'y' } });
    render(<LinkPageView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open sam' }));
    expect(await screen.findByTestId('link-page-preview')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sam Potter');
    expect(screen.getByTestId('link-page-warnings').textContent).toContain('old warning');
  });
});
