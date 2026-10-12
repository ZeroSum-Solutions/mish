// @vitest-environment jsdom

// Settings → Media providers → "Jev (TypeSafe)": the browser half of
// `GET`/`PUT /api/agency/config`.
//
// The card lives beside the image / video / audio provider keys because that is the visible
// place a user configures a model credential; Settings' other candidate section is labelled
// "Mishh Mashh MCP" and is about connecting an external coding agent, which this is not.
//
// The one behaviour every assertion here protects is that the key leaves the browser and does
// not come back: the field is cleared on save, the daemon's answer carries only a source, and
// nothing in the DOM after a save contains what was typed.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../../src/state/config';

const originalFetch = globalThis.fetch;
const KEY = 'sk-typesafe-NEVER-IN-THE-DOM';

type ConfigState = { configured: boolean; source: string };
type Deferred = { resolve: (state: ConfigState) => void };

interface StubOptions {
  /** Holds the mount-time GET open so a later mutation can be made to land first. */
  deferInitialGet?: boolean;
  /** Answers every PUT with this status instead of applying it. */
  putStatus?: number;
  /** `details.reason` on a rejected PUT, or `undefined` for a reason the client cannot know. */
  putReason?: string;
}

function stubDaemon(initial: ConfigState, options: StubOptions = {}) {
  let state = initial;
  const puts: unknown[] = [];
  const pendingGets: Deferred[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/agency/config') {
      if ((init?.method ?? 'GET') === 'GET') {
        if (options.deferInitialGet && pendingGets.length === 0) {
          return new Promise<Response>((resolve) => {
            pendingGets.push({
              resolve: (answer) => resolve(new Response(JSON.stringify(answer), { status: 200 })),
            });
          });
        }
        return new Response(JSON.stringify(state), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      puts.push(body);
      if (options.putStatus && options.putStatus !== 200) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'BAD_REQUEST',
              message: 'apiKey must not contain whitespace',
              ...(options.putReason
                ? { details: { kind: 'agency-jev-config', reason: options.putReason } }
                : {}),
            },
          }),
          { status: options.putStatus },
        );
      }
      state = body.clear === true
        ? { configured: false, source: 'unset' }
        : { configured: true, source: 'stored' };
      return new Response(JSON.stringify(state), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { puts, pendingGets };
}

/** Renders the dialog cold and walks to the card the way a user does, through the nav. */
function renderAndNavigate() {
  const result = render(
    <SettingsDialog
      initial={DEFAULT_CONFIG}
      agents={[]}
      daemonLive
      appVersionInfo={null}
      onPersist={vi.fn()}
      onPersistComposioKey={vi.fn()}
      onClose={vi.fn()}
      onRefreshAgents={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Media providers/ }));
  // Each key is a compact row at rest; its field and buttons sit in the
  // details, so open every key row the way a user does.
  for (const title of ['Jev (TypeSafe)', 'DeepSeek (fast lane)', 'Cerebras (fast lane)']) {
    fireEvent.click(screen.getByRole('button', { name: `${title} details` }));
  }
  return result;
}

const keyField = () => screen.getByLabelText('TypeSafe API key') as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Settings → Media providers → Jev (TypeSafe)', () => {
  it('is discoverable through the real nav entry, with a password field', async () => {
    stubDaemon({ configured: true, source: 'stored' });
    renderAndNavigate();

    expect(await screen.findByText('Jev (TypeSafe)')).toBeTruthy();
    expect(keyField().type).toBe('password');
    await waitFor(() =>
      expect(screen.getByText('Configured with the key saved on this machine.')).toBeTruthy(),
    );
  });

  it.each([
    ['env', 'Configured from the TYPESAFE_API_KEY environment variable.'],
    ['vault', 'Configured from this machine’s local secret store.'],
    ['unset', 'Not configured. Routing and profiling will not run.'],
  ])('reports the %s source in words', async (source, copy) => {
    stubDaemon({ configured: source !== 'unset', source });
    renderAndNavigate();

    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
  });

  it('saves a key, reports the stored source, and keeps no copy of the key', async () => {
    const { puts } = stubDaemon({ configured: false, source: 'unset' });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Not configured. Routing and profiling will not run.')).toBeTruthy(),
    );
    fireEvent.change(keyField(), { target: { value: KEY } });
    fireEvent.click(button('Save key'));

    await waitFor(() => expect(screen.getByText('Key saved.')).toBeTruthy());
    expect(puts).toEqual([{ apiKey: KEY }]);
    expect(screen.getByText('Configured with the key saved on this machine.')).toBeTruthy();
    expect(keyField().value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('does not let a slow mount-time read overwrite a save that already landed', async () => {
    // The GET is issued on mount and can resolve at any time. A save that finished first is the
    // newer truth; a late answer describing the daemon as it was before must be discarded, or
    // the card tells the user their key did not stick.
    const { pendingGets } = stubDaemon({ configured: false, source: 'unset' }, { deferInitialGet: true });
    renderAndNavigate();
    await waitFor(() => expect(pendingGets).toHaveLength(1));

    fireEvent.change(keyField(), { target: { value: KEY } });
    fireEvent.click(button('Save key'));
    await waitFor(() => expect(screen.getByText('Key saved.')).toBeTruthy());

    pendingGets[0]!.resolve({ configured: false, source: 'unset' });

    await waitFor(() =>
      expect(screen.getByText('Configured with the key saved on this machine.')).toBeTruthy(),
    );
    expect(screen.queryByText('Not configured. Routing and profiling will not run.')).toBeNull();
  });

  it('refuses to save under an environment override, and says why', async () => {
    // The daemon reads TYPESAFE_API_KEY first, so a key stored while it is set would be written
    // to disk and then ignored. Offering the button would be offering a no-op.
    const { puts } = stubDaemon({ configured: true, source: 'env' });
    renderAndNavigate();

    await waitFor(() =>
      expect(
        screen.getByText(
          'A key from the environment is in effect. The daemon ignores a stored key while TYPESAFE_API_KEY is set.',
        ),
      ).toBeTruthy(),
    );
    fireEvent.change(keyField(), { target: { value: KEY } });
    expect(button('Save key').disabled).toBe(true);
    expect(puts).toHaveLength(0);
  });

  it('offers Clear whatever the source is, and a clear with nothing stored still succeeds', async () => {
    // Clearing is about the stored file, which may hold a key no status line mentions while the
    // environment shadows it. The daemon answers with whichever source survives.
    const { puts } = stubDaemon({ configured: true, source: 'env' });
    renderAndNavigate();

    await waitFor(() => expect(button('Clear key').disabled).toBe(false));
    fireEvent.click(button('Clear key'));

    await waitFor(() => expect(screen.getByText('Key cleared.')).toBeTruthy());
    expect(puts).toEqual([{ clear: true }]);
  });

  it('clears the stored key on an explicit Clear', async () => {
    const { puts } = stubDaemon({ configured: true, source: 'stored' });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Configured with the key saved on this machine.')).toBeTruthy(),
    );
    fireEvent.click(button('Clear key'));

    await waitFor(() => expect(screen.getByText('Key cleared.')).toBeTruthy());
    expect(puts).toEqual([{ clear: true }]);
    expect(screen.getByText('Not configured. Routing and profiling will not run.')).toBeTruthy();
  });

  it('does not send an empty field', async () => {
    stubDaemon({ configured: false, source: 'unset' });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Not configured. Routing and profiling will not run.')).toBeTruthy(),
    );
    expect(button('Save key').disabled).toBe(true);
  });

  it.each([
    ['whitespace', 'The key must not contain spaces or line breaks.'],
    ['empty', 'The key must not be empty.'],
    ['too-long', 'The key is longer than this daemon accepts.'],
    ['shape', 'The daemon refused the request.'],
  ])('translates the %s refusal instead of showing the daemon’s English', async (reason, copy) => {
    // The daemon has no locale. Its sentence would be English on every screen, so the client
    // renders its own copy from the stable reason the 400 carries.
    const { puts } = stubDaemon({ configured: false, source: 'unset' }, { putStatus: 400, putReason: reason });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Not configured. Routing and profiling will not run.')).toBeTruthy(),
    );
    fireEvent.change(keyField(), { target: { value: KEY } });
    fireEvent.click(button('Save key'));

    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(puts).toHaveLength(1);
    // The daemon's own sentence is never shown.
    expect(document.body.innerHTML).not.toContain('apiKey must not contain whitespace');
    // A rejected save leaves the field alone so the user can correct it.
    expect(keyField().value).toBe(KEY);
  });

  it('falls back to one localized line for a reason it does not know', async () => {
    stubDaemon({ configured: false, source: 'unset' }, { putStatus: 500 });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Not configured. Routing and profiling will not run.')).toBeTruthy(),
    );
    fireEvent.change(keyField(), { target: { value: KEY } });
    fireEvent.click(button('Save key'));

    await waitFor(() =>
      expect(screen.getByText('Could not update the key. Please try again.')).toBeTruthy(),
    );
  });

  it('says so when the daemon cannot be read at all', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/agency/config') throw new Error('daemon unreachable');
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('Could not read the Jev status from the local daemon.')).toBeTruthy(),
    );
  });
});

describe('Settings → Media providers → an unreadable key file', () => {
  it('offers to set the file aside on the Jev card only, then every card re-reads', async () => {
    let repaired = false;
    const posts: Array<{ url: string; body: unknown }> = [];
    const healthy = {
      configured: false,
      source: 'unset',
      models: { deepseek: { configured: false, source: 'unset' }, cerebras: { configured: false, source: 'unset' } },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/agency/config/repair') {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        repaired = true;
        return new Response(JSON.stringify({ ...healthy, repaired: true, movedTo: 'agency-config.json.corrupt-x' }), { status: 200 });
      }
      if (url === '/api/agency/config') {
        if (repaired) return new Response(JSON.stringify(healthy), { status: 200 });
        return new Response(JSON.stringify({ error: { code: 'AGENCY_CONFIG_UNREADABLE', message: 'x' } }), { status: 500 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    renderAndNavigate();

    const repairButton = await screen.findByRole('button', { name: 'Set the unreadable key file aside' });
    expect(screen.getAllByRole('button', { name: 'Set the unreadable key file aside' })).toHaveLength(1);
    fireEvent.click(repairButton);

    await waitFor(() =>
      expect(screen.getByText('The old key file was set aside (not deleted). Save your keys again.')).toBeTruthy(),
    );
    expect(posts).toEqual([{ url: '/api/agency/config/repair', body: { confirm: true } }]);
    expect(screen.queryByRole('button', { name: 'Set the unreadable key file aside' })).toBeNull();
    // The model cards re-read after the repair event.
    await waitFor(() =>
      expect(screen.getByText('DeepSeek: not configured. Builds that need it switch to the other provider.')).toBeTruthy(),
    );
  });
});

describe('Settings → Media providers → fill-model keys (DeepSeek, Cerebras)', () => {
  const MODEL_KEY = 'sk-deepseek-NEVER-IN-THE-DOM';

  function stubWithModels(models: Record<string, ConfigState>) {
    let state = { configured: true, source: 'stored', models };
    const puts: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url !== '/api/agency/config') return new Response(null, { status: 404 });
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(state), { status: 200 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { provider: string; clear?: true };
      puts.push(body);
      state = {
        ...state,
        models: {
          ...state.models,
          [body.provider]: body.clear ? { configured: false, source: 'unset' } : { configured: true, source: 'stored' },
        },
      };
      return new Response(JSON.stringify(state), { status: 200 });
    }) as unknown as typeof fetch;
    return { puts };
  }

  it('renders a card per provider, with the env source named by its variable', async () => {
    stubWithModels({ deepseek: { configured: true, source: 'env' }, cerebras: { configured: false, source: 'unset' } });
    renderAndNavigate();

    expect(await screen.findByText('DeepSeek (fast lane)')).toBeTruthy();
    expect(screen.getByText('Cerebras (fast lane)')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Configured from the DEEPSEEK_API_KEY environment variable.')).toBeTruthy(),
    );
    expect(screen.getByText('Cerebras: not configured. Builds that need it switch to the other provider.')).toBeTruthy();
    // The env key wins, so a DeepSeek save would be a no-op and is not offered.
    fireEvent.change(screen.getByLabelText('DeepSeek API key'), { target: { value: MODEL_KEY } });
    expect(button('Save DeepSeek key').disabled).toBe(true);
  });

  it('sends the provider with the key, and keeps no copy of it', async () => {
    const { puts } = stubWithModels({ deepseek: { configured: false, source: 'unset' }, cerebras: { configured: false, source: 'unset' } });
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('DeepSeek: not configured. Builds that need it switch to the other provider.')).toBeTruthy(),
    );
    const field = screen.getByLabelText('DeepSeek API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: MODEL_KEY } });
    fireEvent.click(button('Save DeepSeek key'));

    await waitFor(() =>
      expect(screen.getByText('DeepSeek: configured with the key saved on this machine.')).toBeTruthy(),
    );
    expect(puts).toEqual([{ provider: 'deepseek', apiKey: MODEL_KEY }]);
    expect(field.value).toBe('');
    expect(document.body.innerHTML).not.toContain(MODEL_KEY);

    fireEvent.click(button('Clear Cerebras key'));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ provider: 'cerebras', clear: true });
  });

  it('a model-key save that first finds the file unreadable shows the repair button on the Jev card', async () => {
    // Settings loaded while the file was healthy; it broke afterwards, so the DeepSeek PUT is the
    // first request to hear about it. The Jev card, not the DeepSeek card, owns the way out.
    const healthy = {
      configured: false,
      source: 'unset',
      models: { deepseek: { configured: false, source: 'unset' }, cerebras: { configured: false, source: 'unset' } },
    };
    let broken = false;
    let repaired = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/agency/config/repair') {
        repaired = true;
        return new Response(JSON.stringify({ ...healthy, repaired: true, movedTo: 'agency-config.json.corrupt-x' }), { status: 200 });
      }
      if (url !== '/api/agency/config') return new Response(null, { status: 404 });
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(healthy), { status: 200 });
      if (broken && !repaired) {
        return new Response(JSON.stringify({ error: { code: 'AGENCY_CONFIG_UNREADABLE', message: 'x' } }), { status: 409 });
      }
      return new Response(JSON.stringify(healthy), { status: 200 });
    }) as unknown as typeof fetch;
    renderAndNavigate();

    await waitFor(() =>
      expect(screen.getByText('DeepSeek: not configured. Builds that need it switch to the other provider.')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Set the unreadable key file aside' })).toBeNull();

    broken = true;
    fireEvent.change(screen.getByLabelText('DeepSeek API key'), { target: { value: MODEL_KEY } });
    fireEvent.click(button('Save DeepSeek key'));

    const repairButton = await screen.findByRole('button', { name: 'Set the unreadable key file aside' });
    expect(screen.getAllByRole('button', { name: 'Set the unreadable key file aside' })).toHaveLength(1);
    // The button sits on the Jev row, the one titled "Jev (TypeSafe)".
    const jevCard = screen.getByText('Jev (TypeSafe)').closest('.agency-key-row');
    expect(jevCard?.contains(repairButton)).toBe(true);

    fireEvent.click(repairButton);
    await waitFor(() =>
      expect(screen.getByText('The old key file was set aside (not deleted). Save your keys again.')).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Set the unreadable key file aside' })).toBeNull();
  });
});
