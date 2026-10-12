// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { FileViewer } from '../../src/components/FileViewer';
import {
  agencyDeployProjectSignals,
  isAgencySiteDeployProject,
} from '../../src/components/agency-deploy-signals';
import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { ProjectFile } from '../../src/types';

// The deploy result is reported to analytics as well as to the modal, and a
// result that is not a public link must not be reported as a success. The
// real provider hands unmounted consumers a no-op stub, so replacing only the
// hook keeps every other test in this file behaving exactly as before.
const analyticsTrack = vi.hoisted(() => vi.fn());
vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsTrack,
      setConsent: () => undefined,
      setIdentity: () => undefined,
      setConfigureGlobals: () => undefined,
      setUserId: () => undefined,
      anonymousId: 'test-anonymous',
      sessionId: 'test-session',
      newRequestId: () => 'test-request',
    }),
  };
});

function deployResultEvents(): Array<Record<string, unknown>> {
  return analyticsTrack.mock.calls
    .filter((call) => call[0] === 'artifact_deploy_result')
    .map((call) => call[1] as Record<string, unknown>);
}

afterEach(() => {
  analyticsTrack.mockClear();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function baseFile(overrides: Partial<ProjectFile>): ProjectFile {
  return {
    name: 'asset.png',
    path: 'asset.png',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'image',
    mime: 'image/png',
    ...overrides,
  };
}

function deployableHtmlFile(): ProjectFile {
  return baseFile({
    name: 'index.html',
    path: 'index.html',
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  });
}

/**
 * Wires the fetch routes the Cloudflare Pages deploy modal exercises on open
 * and on submit, and reports the JSON body of the outgoing deploy POST back
 * to the caller so a test can assert what target the UI forwarded.
 */
function mockDeployFetch(
  onDeployBody: (body: Record<string, unknown>) => void,
  options: {
    configDelayMs?: number;
    vercelConfigDelayMs?: number;
    cloudflareConfigDelayMs?: number;
    refusePublicAccess?: boolean;
    /** The deploy answers with Vercel's Security Checkpoint outcome. */
    challengePublicAccess?: boolean;
    /** The `access` a ready deploy reports; defaults to `public`. */
    access?: 'public' | 'protected' | 'unknown' | null;
    /** The daemon's `statusMessage` for a ready deploy. */
    readyStatusMessage?: string;
    warnings?: { code: string; path?: string; message: string }[];
    /** The deploy could not read the project's protection: status and access `unknown`. */
    protectionReadFailed?: boolean;
    assignedVercelAlias?: string;
  } = {},
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');

    if (url === '/api/projects/project-1/deployments') {
      return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
    }
    // FileWorkspace mounts the viewer from the project's own files rather than
    // a `liveHtml` prop, so the raw-file read has to answer.
    if (url.startsWith('/api/projects/project-1/raw/')) {
      return new Response('<html><body><h1>Hello</h1></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    if (url.startsWith('/api/projects/project-1/files')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (url === '/api/deploy/config?providerId=vercel-self') {
      if (options.vercelConfigDelayMs ?? options.configDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.vercelConfigDelayMs ?? options.configDelayMs));
      }
      return new Response(JSON.stringify({
        providerId: 'vercel-self',
        configured: true,
        tokenMask: 'saved-vercel-token',
        teamId: '',
        teamSlug: '',
        target: 'preview',
      }), { status: 200 });
    }
    if (url === '/api/deploy/config?providerId=cloudflare-pages') {
      if (options.cloudflareConfigDelayMs ?? options.configDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.cloudflareConfigDelayMs ?? options.configDelayMs));
      }
      return new Response(JSON.stringify({
        providerId: 'cloudflare-pages',
        configured: true,
        tokenMask: 'saved-cloudflare-token',
        teamId: '',
        teamSlug: '',
        accountId: 'account-123',
        projectName: '',
        target: 'preview',
      }), { status: 200 });
    }
    if (url === '/api/deploy/config' && method === 'PUT') {
      const saved = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const vercel = saved.providerId !== 'cloudflare-pages';
      return new Response(JSON.stringify({
        providerId: saved.providerId ?? 'vercel-self',
        configured: true,
        tokenMask: vercel ? 'saved-vercel-token' : 'saved-cloudflare-token',
        teamId: '',
        teamSlug: '',
        ...(vercel ? {} : { accountId: 'account-123', projectName: '' }),
        target: 'preview',
      }), { status: 200 });
    }
    if (url === '/api/deploy/cloudflare-pages/zones') {
      return new Response(JSON.stringify({ zones: [] }), { status: 200 });
    }
    if (url === '/api/projects/project-1/deploy' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      onDeployBody(body);
      const vercel = body.providerId === 'vercel-self';
      // A refusal is only possible when the change was actually asked for.
      const refused = vercel && options.refusePublicAccess === true && body.publicAccess === true;
      const challenged = vercel && options.challengePublicAccess === true && body.publicAccess === true;
      if (vercel && options.protectionReadFailed) {
        return new Response(JSON.stringify({
          id: 'vercel-deploy', projectId: 'project-1', fileName: 'index.html', providerId: 'vercel-self',
          url: 'https://demo.vercel.app', deploymentId: 'vercel-dep-1', deploymentCount: 1, target: 'preview',
          status: 'unknown', access: 'unknown', publicAccess: true, publicAccessOutcome: 'read-failed',
          statusMessage: "Could not read the Vercel project's settings, so deployment protection was left on.",
          createdAt: 1, updatedAt: 2,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: vercel ? 'vercel-deploy' : 'cloudflare-deploy',
        projectId: 'project-1',
        fileName: 'index.html',
        providerId: body.providerId ?? 'cloudflare-pages',
        url: vercel ? `https://${options.assignedVercelAlias ?? 'demo.vercel.app'}` : 'https://demo-pages.pages.dev',
        ...(vercel && options.assignedVercelAlias ? { vercel: {
          projectName: 'bobs-bakery', requestedAddress: 'bobs-bakery.vercel.app',
          assignedAlias: options.assignedVercelAlias, stableUrl: `https://${options.assignedVercelAlias}`,
        } } : {}),
        deploymentId: vercel ? 'vercel-dep-1' : 'cf-dep-1',
        deploymentCount: 1,
        target: body.target ?? 'preview',
        warnings: options.warnings,
        status: refused ? 'protected' : challenged ? 'challenged' : 'ready',
        // The daemon's English sentence: present, but the UI must render its
        // own localized copy keyed off publicAccessOutcome instead.
        statusMessage: refused
          ? 'Vercel refused to turn deployment protection off for this project. The preview stays behind its protection wall.'
          : challenged
            ? "Vercel's Security Checkpoint challenged the request."
            : options.readyStatusMessage ?? 'Public link is ready.',
        ...(refused || challenged
          ? {}
          : options.access === null ? {} : { access: options.access ?? 'public' }),
        ...(vercel && body.publicAccess !== undefined ? { publicAccess: body.publicAccess } : {}),
        ...(refused ? { publicAccessOutcome: 'patch-rejected' } : {}),
        ...(challenged ? { publicAccessOutcome: 'challenged' } : {}),
        createdAt: 1,
        updatedAt: 2,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
}

async function openCloudflareDeployModal(file: ProjectFile) {
  render(
    <FileViewer projectId="project-1" projectKind="prototype" file={file}
      liveHtml="<html><body><h1>Hello</h1></body></html>"
    />,
  );

  // Deploy providers live on the Share panel ("publish online" is sharing),
  // so reaching a provider takes Share button -> menu item.
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Deploy to Cloudflare Pages/i }));

  const providerSelect = await screen.findByRole('combobox', { name: /Provider/i });
  await waitFor(() => {
    expect((providerSelect as HTMLSelectElement).value).toBe('cloudflare-pages');
  });
}

function renderViewer(
  file: ProjectFile,
  props: { projectSkillId?: string | null; projectPluginId?: string | null; projectName?: string } = {},
) {
  return render(
    <FileViewer projectId="project-1" projectKind="prototype" file={file}
      liveHtml="<html><body><h1>Hello</h1></body></html>"
      {...props}
    />,
  );
}

async function clickVercelDeployMenuItem() {
  // The Share control appears with the viewer toolbar, which waits on the
  // file's content when the viewer is mounted by FileWorkspace.
  fireEvent.click(await screen.findByRole('button', { name: /^share$/i }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Deploy to Vercel/i }));
}

async function openVercelDeployModal(
  file: ProjectFile,
  props: { projectSkillId?: string | null; projectPluginId?: string | null; projectName?: string } = {},
) {
  renderViewer(file, props);
  await clickVercelDeployMenuItem();

  const providerSelect = await screen.findByRole('combobox', { name: /Provider/i });
  await waitFor(() => {
    expect((providerSelect as HTMLSelectElement).value).toBe('vercel-self');
  });
}

function deploySubmitButton() {
  const buttons = screen.getAllByRole('button', { name: /^Deploy$/i });
  return buttons[buttons.length - 1]!;
}

function closeDeployModal() {
  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
}

function clickDeploySubmitButton() {
  const deployButtons = screen.getAllByRole('button', { name: /^Deploy$/i });
  // The share-menu trigger is also labelled "Deploy to Cloudflare Pages"; the
  // modal's own submit button is the last "Deploy"-named button on screen.
  fireEvent.click(deployButtons[deployButtons.length - 1]!);
}

describe('FileViewer deploy target selector', () => {
  it('shows the provider-assigned address when it differs from the requested address', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { assignedVercelAlias: 'bobs-bakery-suffix.vercel.app' }));
    await openVercelDeployModal(deployableHtmlFile(), { projectName: "Bob’s Bakery" });
    await waitFor(() => expect(deploySubmitButton()).not.toBeDisabled());
    clickDeploySubmitButton();
    const assignedLinks = await screen.findAllByRole('link', { name: 'https://bobs-bakery-suffix.vercel.app' });
    for (const link of assignedLinks) expect(link).toHaveAttribute('href', 'https://bobs-bakery-suffix.vercel.app');
    expect(document.querySelector('.deploy-result-url')).toHaveTextContent('https://bobs-bakery-suffix.vercel.app');
    expect(screen.queryByRole('link', { name: 'https://bobs-bakery.vercel.app' })).toBeNull();
  });

  it('prefills the Vercel address from the project name and validates before deploy', async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch(value => { body = value; }));
    renderViewer(deployableHtmlFile(), { projectName: "Bob’s Bakery" });
    await clickVercelDeployMenuItem();
    const field = await screen.findByRole('textbox', { name: /Site address/i });
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('bobs-bakery'));
    fireEvent.change(field, { target: { value: 'a.b' } });
    expect((deploySubmitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'bobs-bakery' } });
    await waitFor(() => expect((deploySubmitButton() as HTMLButtonElement).disabled).toBe(false));
    clickDeploySubmitButton();
    await waitFor(() => expect(body).toMatchObject({ vercel: { projectName: 'bobs-bakery' } }));
  });

  it('shows a deploy target selector defaulted to Production and forwards that default on deploy', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openCloudflareDeployModal(deployableHtmlFile());

    const targetSelect = await screen.findByRole('combobox', { name: /target/i });
    expect((targetSelect as HTMLSelectElement).value).toBe('production');

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    // Default semantics: the daemon already treats an absent target as
    // production (apps/daemon/src/routes/deploy.ts), so the UI's default
    // must match that and explicitly send 'production' — leaving it
    // undefined or sending 'preview' would silently deploy to preview
    // instead of updating the live site, which is the regression this test
    // guards against.
    expect(deployBody!.target).toBe('production');
  });

  it('sends target: "preview" in the deploy request when the user selects the Preview target', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openCloudflareDeployModal(deployableHtmlFile());

    const targetSelect = await screen.findByRole('combobox', { name: /target/i });
    fireEvent.change(targetSelect, { target: { value: 'preview' } });
    await waitFor(() => {
      expect((targetSelect as HTMLSelectElement).value).toBe('preview');
    });

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.target).toBe('preview');
  });

  it('sends target: "production" in the deploy request when the user selects the Production target', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openCloudflareDeployModal(deployableHtmlFile());

    const targetSelect = await screen.findByRole('combobox', { name: /target/i });
    fireEvent.change(targetSelect, { target: { value: 'production' } });
    await waitFor(() => {
      expect((targetSelect as HTMLSelectElement).value).toBe('production');
    });

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.target).toBe('production');
  });
});

describe('FileViewer make-preview-public checkbox', () => {
  it('defaults the checkbox on for an agency-site project and forwards publicAccess: true', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openVercelDeployModal(deployableHtmlFile(), { projectSkillId: 'agency-site' });

    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(true);
  });

  it('defaults the checkbox off for a project that is not an agency site', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openVercelDeployModal(deployableHtmlFile());

    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(false);
  });

  it('defaults the checkbox on for a project bound to an example-agency-* plugin', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}));

    await openVercelDeployModal(deployableHtmlFile(), { projectPluginId: 'example-agency-emmpo' });

    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('forwards publicAccess: true once the user ticks the checkbox, and shows the daemon status message', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }));

    await openVercelDeployModal(deployableHtmlFile());

    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect((checkbox as HTMLInputElement).checked).toBe(true);
    });

    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(true);
    // The daemon's own statusMessage is what the result block shows; a
    // successful publicAccess deploy says the link is public, not walled.
    expect((await screen.findAllByText(/Public link is ready\./i)).length).toBeGreaterThan(0);
  });

  it('surfaces the refusal only for a deploy that actually asked to be public', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }, { refusePublicAccess: true }));

    await openVercelDeployModal(deployableHtmlFile());

    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect((checkbox as HTMLInputElement).checked).toBe(true);
    });
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    clickDeploySubmitButton();

    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(true);
    expect(await screen.findByText(/Vercel refused to make this preview public/i)).toBeTruthy();
  });

  it('hides the checkbox for Cloudflare Pages, which has no such setting', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}));

    await openCloudflareDeployModal(deployableHtmlFile());

    expect(screen.queryByRole('checkbox', { name: /make preview public/i })).toBeNull();
  });
});

describe('FileViewer make-preview-public safety and copy', () => {
  // Sol finding 1: the modal used to open before the asynchronous provider
  // load reset the checkbox, and submit stayed enabled during that load — so a
  // non-agency user could tick the box, cancel, reopen and deploy with a stale
  // `true` they never asked for on the second deploy.
  it('does not carry a ticked box across a cancel and reopen on a non-agency project', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }, { configDelayMs: 30 }));

    await openVercelDeployModal(deployableHtmlFile());
    fireEvent.click(await screen.findByRole('checkbox', { name: /make preview public/i }));
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(true);
    });

    closeDeployModal();
    await clickVercelDeployMenuItem();

    // The reopened modal must show the project's own default immediately, not
    // the previous session's tick — including while the config is still loading.
    const reopened = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((reopened as HTMLInputElement).checked).toBe(false);

    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());
    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(false);
  });

  it('disables the deploy button until the provider config has loaded', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { configDelayMs: 40 }));

    renderViewer(deployableHtmlFile());
    await clickVercelDeployMenuItem();

    expect(deploySubmitButton()).toBeDisabled();
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
  });

  // Sol finding 2: the daemon's English sentence cannot be localized, so the
  // UI renders its own copy keyed off the stable outcome code.
  it('renders localized copy for the outcome code rather than the daemon sentence', async () => {
    let deployBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', mockDeployFetch((body) => { deployBody = body; }, { refusePublicAccess: true }));

    await openVercelDeployModal(deployableHtmlFile(), { projectSkillId: 'agency-site' });
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    expect((screen.getByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(deploySubmitButton());
    await waitFor(() => {
      expect(deployBody).not.toBeNull();
    });
    expect(deployBody!.publicAccess).toBe(true);

    expect(await screen.findByText(/Vercel refused to make this preview public/i)).toBeTruthy();
  });

  it('keeps the daemon sentence when an outcome code is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url === '/api/projects/project-1/deployments') {
        return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
      }
      if (url === '/api/deploy/config?providerId=vercel-self') {
        return new Response(JSON.stringify({
          providerId: 'vercel-self', configured: true, tokenMask: 'saved-vercel-token',
          teamId: '', teamSlug: '', target: 'preview',
        }), { status: 200 });
      }
      if (url === '/api/projects/project-1/deploy' && method === 'POST') {
        return new Response(JSON.stringify({
          id: 'vercel-deploy', projectId: 'project-1', fileName: 'index.html',
          providerId: 'vercel-self', url: 'https://demo.vercel.app', deploymentId: 'vercel-dep-1',
          deploymentCount: 1, target: 'preview', status: 'protected',
          statusMessage: 'Preview is behind Vercel Authentication (project setting: all).',
          createdAt: 1, updatedAt: 2,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));

    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    expect(await screen.findByText(/behind Vercel Authentication/i)).toBeTruthy();
  });
});

// A reachable link is not a public one. `access` decides the sentence and the
// label; the daemon's English "Public link is ready." never reaches the UI for
// a link whose protection could not be confirmed off.
describe('FileViewer deploy access', () => {
  it('shows recoverable publication warnings in the deploy result', async () => {
    const message = 'Skipped missing navigation target: old.html';
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { access: 'public', warnings: [{ code: 'broken-reference', path: 'old.html', message }] }));
    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => expect(deploySubmitButton()).not.toBeDisabled());
    fireEvent.click(deploySubmitButton());
    expect(await screen.findByText(message)).toBeTruthy();
    expect(document.querySelector('.deploy-result-block')?.textContent).toContain(message);
  });

  it.each([
    ['unknown', 'unknown' as const],
    ['missing (older daemon)', null],
  ])('renders the unconfirmed sentence and label when access is %s', async (_name, access) => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { access }));

    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    expect((await screen.findAllByText(/could not confirm the link is public/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Not confirmed public')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Public link is ready/i)).toBeNull();
  });

  it('renders the public sentence only when access is public', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { access: 'public' }));

    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    expect((await screen.findAllByText(/Anyone with the link can open it/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not confirmed public')).toBeNull();
  });

  it('renders the protected copy for a reachable link on a protected project', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { access: 'protected' }));

    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    expect((await screen.findAllByText(/requiring authentication/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Public link is ready/i)).toBeNull();
  });
});

// Review fixes (M6): Retry for an unconfirmed link, social sharing only for a
// confirmed-public link, and daemon detail kept for a ready link.
describe('FileViewer deploy access follow-ups', () => {
  async function deployWith(options: Parameters<typeof mockDeployFetch>[1]) {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, options));
    await openVercelDeployModal(deployableHtmlFile());
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());
    await waitFor(() => {
      expect(document.querySelector('.deploy-result-link')).not.toBeNull();
    });
    return document.querySelector('.deploy-result-link') as HTMLElement;
  }
  const hasRetry = (card: HTMLElement) =>
    Array.from(card.querySelectorAll('button')).some((button) => /retry now/i.test(button.textContent || ''));

  it('offers Retry on a reachable link whose access is unknown', async () => {
    const card = await deployWith({ access: 'unknown' });
    expect(hasRetry(card)).toBe(true);
  });

  // A failed protection read is `unknown`, never a claimed wall: the badge
  // and the card say "Not confirmed public", Retry stays, Open stays live.
  it('renders the unknown badge, not the protected one, when the protection read failed', async () => {
    const card = await deployWith({ protectionReadFailed: true });
    const badge = document.querySelector('.deploy-result-badge') as HTMLElement;
    expect(badge.textContent).toBe('Not confirmed public');
    expect(badge.classList.contains('unknown')).toBe(true);
    expect(badge.classList.contains('protected')).toBe(false);
    expect(card.querySelector('.deploy-result-link-state')?.textContent).toBe('Not confirmed public');
    expect(screen.queryByText('Deployment protection enabled')).toBeNull();
    expect(hasRetry(card)).toBe(true);
    expect(card.classList.contains('unknown')).toBe(true);
  });

  it('does not offer Retry on a confirmed-public link', async () => {
    const card = await deployWith({ access: 'public' });
    expect(hasRetry(card)).toBe(false);
  });

  it.each(['unknown', 'protected'] as const)('offers no social share for a ready link whose access is %s', async (access) => {
    await deployWith({ access });
    // Give the async share payload a chance to land, then check it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('.deploy-social-share .social-share-grid')).toBeNull();
    expect(document.querySelector('.deploy-social-share.is-locked')).not.toBeNull();
  });

  it('offers social share for a confirmed-public link', async () => {
    await deployWith({ access: 'public' });
    await waitFor(() => {
      expect(document.querySelector('.deploy-social-share .social-share-grid')).not.toBeNull();
    });
  });

  it('keeps a daemon detail sentence after the access sentence for a ready link', async () => {
    await deployWith({ access: 'unknown', readyStatusMessage: 'Cloudflare Pages and custom domain are ready.' });
    const message = document.querySelector('.deploy-result-message')?.textContent || '';
    expect(message).toMatch(/could not confirm the link is public/i);
    expect(message).toMatch(/custom domain are ready/);
  });

  it('drops the daemon generic sentence instead of repeating it', async () => {
    await deployWith({ access: 'public' });
    const message = document.querySelector('.deploy-result-message')?.textContent || '';
    expect(message).toMatch(/Anyone with the link can open it/);
    expect(message).not.toMatch(/Public link is ready\. .*Public link is ready/);
    expect(message.match(/Public link is ready\./g)?.length ?? 0).toBe(1);
  });
});

// Vercel's Security Checkpoint is its own outcome: the deployment is up and
// the protection is off, but an anonymous visitor meets bot mitigation. It is
// not a wall (a browser passes it) and it is not a public link either, so it
// gets its own copy, keeps Retry link and Open, and is never reported as a
// successful deploy.
describe('FileViewer Security Checkpoint deploy outcome', () => {
  it('renders the checkpoint copy and keeps Retry link and Open available', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { challengePublicAccess: true }));

    await openVercelDeployModal(deployableHtmlFile(), { projectSkillId: 'agency-site' });
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    // The localized sentence, not the daemon's English one-liner.
    expect(
      (await screen.findAllByText(/Security Checkpoint is challenging visitors/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Vercel's Security Checkpoint challenged the request.")).toBeNull();
    expect(screen.getAllByText('Security checkpoint').length).toBeGreaterThan(0);

    // A checkpoint can clear, so asking again is worth an offer.
    const resultCard = document.querySelector('.deploy-result-link.challenged');
    expect(resultCard).not.toBeNull();
    expect(
      Array.from(resultCard!.querySelectorAll('button')).some((button) =>
        /retry now/i.test(button.textContent || '')),
    ).toBe(true);
    // And the one thing that actually passes a checkpoint is opening the link
    // in a browser, so Open must not be disabled the way a wall disables it.
    const openLink = Array.from(resultCard!.querySelectorAll('a.ghost-link'))[0]!;
    expect(openLink.getAttribute('aria-disabled')).toBe('false');
    expect(openLink.getAttribute('href')).toBe('https://demo.vercel.app');
  });

  it('never fires the deployment-success toast or a success analytics result', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { challengePublicAccess: true }));

    await openVercelDeployModal(deployableHtmlFile(), { projectSkillId: 'agency-site' });
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    await screen.findAllByText(/Security Checkpoint is challenging visitors/i);
    await waitFor(() => {
      expect(deployResultEvents().length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Deployment uploaded successfully')).toBeNull();
    expect(deployResultEvents().some((event) => event.result === 'success')).toBe(false);
    expect(deployResultEvents().at(-1)).toMatchObject({
      result: 'failed',
      error_code: 'STATUS_challenged',
    });
  });

  it('still reports a ready deploy as a success', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}));

    await openVercelDeployModal(deployableHtmlFile(), { projectSkillId: 'agency-site' });
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    fireEvent.click(deploySubmitButton());

    await waitFor(() => {
      expect(deployResultEvents().some((event) => event.result === 'success')).toBe(true);
    });
    expect(await screen.findByText('Deployment uploaded successfully')).toBeTruthy();
  });
});

// The default the checkbox starts at is decided from project data that travels
// ProjectView -> FileWorkspace -> FileViewer. This exercises the reading of
// that data, which is the part a wrong prop name would silently break.
describe('agency deploy project signals', () => {
  it('reads the persisted Skill id', () => {
    const signals = agencyDeployProjectSignals({ skillId: 'agency-site', metadata: {} });
    expect(signals).toEqual({ skillId: 'agency-site', pluginId: null });
    expect(isAgencySiteDeployProject(signals)).toBe(true);
  });

  it('reads the bound example plugin id out of project metadata', () => {
    // The real ProjectExampleBinding shape, as ProjectView hands it over.
    const exampleBinding = {
      schemaVersion: 1 as const,
      provenance: 'example_card' as const,
      pluginId: 'example-agency-emmpo',
      pluginSource: 'local',
      manifestSourceDigest: 'a'.repeat(64),
      boundAt: 1,
    };
    const signals = agencyDeployProjectSignals({ skillId: null, metadata: { exampleBinding } });
    expect(signals).toEqual({ skillId: null, pluginId: 'example-agency-emmpo' });
    expect(isAgencySiteDeployProject(signals)).toBe(true);
  });

  it('says no for an ordinary project, and for a non-agency plugin', () => {
    expect(isAgencySiteDeployProject(agencyDeployProjectSignals({ skillId: null }))).toBe(false);
    const deckBinding = { pluginId: 'example-deck-keynote' };
    expect(isAgencySiteDeployProject(agencyDeployProjectSignals({
      skillId: 'web-prototype',
      metadata: { exampleBinding: deckBinding },
    }))).toBe(false);
  });
});

describe('FileViewer public-access loading and real prop path', () => {
  // Sol pass 2, finding 2: the loading flag was shared, so an older provider
  // load finishing could enable Deploy while the newest config was still in
  // flight — the form on screen would not be the one that gets deployed.
  it('keeps Deploy disabled while the newest provider config is still loading', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, {
      vercelConfigDelayMs: 60,
      cloudflareConfigDelayMs: 400,
    }));

    renderViewer(deployableHtmlFile());
    await clickVercelDeployMenuItem();

    // Switch provider while the FIRST load is still in flight. The first load
    // then finishes while the second is still pending — a shared flag cleared
    // in a `finally` enables Deploy right here, against a form that is about
    // to be replaced by the Cloudflare config.
    const providerSelect = await screen.findByRole('combobox', { name: /Provider/i });
    fireEvent.change(providerSelect, { target: { value: 'cloudflare-pages' } });

    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(deploySubmitButton()).toBeDisabled();

    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    }, { timeout: 3000 });
  });

  // Sol pass 1, finding 1 (remaining half): the default must follow the
  // project, not the last modal, when the project itself changes.
  it('follows the project when an agency viewer is replaced by a non-agency one', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}, { configDelayMs: 25 }));

    const view = renderViewer(deployableHtmlFile(), { projectSkillId: 'agency-site' });
    await clickVercelDeployMenuItem();
    expect((await screen.findByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(true);

    view.unmount();
    cleanup();

    renderViewer(deployableHtmlFile(), { projectSkillId: 'web-prototype' });
    await clickVercelDeployMenuItem();
    const next = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((next as HTMLInputElement).checked).toBe(false);
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(false);
    });
  });

  // Sol pass 2, finding 8: prove the props actually travel the real component
  // path rather than only that the reader function works.
  it('carries the agency signals through FileWorkspace into the deploy modal', async () => {
    vi.stubGlobal('fetch', mockDeployFetch(() => {}));

    const file = deployableHtmlFile();
    const project = {
      skillId: null,
      metadata: { exampleBinding: { pluginId: 'example-agency-emmpo' } },
    };
    const signals = agencyDeployProjectSignals(project);
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        projectSkillId={signals.skillId}
        projectPluginId={signals.pluginId}
        files={[file]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [file.name], active: file.name }}
        onTabsStateChange={vi.fn()}
      />,
    );

    await clickVercelDeployMenuItem();
    const checkbox = await screen.findByRole('checkbox', { name: /make preview public/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
});

describe('FileViewer public-access default follows the live project', () => {
  // Sol pass 3, finding 1: the config-load continuation restored the default
  // captured by the render that STARTED the request. The same mounted project
  // can change from agency to non-agency when its detail record reconciles —
  // the project id never changes, so the provider sequence gate sees nothing
  // wrong and the stale `true` is restored with Deploy enabled.
  it('does not restore a stale agency default when the project changes mid-load', async () => {
    let releaseConfig: () => void = () => {};
    const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url === '/api/projects/project-1/deployments') {
        return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
      }
      if (url === '/api/deploy/config?providerId=vercel-self') {
        await configGate;
        return new Response(JSON.stringify({
          providerId: 'vercel-self', configured: true, tokenMask: 'saved-vercel-token',
          teamId: '', teamSlug: '', target: 'preview',
        }), { status: 200 });
      }
      if (url.startsWith('/api/projects/project-1/raw/')) {
        return new Response('<html><body><h1>Hello</h1></body></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        });
      }
      if (url === '/api/projects/project-1/deploy' && method === 'POST') {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));

    const file = deployableHtmlFile();
    const { rerender } = render(
      <FileViewer projectId="project-1" projectKind="prototype" file={file}
        liveHtml="<html><body><h1>Hello</h1></body></html>"
        projectSkillId="agency-site"
      />,
    );
    await clickVercelDeployMenuItem();
    expect((await screen.findByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(true);

    // Same mount, same project id, reconciled detail: no longer an agency site.
    rerender(
      <FileViewer projectId="project-1" projectKind="prototype" file={file}
        liveHtml="<html><body><h1>Hello</h1></body></html>"
        projectSkillId="web-prototype"
      />,
    );
    await waitFor(() => {
      expect((screen.getByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(false);
    });

    // Now let the in-flight config land. Its continuation must not resurrect
    // the default the project no longer has.
    releaseConfig();
    await waitFor(() => {
      expect(deploySubmitButton()).not.toBeDisabled();
    });
    expect((screen.getByRole('checkbox', { name: /make preview public/i }) as HTMLInputElement).checked).toBe(false);
  });
});
