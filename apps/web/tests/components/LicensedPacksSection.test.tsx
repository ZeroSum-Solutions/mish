// @vitest-environment jsdom

// P1-2 spec 4: Settings → Licensed packs against a stubbed /api/packs*.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_ERROR_MESSAGES,
  SETTINGS_LICENSED_PACKS,
  type InstalledPackSummary,
  type PackGithubAccessStatus,
} from '@mish/contracts';

import {
  LICENSED_PACKS_COPY_KEYS,
  LICENSED_PACKS_DRAFT_COPY,
  LICENSED_PACKS_ERROR_KEYS,
  LicensedPacksSection,
} from '../../src/components/LicensedPacksSection';
import { I18nProvider } from '../../src/i18n';

const PACK: InstalledPackSummary = {
  id: 'mishh-licensed',
  version: '2026.10.7',
  title: 'Mishh licensed pack',
  licenceScope: 'Internal team use',
  contents: [
    { kind: 'component-kit', id: 'cult-ui-pro', count: 120 },
    { kind: 'plugins', count: 3 },
  ],
  status: 'ready',
  digest: 'a'.repeat(64),
  source: 'github:ZeroSum-Solutions/mishh-licensed@2026.10.7',
  installedAt: '2026-10-07T00:00:00.000Z',
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers?: Record<string, string>;
}

interface StubOptions {
  packs?: InstalledPackSummary[];
  access?: PackGithubAccessStatus;
  /** SSE frames for POST /api/packs/install, or a JSON error response. */
  install?: { sse: string[] } | { status: number; error: { code: string; message: string } };
  /** GET /api/packs fails after this many successful reads. */
  listFailsAfter?: number;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stubFetch(options: StubOptions = {}) {
  let packs = options.packs ?? [];
  let access = options.access ?? { configured: false, source: 'none' };
  const calls: Call[] = [];
  let listReads = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method, url, body, ...(Object.keys(headers).length > 0 ? { headers } : {}) });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/packs' && method === 'GET') {
      listReads += 1;
      if (options.listFailsAfter !== undefined && listReads > options.listFailsAfter) {
        return json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);
      }
      return json({ packs });
    }
    if (url === '/api/packs/github-access') {
      if (method === 'POST') {
        const token = (body as { token?: string }).token ?? '';
        if (!token.startsWith('github_pat_')) {
          return json({ error: { code: 'INVALID_TOKEN_FORMAT', message: `server text for ${token}` } }, 400);
        }
        access = { configured: true, source: 'stored' };
      } else if (method === 'DELETE') {
        access = { configured: false, source: 'none' };
      }
      return json(access);
    }
    if (url === '/api/packs/install' && method === 'POST') {
      const install = options.install ?? { sse: [] };
      if ('status' in install) return json({ error: install.error }, install.status);
      packs = [PACK];
      return new Response(install.sse.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.startsWith('/api/packs/') && method === 'DELETE') {
      const id = decodeURIComponent(url.slice('/api/packs/'.length));
      packs = packs.filter((pack) => pack.id !== id);
      return json({ ok: true, id, removedVersion: '2026.10.7' });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

const GITHUB_SOURCE = 'github:example-org/team-pack@1.0.0';

/** Type a source (the field starts empty) and click Install. */
function installFrom(source: string) {
  fireEvent.change(screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.sourceLabel']), { target: { value: source } });
  fireEvent.click(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.install'] }));
}

function renderSection() {
  return render(
    <I18nProvider initial="en">
      <LicensedPacksSection />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LicensedPacksSection (P1-2 spec 4)', () => {
  it('(a) shows the empty state with an empty source field, its placeholder and an Install button', async () => {
    stubFetch();
    renderSection();
    expect(await screen.findByTestId('licensed-packs-empty')).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.empty']);
    // Packs are team drop-ins: no repository is a sensible default (2026-10-09).
    const sourceField = screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.sourceLabel']);
    expect(sourceField).toHaveValue('');
    expect(sourceField).toHaveAttribute('placeholder', LICENSED_PACKS_DRAFT_COPY['licensedPacks.sourcePlaceholder']);
    expect(document.body.textContent).not.toContain('mishh-licensed');
    expect(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.install'] })).toBeEnabled();
    expect(screen.getByTestId('licensed-packs-access-status')).toHaveTextContent(
      LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.status.none'],
    );
  });

  it('(b) Install posts {source}, shows localized phases from the SSE stream, then the installed row with version, licence scope and contents', async () => {
    const { calls } = stubFetch({
      install: {
        sse: [
          sse('progress', { phase: 'resolving' }),
          sse('progress', { phase: 'downloading', bytes: 2048, totalBytes: 4096 }),
          ': keepalive\n\n',
          sse('progress', { phase: 'verifying' }),
          sse('success', { outcome: 'installed', pack: PACK, warnings: [] }),
        ],
      },
    });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);

    const row = await screen.findByTestId(`licensed-pack-${PACK.id}`);
    expect(row).toHaveTextContent(PACK.title);
    expect(row).toHaveTextContent('Version 2026.10.7');
    expect(row).toHaveTextContent('Licence: Internal team use');
    expect(row).toHaveTextContent('Component kit (120)');
    expect(row).toHaveTextContent('Plugins (3)');
    expect(row).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.status.ready']);
    expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent(
      `${PACK.title} 2026.10.7 is installed.`,
    );

    const install = calls.find((call) => call.url === '/api/packs/install');
    expect(install?.body).toEqual({ source: GITHUB_SOURCE });
    // The list was re-read after the install, not patched from the event.
    expect(calls.filter((call) => call.url === '/api/packs' && call.method === 'GET')).toHaveLength(2);
  });

  it('shows each phase as it streams', async () => {
    let push!: (chunk: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
        close = () => controller.close();
      },
    });
    stubFetch();
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/packs/install') return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return base(input, init);
    }));
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);
    push(sse('progress', { phase: 'extracting', bytes: 1024, totalBytes: 2048 }));
    await waitFor(() =>
      expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent('Unpacking… 1.0 KB of 2.0 KB'),
    );
    push(sse('progress', { phase: 'activating' }));
    await waitFor(() =>
      expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent(
        LICENSED_PACKS_DRAFT_COPY['licensedPacks.phase.activating'],
      ),
    );
    push(sse('error', { code: 'CONTENT_CONFLICT', message: 'installed pack other already provides this content', warnings: [] }));
    close();
    await waitFor(() =>
      expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent(
        LICENSED_PACKS_DRAFT_COPY['licensedPacks.error.CONTENT_CONFLICT'],
      ),
    );
  });

  it('(c) an error event renders the localized message for its code, never the server\'s text', async () => {
    stubFetch({
      install: { sse: [sse('progress', { phase: 'resolving' }), sse('error', { code: 'AUTH_REQUIRED', message: 'SERVER-TEXT-AUTH', warnings: [] })] },
    });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);
    const status = screen.getByTestId('licensed-packs-install-status');
    await waitFor(() => expect(status).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.error.AUTH_REQUIRED']));
    expect(status).not.toHaveTextContent('mishh-licensed');
    expect(document.body.textContent).not.toContain('SERVER-TEXT-AUTH');
  });

  it('a refusal before the stream (409 JSON) also renders the localized message for its code', async () => {
    stubFetch({ install: { status: 409, error: { code: 'INSTALL_IN_PROGRESS', message: 'SERVER-TEXT-409' } } });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);
    await waitFor(() =>
      expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent(
        LICENSED_PACKS_DRAFT_COPY['licensedPacks.error.INSTALL_IN_PROGRESS'],
      ),
    );
    expect(document.body.textContent).not.toContain('SERVER-TEXT-409');
  });

  it('sends sha256 and force for a local source, and refuses a file pick without a sha256 before uploading', async () => {
    const { calls } = stubFetch({ install: { sse: [sse('success', { outcome: 'upgraded', pack: PACK, warnings: [] })] } });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');

    const file = new File([new Uint8Array([1, 2, 3])], 'pack.tgz', { type: 'application/gzip' });
    fireEvent.change(screen.getByTestId('licensed-packs-file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent(
        LICENSED_PACKS_DRAFT_COPY['licensedPacks.error.DIGEST_REQUIRED'],
      ),
    );
    expect(calls.some((call) => call.url === '/api/packs/install')).toBe(false);

    fireEvent.change(screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.sourceLabel']), {
      target: { value: '/Users/me/Downloads/pack.tgz' },
    });
    fireEvent.change(screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.sha256Label']), {
      target: { value: 'b'.repeat(64) },
    });
    fireEvent.click(screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.force']));
    fireEvent.click(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.install'] }));
    await screen.findByTestId(`licensed-pack-${PACK.id}`);
    expect(calls.find((call) => call.url === '/api/packs/install')?.body).toEqual({
      source: '/Users/me/Downloads/pack.tgz',
      sha256: 'b'.repeat(64),
      force: true,
    });

    fireEvent.change(screen.getByTestId('licensed-packs-file'), { target: { files: [file] } });
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/packs/install')).toHaveLength(2));
    const upload = calls.filter((call) => call.url === '/api/packs/install')[1]!.body as FormData;
    expect(upload).toBeInstanceOf(FormData);
    expect(upload.get('sha256')).toBe('b'.repeat(64));
    expect(upload.get('force')).toBe('true');
    expect((upload.get('archive') as File).name).toBe('pack.tgz');
    // B1: the upload carries the header that forces a browser preflight.
    expect(calls.filter((call) => call.url === '/api/packs/install')[1]!.headers?.['x-od-pack-upload']).toBe('1');
  });

  it('(d) Remove sends DELETE and the row disappears', async () => {
    const { calls } = stubFetch({ packs: [PACK] });
    renderSection();
    const row = await screen.findByTestId(`licensed-pack-${PACK.id}`);
    fireEvent.click(within(row).getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.remove'] }));
    const dialog = await screen.findByTestId('licensed-packs-remove-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.removeConfirmAction'] }));
    await waitFor(() => expect(screen.queryByTestId(`licensed-pack-${PACK.id}`)).toBeNull());
    expect(calls.find((call) => call.method === 'DELETE')?.url).toBe(`/api/packs/${PACK.id}`);
    expect(await screen.findByTestId('licensed-packs-empty')).toBeInTheDocument();
  });

  it('(e) the GitHub token field is a password input; after Save the field is empty, the token was sent only in the POST body, and the status line names the source', async () => {
    const { calls } = stubFetch({ access: { configured: true, source: 'gh-cli' } });
    renderSection();
    const status = screen.getByTestId('licensed-packs-access-status');
    await waitFor(() => expect(status).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.status.ghCli']));

    const field = screen.getByLabelText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.tokenLabel']);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    const token = `github_pat_${'T'.repeat(40)}`;
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.save'] }));

    await waitFor(() => expect(status).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.status.stored']));
    expect(field).toHaveValue('');
    const carrying = calls.filter((call) => JSON.stringify(call).includes(token));
    expect(carrying.map(({ method, url, body }) => ({ method, url, body }))).toEqual([{ method: 'POST', url: '/api/packs/github-access', body: { token } }]);
    expect(JSON.stringify(carrying[0]!.headers ?? {})).not.toContain(token);
    expect(document.body.textContent).not.toContain('T'.repeat(8));

    // A rejected paste shows the localized code message, never the server's echo.
    fireEvent.change(field, { target: { value: 'ghp_bad' } });
    fireEvent.click(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.save'] }));
    expect(await screen.findByText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.error.INVALID_TOKEN_FORMAT'])).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('server text');
    expect(field).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.clear'] }));
    await waitFor(() => expect(status).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.github.status.none']));
  });
});

describe('LicensedPacksSection lane round (W1, N3)', () => {
  it('W1: keeps the list visible and shows a could-not-refresh line with Retry when a re-read fails', async () => {
    stubFetch({ packs: [PACK], listFailsAfter: 1, install: { sse: [sse('success', { outcome: 'unchanged', pack: PACK, warnings: [] })] } });
    renderSection();
    await screen.findByTestId(`licensed-pack-${PACK.id}`);
    installFrom(GITHUB_SOURCE);
    expect(await screen.findByText(LICENSED_PACKS_DRAFT_COPY['licensedPacks.refreshFailed'], { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId(`licensed-pack-${PACK.id}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: LICENSED_PACKS_DRAFT_COPY['licensedPacks.retry'] })).toBeEnabled();
  });

  it('N3: shows the warnings of a success event and of an error event', async () => {
    stubFetch({ install: { sse: [sse('success', { outcome: 'installed', pack: PACK, warnings: ['plugins content could not be registered'] })] } });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);
    expect(await screen.findByText('plugins content could not be registered')).toBeInTheDocument();
    expect(screen.getByTestId('licensed-packs-warnings')).toHaveTextContent(LICENSED_PACKS_DRAFT_COPY['licensedPacks.warnings']);
    cleanup();

    stubFetch({
      install: { sse: [sse('error', { code: 'RETRACT_FAILED', message: 'x', warnings: ['plugin demo could not be removed'] })] },
    });
    renderSection();
    await screen.findByTestId('licensed-packs-empty');
    installFrom(GITHUB_SOURCE);
    expect(await screen.findByText('plugin demo could not be removed')).toBeInTheDocument();
  });
});

// Team drop-in QA (2026-10-08): a teammate who made the pack has no one to
// hand them a SHA-256; the field and its error name the command that prints it.
describe('Licensed packs: where the SHA-256 comes from', () => {
  for (const locale of ['en'] as const) {
    it(`the SHA-256 hint and the missing-digest error name od pack digest (${locale})`, async () => {
      stubFetch();
      render(
        <I18nProvider initial={locale}>
          <LicensedPacksSection />
        </I18nProvider>,
      );
      await screen.findByTestId('licensed-packs-empty');
      const shaField = screen.getByTestId('licensed-packs-section').querySelectorAll('input')[1]!;
      const hintId = shaField.getAttribute('aria-describedby')!;
      expect(document.getElementById(hintId)).toHaveTextContent('od pack digest');

      const file = new File([new Uint8Array([1])], 'pack.tgz', { type: 'application/gzip' });
      fireEvent.change(screen.getByTestId('licensed-packs-file'), { target: { files: [file] } });
      await waitFor(() => expect(screen.getByTestId('licensed-packs-install-status')).toHaveTextContent('od pack digest'));
    });
  }
});

describe('Licensed packs copy from the i18n dictionary', () => {
  it('shows the source placeholder from the dictionary, with no default repository', async () => {
    stubFetch();
    render(
      <I18nProvider initial="en">
        <LicensedPacksSection />
      </I18nProvider>,
    );
    await screen.findByTestId('licensed-packs-empty');
    const sourceField = screen.getByTestId('licensed-packs-section').querySelectorAll('input')[0]!;
    expect(sourceField).toHaveValue('');
    expect(sourceField.getAttribute('placeholder')).toContain('github:owner/repo@1.0.0');
    expect(document.body.textContent).not.toContain('mishh-licensed');
  });

  it('renders the dictionary values once the keys exist', async () => {
    stubFetch();
    render(
      <I18nProvider initial="en">
        <LicensedPacksSection />
      </I18nProvider>,
    );
    expect(await screen.findByTestId('licensed-packs-empty')).toHaveTextContent("No licensed packs are installed.");
    expect(screen.getByRole('button', { name: "Install" })).toBeEnabled();
  });
});

describe('Licensed packs draft copy (deferred i18n keys)', () => {
  it('names the nav item exactly as the shared Settings destination', () => {
    expect(LICENSED_PACKS_DRAFT_COPY['settings.licensedPacks']).toBe(SETTINGS_LICENSED_PACKS);
  });

  it('carries a message for every pack error code and the P1-6 hint keys', () => {
    for (const code of Object.keys(PACK_ERROR_MESSAGES)) {
      expect(LICENSED_PACKS_ERROR_KEYS[code as keyof typeof LICENSED_PACKS_ERROR_KEYS], code).toBeTruthy();
    }
    expect(LICENSED_PACKS_COPY_KEYS.slice(-4)).toEqual([
      'licensedPacks.hint.title',
      'licensedPacks.hint.body',
      'licensedPacks.hint.action',
      'licensedPacks.hint.dismiss',
    ]);
    for (const key of LICENSED_PACKS_COPY_KEYS) expect(LICENSED_PACKS_DRAFT_COPY[key].trim(), key).not.toBe('');
  });
});
