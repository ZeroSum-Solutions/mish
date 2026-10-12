// @vitest-environment jsdom
//
// D15 (QA sweep 3 P1-2): Website clone needs a web address to clone. A brief
// that names none ("not a url") must stop on Home with an inline error and
// never reach the create path — the daemon would refuse it anyway, and the
// user can fix it right here. A brief that names a URL goes through, and a
// daemon REFERENCE_URL_REFUSED (a loopback or private address) is shown as the
// daemon wrote it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { ProjectCreateError } from '../../src/state/projects';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: vi.fn(),
      newRequestId: () => 'request-1',
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
    }),
  };
});

const SEED = 'Website URL to clone: ';

function scenarioPlugin(id: string, title: string) {
  return {
    id,
    title,
    version: '0.1.0',
    trust: 'bundled' as const,
    sourceKind: 'bundled' as const,
    source: `/tmp/${id}`,
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '0.1.0',
      description: title,
      od: { kind: 'scenario', taskKind: 'new-generation', useCase: { query: `${title} brief.` } },
    },
  };
}

const fetchCalls: string[] = [];

function stubFetch() {
  const plugins = [
    scenarioPlugin('example-web-clone', 'Website clone'),
    scenarioPlugin('od-new-generation', 'New generation'),
    scenarioPlugin('example-web-prototype', 'Prototype'),
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    fetchCalls.push(`${init?.method ?? 'GET'} ${href}`);
    if (href === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
}

function renderHome(onSubmit: (...args: unknown[]) => unknown) {
  return render(
    <I18nProvider initial="en">
      <HomeView
        projects={[]}
        onSubmit={onSubmit as never}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />
    </I18nProvider>,
  );
}

async function pickWebClone() {
  // Let Home's catalog load settle first, so a late default binding cannot
  // replace the Website clone pick after it lands.
  await waitFor(() => expect(fetchCalls).toContain('GET /api/plugins'));
  const pill = await screen.findByTestId('home-hero-type-pill-web-clone');
  await waitFor(() => expect((pill as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(pill);
  await waitFor(() => {
    expect(screen.getByTestId('home-hero-type-pill-web-clone').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('home-hero-input').textContent ?? '').toContain(SEED);
  });
}

async function send(text: string) {
  setHomeHeroPrompt(text);
  await waitFor(() =>
    expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByTestId('home-hero-submit'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchCalls.length = 0;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Website clone checks the target URL before creating anything', () => {
  it('shows an inline error for a brief with no URL and makes no create request', async () => {
    writeHomeGuideStage('done');
    stubFetch();
    const onSubmit = vi.fn(() => true);
    renderHome(onSubmit);

    await pickWebClone();
    await send(`${SEED}not a url`);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en['home.webCloneUrlInvalid']);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchCalls.some((call) => call.startsWith('POST /api/projects'))).toBe(false);
  });

  it('sends a brief that names a URL', async () => {
    writeHomeGuideStage('done');
    stubFetch();
    const onSubmit = vi.fn(() => true);
    renderHome(onSubmit);

    await pickWebClone();
    await send(`${SEED}https://example.com`);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(en['home.webCloneUrlInvalid'])).toBeNull();
  });

  it("shows the daemon's REFERENCE_URL_REFUSED message when the server refuses", async () => {
    writeHomeGuideStage('done');
    stubFetch();
    const refusal = 'The website to clone is not a public web address.';
    const onSubmit = vi.fn(() => {
      throw new ProjectCreateError(refusal, 422, 'REFERENCE_URL_REFUSED', false, null);
    });
    renderHome(onSubmit);

    await pickWebClone();
    await send(`${SEED}http://127.0.0.1:8080`);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(refusal);
  });
});
