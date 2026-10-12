// @vitest-environment jsdom

import { act } from 'react';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary, type WorkspaceCollabContext } from '@mish/contracts';

const workspaceContextOverride = vi.hoisted(() => ({ context: null as WorkspaceCollabContext | null }));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => ({
      context: workspaceContextOverride.context,
      loading: false,
      failure: workspaceContextOverride.context ? undefined : 'unsupported' as const,
    }),
  };
});

import { HomeView } from '../../src/components/HomeView';
import { invalidatePluginCatalogCache, listPlugins } from '../../src/state/projects';
import { currentWorkspaceAccountGeneration } from '../../src/collab/useWorkspaceContext';
import { requestHomeChip } from '../../src/runtime/home-intent';
import {
  createPluginAuthoringHandoff,
  createPluginUseHandoff,
  PLUGIN_AUTHORING_DEFAULT_GOAL,
  PLUGIN_AUTHORING_PROMPT,
} from '../../src/components/home-hero/plugin-authoring';
// HomeHero's `home-hero-input` is now the project composer's Lexical
// contenteditable, not a <textarea>. These helpers drive/read it through the
// live editor instead of synthetic `fireEvent.change` / `.value` (which are
// no-ops on a contenteditable).
import {
  homeHeroPromptText,
  setHomeHeroPrompt,
} from '../helpers/home-hero-lexical';

const AUTHORING_PLUGIN = {
  id: 'od-plugin-authoring',
  title: 'Plugin authoring',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/plugin-authoring',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/plugin-authoring',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'od-plugin-authoring',
    title: 'Plugin authoring',
    version: '0.1.0',
    description: 'Create plugins',
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: { query: 'Create a Mishh Mashh plugin for {{pluginGoal}}.' },
      inputs: [
        {
          name: 'pluginGoal',
          type: 'string',
          required: false,
          default: PLUGIN_AUTHORING_DEFAULT_GOAL,
          label: 'Plugin goal',
        },
      ],
    },
  },
};

const DEFAULT_PLUGIN = {
  ...AUTHORING_PLUGIN,
  id: 'od-new-generation',
  title: 'New generation',
  source: '/tmp/new-generation',
  fsPath: '/tmp/new-generation',
  manifest: {
    ...AUTHORING_PLUGIN.manifest,
    name: 'od-new-generation',
    title: 'New generation',
    description: 'Create new design artifacts',
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: { query: 'Create a plugin.' },
    },
  },
};

const DOCUMENT_NEW_GENERATION_PLUGIN = {
  ...DEFAULT_PLUGIN,
  manifest: {
    ...DEFAULT_PLUGIN.manifest,
    od: {
      ...DEFAULT_PLUGIN.manifest.od,
      useCase: {
        query: 'Generate a {{artifactKind}} for {{audience}} on {{topic}}.',
      },
      inputs: [
        {
          name: 'artifactKind',
          type: 'string',
          required: true,
          label: 'Artifact kind',
        },
        {
          name: 'audience',
          type: 'string',
          required: true,
          label: 'Audience',
        },
        {
          name: 'topic',
          type: 'string',
          required: true,
          label: 'Topic',
        },
      ],
    },
  },
};

const HIDDEN_DEFAULT_PLUGIN = {
  ...DEFAULT_PLUGIN,
  id: 'od-default',
  title: 'Default design router',
  source: '/tmp/default-router',
  fsPath: '/tmp/default-router',
  manifest: {
    ...DEFAULT_PLUGIN.manifest,
    name: 'od-default',
    title: 'Default design router',
    od: {
      ...DEFAULT_PLUGIN.manifest.od,
      hidden: true,
    },
  },
};

// Keep the legacy web-prototype record available for explicit presets and for
// ordinary routes such as Wireframe / Mobile. The exact UI Mockup automatic
// route is asserted below to bypass this record entirely in favor of OD Next.
const WEB_PROTOTYPE_PLUGIN = {
  ...DEFAULT_PLUGIN,
  id: 'example-web-prototype',
  title: 'Web Prototype',
  source: '/tmp/web-prototype',
  fsPath: '/tmp/web-prototype',
  manifest: {
    ...DEFAULT_PLUGIN.manifest,
    name: 'example-web-prototype',
    title: 'Web Prototype',
    description: 'General-purpose desktop web prototype.',
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: {
        query: 'Build a {{fidelity}} {{artifactKind}} for {{audience}} using {{designSystem}} from {{template}}.',
      },
      inputs: [
        {
          name: 'artifactKind',
          type: 'string',
          required: true,
          default: 'web prototype',
          label: 'Artifact kind',
        },
        {
          name: 'fidelity',
          type: 'select',
          required: true,
          options: ['wireframe', 'high-fidelity'],
          default: 'high-fidelity',
          label: 'Fidelity',
        },
        {
          name: 'audience',
          type: 'string',
          required: true,
          default: 'product evaluators',
          label: 'Audience',
        },
        {
          name: 'designSystem',
          type: 'string',
          default: 'the active project design system',
          label: 'Design system',
        },
        {
          name: 'template',
          type: 'string',
          default: 'the bundled web prototype seed',
          label: 'Template',
        },
      ],
    },
  },
};

// The Prototype strip is websites only, so a Home card under 原型 is either an
// Agency Site family generator (`od.context.skills[].ref === 'agency-site'`,
// named `example-agency-<family>`) or a stored design reference. This record
// keeps the web-prototype scenario's query and inputs, so the brief a click
// seeds is the same string as before; only the card's identity moves onto the
// strip.
const AGENCY_FERVOR_PLUGIN = {
  ...WEB_PROTOTYPE_PLUGIN,
  id: 'example-agency-fervor',
  title: 'Fervor Trust to Lead',
  source: '/tmp/agency-fervor',
  fsPath: '/tmp/agency-fervor',
  manifest: {
    ...WEB_PROTOTYPE_PLUGIN.manifest,
    name: 'example-agency-fervor',
    title: 'Fervor Trust to Lead',
    tags: ['example', 'prototype', 'web'],
    od: {
      ...WEB_PROTOTYPE_PLUGIN.manifest.od,
      mode: 'prototype',
      context: { skills: [{ ref: 'agency-site' }, { path: './SKILL.md' }] },
    },
  },
};

// 文档's example rail is untouched by the Prototype strip, so the
// example-reference route — a card that names a LOOK and hands the route back
// to its task type — is pinned there instead. Same scenario query and inputs
// as the web-prototype record, so the seeded brief is the same string.
const DOCUMENT_EXAMPLE_PLUGIN = {
  ...WEB_PROTOTYPE_PLUGIN,
  id: 'example-eng-runbook',
  title: 'Eng Runbook',
  source: '/tmp/eng-runbook',
  fsPath: '/tmp/eng-runbook',
  manifest: {
    ...WEB_PROTOTYPE_PLUGIN.manifest,
    name: 'example-eng-runbook',
    title: 'Eng Runbook',
    tags: ['document', 'runbook'],
    od: {
      ...WEB_PROTOTYPE_PLUGIN.manifest.od,
      mode: 'document',
    },
  },
};

const AUTHORING_DEFAULT_SCENARIO_INPUTS = {
  artifactKind: 'Mishh Mashh plugin',
  audience: 'Mishh Mashh plugin authors',
  topic: 'packaging a reusable workflow as a Mishh Mashh plugin',
};

const REFLY_DESIGN_SYSTEM = {
  id: 'ds-refly',
  title: 'Refly Design System',
  category: 'Productivity & SaaS',
  summary: 'Refly defaults',
  source: 'user' as const,
  status: 'published' as const,
  isEditable: true,
};

const AUTHORING_APPLY_RESULT = {
  query: 'Create a plugin.',
  contextItems: [],
  inputs: AUTHORING_PLUGIN.manifest.od.inputs,
  assets: [],
  mcpServers: [],
  trust: 'trusted',
  capabilitiesGranted: ['prompt:inject'],
  capabilitiesRequired: ['prompt:inject'],
  appliedPlugin: {
    snapshotId: 'snap-authoring',
    pluginId: 'od-plugin-authoring',
    pluginVersion: '0.1.0',
    manifestSourceDigest: 'a'.repeat(64),
    inputs: { pluginGoal: PLUGIN_AUTHORING_DEFAULT_GOAL },
    resolvedContext: { items: [] },
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    assetsStaged: [],
    taskKind: 'new-generation',
    appliedAt: 0,
    connectorsRequired: [],
    connectorsResolved: [],
    mcpServers: [],
    status: 'fresh',
  },
  projectMetadata: {},
};

const DEFAULT_APPLY_RESULT = {
  ...AUTHORING_APPLY_RESULT,
  inputs: [],
  appliedPlugin: {
    ...AUTHORING_APPLY_RESULT.appliedPlugin,
    snapshotId: 'snap-default',
    pluginId: 'od-new-generation',
    inputs: AUTHORING_DEFAULT_SCENARIO_INPUTS,
  },
};

const DOCUMENT_NEW_GENERATION_APPLY_RESULT = {
  ...AUTHORING_APPLY_RESULT,
  query: DOCUMENT_NEW_GENERATION_PLUGIN.manifest.od.useCase.query,
  inputs: DOCUMENT_NEW_GENERATION_PLUGIN.manifest.od.inputs,
  appliedPlugin: {
    ...AUTHORING_APPLY_RESULT.appliedPlugin,
    snapshotId: 'snap-document-new-generation',
    pluginId: 'od-new-generation',
    inputs: {
      artifactKind: 'document',
      audience: 'readers',
      topic: 'the user brief',
    },
  },
};

const WEB_PROTOTYPE_APPLY_RESULT = {
  ...AUTHORING_APPLY_RESULT,
  query: WEB_PROTOTYPE_PLUGIN.manifest.od.useCase.query,
  inputs: WEB_PROTOTYPE_PLUGIN.manifest.od.inputs,
  appliedPlugin: {
    ...AUTHORING_APPLY_RESULT.appliedPlugin,
    snapshotId: 'snap-web-prototype',
    pluginId: 'example-web-prototype',
    inputs: {
      artifactKind: 'web prototype',
      fidelity: 'high-fidelity',
      audience: 'product evaluators',
      designSystem: 'the active project design system',
      template: 'the bundled web prototype seed',
    },
  },
};

const AGENCY_FERVOR_APPLY_RESULT = {
  ...WEB_PROTOTYPE_APPLY_RESULT,
  appliedPlugin: {
    ...WEB_PROTOTYPE_APPLY_RESULT.appliedPlugin,
    snapshotId: 'snap-agency-fervor',
    pluginId: 'example-agency-fervor',
  },
};

// Representative installed records for the two DRAFT Agency Site families and
// a generic Velar-shaped prototype example. Manifest-resource identities are
// verified separately from app tests; this exercises the Home card route.
const AGENCY_FAMILY_EXAMPLE_CASES = [
  { id: 'example-agency-emmpo', title: 'DRAFT — Emmpo Learning & Membership', nativeUse: true },
  { id: 'example-agency-watson', title: 'DRAFT — Watson Trust to Lead', nativeUse: true },
  { id: 'example-velar-luxury-real-estate', title: 'Velar. — Luxury Real Estate', nativeUse: false },
] as const;

function agencyFamilyExampleRecord(testCase: (typeof AGENCY_FAMILY_EXAMPLE_CASES)[number]) {
  return {
    ...WEB_PROTOTYPE_PLUGIN,
    id: testCase.id,
    title: testCase.title,
    source: `/tmp/${testCase.id}`,
    fsPath: `/tmp/${testCase.id}`,
    manifest: {
      ...WEB_PROTOTYPE_PLUGIN.manifest,
      name: testCase.id,
      title: testCase.title,
      tags: ['example', 'prototype', 'web', 'landing-page'],
      od: {
        ...WEB_PROTOTYPE_PLUGIN.manifest.od,
        mode: 'prototype',
        useCase: { query: `Build a landing page using ${testCase.title}.` },
        inputs: [],
        context: {
          skills: testCase.nativeUse
            ? [{ ref: 'agency-site' }, { path: './SKILL.md' }]
            : [{ path: './SKILL.md' }],
        },
      },
    },
  };
}

// A plugin whose useCase.query is a generator-facing meta-instruction (not a
// human-readable brief). use-with-query must surface the description instead,
// matching the Home example-prompt cards.
const META_INSTRUCTION_PLUGIN = {
  ...DEFAULT_PLUGIN,
  id: 'example-meta-landing',
  title: 'Meta Landing',
  source: '/tmp/meta-landing',
  fsPath: '/tmp/meta-landing',
  manifest: {
    ...DEFAULT_PLUGIN.manifest,
    name: 'example-meta-landing',
    title: 'Meta Landing',
    description: 'Cinematic parallax landing page.',
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: {
        query: 'Follow the en field verbatim; start from the bundled example.html.',
      },
    },
  },
};

const META_INSTRUCTION_APPLY_RESULT = {
  ...WEB_PROTOTYPE_APPLY_RESULT,
  query: META_INSTRUCTION_PLUGIN.manifest.od.useCase.query,
  inputs: [],
  appliedPlugin: {
    ...WEB_PROTOTYPE_APPLY_RESULT.appliedPlugin,
    snapshotId: 'snap-meta-landing',
    pluginId: 'example-meta-landing',
    inputs: {},
  },
};

function stubAnimationFrame() {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = window.setTimeout(() => cb(window.performance.now()), 0);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    window.clearTimeout(id);
  });
}

describe('HomeView prompt handoff', () => {
  afterEach(() => {
    invalidatePluginCatalogCache({ workspaceContext: workspaceContextOverride.context, accountGeneration: currentWorkspaceAccountGeneration() });
    invalidatePluginCatalogCache({ workspaceContext: null, accountGeneration: currentWorkspaceAccountGeneration() });
    workspaceContextOverride.context = null;
    vi.unstubAllGlobals();
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('keeps the existing sending state visible and preserves the draft when submit fails', async () => {
    let resolveSubmit: (accepted: boolean) => void = () => undefined;
    const submitResult = new Promise<boolean>((resolve) => {
      resolveSubmit = resolve;
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => submitResult}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await setPromptAndSettle('Create an image of a quiet reading room.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-submit').getAttribute('aria-busy')).toBe('true');
    });
    expect(homeHeroPromptValue()).toBe('Create an image of a quiet reading room.');

    await act(async () => {
      resolveSubmit(false);
      await submitResult;
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to start the run. Try again.',
    );
    expect(homeHeroPromptValue()).toBe('Create an image of a quiet reading room.');
    expect(screen.getByTestId('home-hero-submit').getAttribute('aria-busy')).toBe('false');
  });

  it('keeps Send locked until the fresh-home default prototype binding is ready', async () => {
    let resolvePlugins: (response: Response) => void = () => undefined;
    const pluginsResponse = new Promise<Response>((resolve) => {
      resolvePlugins = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') return pluginsResponse;
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await setPromptAndSettle('Turn these review habits into an infographic.');
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await act(async () => {
      resolvePlugins(new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await pluginsResponse;
    });

    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
  });

  it('keeps creation types actionable while an expired plugin cache refreshes after a project round trip', async () => {
    let resolveRefresh: (response: Response) => void = () => undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let pluginListReads = 0;
    const pluginResponse = () => new Response(
      JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        pluginListReads += 1;
        return pluginListReads === 1 ? pluginResponse() : refreshResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    const firstHome = render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );
    const firstTrigger = await screen.findByTestId('home-hero-template-trigger');
    await waitFor(() => expect((firstTrigger as HTMLButtonElement).disabled).toBe(false));
    firstHome.unmount();

    // Project pages commonly stay open longer than the plugin cache TTL. Model
    // that route round trip without a real sleep, then hold the background
    // refresh open so actionability cannot accidentally depend on network time.
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now + 10_001);
    try {
      const returnedHome = render(
        <HomeView
          projects={[]}
          onSubmit={() => undefined}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
        />,
      );

      expect(pluginListReads).toBe(2);
      expect(
        (screen.getByTestId('home-hero-template-trigger') as HTMLButtonElement).disabled,
      ).toBe(false);

      await act(async () => {
        resolveRefresh(pluginResponse());
        await refreshResponse;
      });
      returnedHome.unmount();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('consumes a plugin authoring handoff once and focuses the textarea', async () => {
    let resolveApply: (response: Response) => void = () => undefined;
    const applyResponse = new Promise<Response>((resolve) => {
      resolveApply = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-plugin-authoring/apply-local')) {
        return applyResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginAuthoringHandoff(1)}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT);
      expect(document.activeElement).toBe(input);
    });
    const inputCard = input.closest('.home-hero__input-card') as HTMLElement | null;
    expect(inputCard?.classList.contains('home-hero__input-card--compact-authoring')).toBe(true);
    expect(inputCard?.style.getPropertyValue('--home-hero-prompt-max-height')).toBe('132px');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-plugin-authoring/apply-local',
      expect.anything(),
    ));
    resolveApply(new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    await setPromptAndSettle('User edited prompt');

    rerender(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginAuthoringHandoff(1)}
      />,
    );

    expect(homeHeroPromptText()).toBe('User edited prompt');
  });

  it('uses the same authoring prompt from the Home rail chip', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-plugin-authoring/apply-local')) {
        return new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await clickHomeShortcut('create-plugin');

    const input = await screen.findByTestId('home-hero-input');
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT);
      expect(document.activeElement).toBe(input);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before replacing an edited Home draft with the rail create-plugin prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-plugin-authoring/apply-local')) {
        return new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await setPromptAndSettle('Keep my custom plugin brief');
    await clickHomeShortcut('create-plugin');

    const dialog = await screen.findByRole('dialog', { name: /replace current prompt/i });
    expect(homeHeroPromptText()).toBe('Keep my custom plugin brief');
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-plugin-authoring/apply-local')
    ))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-plugin-authoring/apply-local',
      expect.anything(),
    ));
    await waitFor(() => expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT));
    expect(screen.queryByRole('dialog', { name: /replace current prompt/i })).toBeNull();
  });

  it('reports a missing Try it plugin after the same cached catalogue settles', async () => {
    invalidatePluginCatalogCache({ workspaceContext: null, accountGeneration: currentWorkspaceAccountGeneration() });
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return new Response(JSON.stringify({ plugins: [] }));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    await listPlugins();
    render(<HomeView projects={[]} onSubmit={vi.fn()} onOpenProject={() => undefined} onViewAllProjects={() => undefined}
      promptHandoff={createPluginUseHandoff(732, 'missing-personal-plugin')} />);
    await screen.findByText('Plugin "missing-personal-plugin" is not installed. Refresh Plugins and try again.');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/plugins')).toHaveLength(1);
  });

  it('reports a missing Try it plugin after an empty forced refresh settles', async () => {
    invalidatePluginCatalogCache({ workspaceContext: null, accountGeneration: currentWorkspaceAccountGeneration() });
    let resolveCatalog!: (response: Response) => void;
    const refreshedCatalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return ++reads === 1 ? new Response(JSON.stringify({ plugins: [] })) : refreshedCatalog;
      throw new Error(`unexpected fetch ${url}`);
    }));
    stubAnimationFrame();
    await listPlugins();
    const props = { projects: [], onSubmit: vi.fn(), onOpenProject: () => undefined, onViewAllProjects: () => undefined };
    const mounted = render(<HomeView {...props} isActive={false} />);
    mounted.rerender(<HomeView {...props} isActive promptHandoff={createPluginUseHandoff(733, 'missing-after-refresh')} />);
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByText(/Plugin "missing-after-refresh" is not installed/)).toBeNull();
    await act(async () => { resolveCatalog(new Response(JSON.stringify({ plugins: [] }))); });
    await screen.findByText('Plugin "missing-after-refresh" is not installed. Refresh Plugins and try again.');
  });

  it('reports a missing team Try it plugin when the invalidation stream has not activated', async () => {
    workspaceContextOverride.context = {
      workspaceId: 'handoff-team', workspaceType: 'team', workspaceMemberId: 'handoff-member',
      role: 'member', memberStatus: 'active', lifecycleState: 'active', billingState: 'active',
      planId: 'team_basic', providerMode: 'platform_credits', teamId: 'handoff-team-id',
      seatSummary: buildWorkspaceSeatSummary({ seatLimit: 3, usedSeats: 2 }),
      permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
    };
    const options = { workspaceContext: workspaceContextOverride.context, accountGeneration: currentWorkspaceAccountGeneration() };
    invalidatePluginCatalogCache(options);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return new Response(JSON.stringify({ plugins: [] }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    stubAnimationFrame();
    await listPlugins(options);
    render(<HomeView projects={[]} onSubmit={vi.fn()} onOpenProject={() => undefined} onViewAllProjects={() => undefined}
      promptHandoff={createPluginUseHandoff(734, 'missing-team-plugin')} />);
    await screen.findByText('Plugin "missing-team-plugin" is not installed. Refresh Plugins and try again.');
  });

  it('uses a known Try it plugin immediately while the newer catalogue is still resolving', async () => {
    invalidatePluginCatalogCache({ workspaceContext: null, accountGeneration: currentWorkspaceAccountGeneration() });
    let resolveCatalog!: (response: Response) => void;
    const refreshedCatalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return ++reads === 1 ? new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] })) : refreshedCatalog;
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT));
      throw new Error(`unexpected fetch ${url}`);
    }));
    stubAnimationFrame();
    await listPlugins();
    const props = { projects: [], onSubmit: vi.fn(), onOpenProject: () => undefined, onViewAllProjects: () => undefined };
    const mounted = render(<HomeView {...props} isActive={false} />);
    mounted.rerender(<HomeView {...props} isActive promptHandoff={createPluginUseHandoff(735, 'example-web-prototype')} />);
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByTestId('home-hero-active-plugin')).toHaveTextContent('Web Prototype'));
    await act(async () => { resolveCatalog(new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }))); });
  });

  it('retains Personal Try it while the inactive Home catalogue refresh is still resolving', async () => {
    invalidatePluginCatalogCache({ workspaceContext: null, accountGeneration: currentWorkspaceAccountGeneration() });
    let resolveCatalog!: (response: Response) => void;
    const refreshedCatalog = new Promise<Response>((resolve) => { resolveCatalog = resolve; });
    let catalogReads = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') {
        catalogReads += 1;
        if (catalogReads === 1) return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }));
        return refreshedCatalog;
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    await listPlugins();
    const props = { projects: [], onSubmit: vi.fn(), onOpenProject: () => undefined, onViewAllProjects: () => undefined };
    const mounted = render(<HomeView {...props} isActive={false} />);
    mounted.rerender(<HomeView {...props} isActive promptHandoff={createPluginUseHandoff(731, 'example-web-prototype')} />);
    await waitFor(() => expect(catalogReads).toBe(2));
    expect(fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('example-web-prototype/apply-local'))).toBe(false);
    expect(screen.queryByText(/Plugin "example-web-prototype" is not installed/)).toBeNull();
    await act(async () => { resolveCatalog(new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN, WEB_PROTOTYPE_PLUGIN] }))); });
    await waitFor(() => expect(screen.getByTestId('home-hero-active-plugin')).toHaveTextContent('Web Prototype'));
    await setPromptAndSettle('Keep this Personal plugin as the selected run driver.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'example-web-prototype', appliedPluginSnapshotId: 'snap-web-prototype' })));
  });

  it('routes a plugin-use handoff from the Plugins page as the active driver and submits it as the run driver', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(1, 'example-web-prototype')}
      />,
    );

    // "Use" now routes the picked plugin as the active driver (so its own
    // pipeline + context apply on submit), not merely as background context.
    // The active-plugin badge surfaces and the plugin is applied; a plain
    // `use` leaves the draft empty (suppressPromptUpdate).
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin')).toBeTruthy();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));
    await screen.findByTestId('home-hero-input');
    expect(homeHeroPromptValue()).toBe('');

    // The user types their own brief over the empty draft, then submits — the
    // routed plugin (not od-default) must drive the created run. Mirrors the
    // P0 e2e "direct Use ... keeps the prompt freeform" flow.
    await setPromptAndSettle('Use the selected starter as the driver');
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Use the selected starter as the driver',
      pluginId: 'example-web-prototype',
      appliedPluginSnapshotId: 'snap-web-prototype',
    })));
  });

  it('restores the Community template type while binding its exact plugin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(11, 'example-web-prototype', {
          action: 'use',
          chipId: 'prototype',
          projectKind: 'prototype',
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin').textContent).toContain('Web Prototype');
    });
    // The badge renders optimistically; draft persistence runs in a passive
    // effect. Wait for the persisted state instead of assuming the badge flushed it.
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('mish:home-composer:chip')!)).toEqual({
      chipId: 'prototype',
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
      // A "Use" hand-off is an explicit pick, and the draft is the only thing
      // that survives a Home unmount — so it carries HOW the pick was made,
      // not just what was picked. Restoring it as a bare type-chip binding
      // would un-pin the plugin this hand-off exists to pin.
      explicitPick: true,
    }));
  });

  it('routes free-form submits through the hidden default plugin without applying a visible chip', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [HIDDEN_DEFAULT_PLUGIN, DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await setPromptAndSettle('Make a launch page for a robotics studio');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(screen.queryByTestId('home-hero-active-plugin')).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Make a launch page for a robotics studio',
      pluginId: 'od-default',
      appliedPluginSnapshotId: null,
      pluginInputs: { prompt: 'Make a launch page for a robotics studio' },
      projectKind: 'other',
    }));
  });

  it('falls back to od-new-generation when od-plugin-authoring is not registered yet', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(DEFAULT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clickHomeShortcut('create-plugin');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-new-generation/apply-local',
      expect.anything(),
    ));
    const applyCall = fetchMock.mock.calls.find(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')
    ));
    expect(JSON.parse(String((applyCall?.[1] as RequestInit).body))).toMatchObject({
      inputs: {
        artifactKind: 'Mishh Mashh plugin',
        audience: 'Mishh Mashh plugin authors',
        topic: 'packaging a reusable workflow as a Mishh Mashh plugin',
      },
    });
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT);
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: PLUGIN_AUTHORING_PROMPT,
      pluginId: 'od-new-generation',
      appliedPluginSnapshotId: 'snap-default',
      pluginInputs: {
        artifactKind: 'Mishh Mashh plugin',
        audience: 'Mishh Mashh plugin authors',
        topic: 'packaging a reusable workflow as a Mishh Mashh plugin',
      },
      projectKind: 'other',
    }));
  });

  it('hands the Home rail Prototype chip entirely to OD Next on submit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN, AGENCY_FERVOR_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')
    ))).toBe(false);
    // The design-system picker is now a persistent control in the row below the
    // composer (next to the working-directory picker), available for every
    // product kind rather than gated on the prototype/deck footer.
    expect(
      screen.getByTestId('home-hero-design-system-trigger').textContent,
    ).toContain('Refly Design System');
    // Fidelity is no longer a prototype footer control — the agent asks for it
    // in discovery instead.
    expect(screen.queryByTestId('home-hero-footer-option-fidelity')).toBeNull();
    // The design-system footer pill is gone; the persistent picker replaces it.
    expect(screen.queryByTestId('home-hero-footer-option-designSystem')).toBeNull();
    expect(screen.getByTestId('home-hero-design-system-trigger')).toBeTruthy();
    expect(homeHeroPromptValue()).toBe('');
    // 原型's rail is the websites strip, not the catalog's example presets: the
    // installed family generator is the card that renders there.
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    const strip = screen.getByTestId('home-hero-website-cards');
    expect(
      within(strip).getAllByTestId('home-hero-plugin-preset')
        .map((card) => card.getAttribute('data-plugin-id')),
    ).toEqual(['example-agency-fervor']);
    // Inline `{{slot}}` prompt widgets were removed in the Lexical migration;
    // these null checks now confirm the migrated editor never renders them.
    expect(screen.queryByTestId('home-hero-prompt-slot-fidelity')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-artifactKind')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-designSystem')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-template')).toBeNull();
    // The inline plugin inputs form was removed from the Home composer, so the
    // non-footer inputs (artifactKind / audience / template) no longer render.
    expect(screen.queryByTestId('plugin-inputs-form')).toBeNull();

    await setPromptAndSettle('Build a pricing-page prototype.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: null,
      automaticStrategyTaskProfile: 'prototype',
      appliedPluginSnapshotId: null,
      pluginTitle: null,
      taskKind: null,
      skillId: null,
      projectKind: 'prototype',
      prompt: 'Build a pricing-page prototype.',
      designSystemId: 'ds-refly',
      projectMetadata: expect.objectContaining({
        kind: 'prototype',
      }),
    })));
    const [submitted] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submitted).not.toHaveProperty('pluginInputs');
    expect(submitted).not.toHaveProperty('pluginSource');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply-local'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    {
      subtype: 'mobile',
      prompt: 'Design a mobile checkout flow.',
      metadata: {
        kind: 'prototype',
        platform: 'auto',
        platformTargets: ['mobile-ios', 'mobile-android'],
      },
    },
    {
      subtype: 'wireframe',
      prompt: 'Sketch a low-fidelity account setup flow.',
      metadata: { kind: 'prototype', fidelity: 'wireframe' },
    },
  ])('routes $subtype to the automatic OD Next Prototype route while preserving its project metadata', async ({
    subtype,
    prompt,
    metadata,
  }) => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');
    // The legacy keyword scenes are no longer tabs under Prototype (that row
    // is the atlas spines now); the queued-intent path is how a retired
    // 'mobile' / 'wireframe' id still selects the scene it became.
    await clickHomeShortcut(subtype);

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
      expect(JSON.parse(window.localStorage.getItem('mish:home-composer:chip') ?? '{}'))
        .toMatchObject({ chipId: 'prototype', prototypeSubtypeId: subtype });
    });

    await setPromptAndSettle(prompt);
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    // A nested Prototype scene refines WHAT to build, never WHETHER the parent
    // route applies: 移动应用 / 线框图 enter OD Next exactly as 原型 does, and
    // their distinguishing metadata rides along into the bundle.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: null,
      automaticStrategyTaskProfile: 'prototype',
      appliedPluginSnapshotId: null,
      pluginTitle: null,
      taskKind: null,
      skillId: null,
      projectKind: 'prototype',
      prompt,
      projectMetadata: expect.objectContaining(metadata),
    })));
    const [submittedNested] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    // Exactly the scene's refinement over 原型's kind — no extra field, and the
    // scene may not restate `kind` as something else.
    expect(submittedNested.projectMetadata).toEqual(metadata);
    expect(submittedNested).not.toHaveProperty('pluginInputs');
    expect(submittedNested).not.toHaveProperty('pluginSource');
    // Nothing is pinned, so there is no snapshot to resolve.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply-local'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    {
      legacyChipId: 'mobile',
      metadata: {
        kind: 'prototype',
        platform: 'auto',
        platformTargets: ['mobile-ios', 'mobile-android'],
      },
    },
    { legacyChipId: 'wireframe', metadata: { kind: 'prototype', fidelity: 'wireframe' } },
  ])('selects the nested scene when a queued intent still names the retired $legacyChipId chip id', async ({
    legacyChipId,
    metadata,
  }) => {
    // `requestHomeChip` takes a bare string from another surface, so a caller
    // that predates the creation-hierarchy move can still ask for a chip id
    // that no longer exists. The hand-off must land on the scene it became
    // instead of failing the catalog lookup and silently dropping the intent.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await clickHomeShortcut(legacyChipId);

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
      expect(JSON.parse(window.localStorage.getItem('mish:home-composer:chip') ?? '{}'))
        .toMatchObject({ chipId: 'prototype', prototypeSubtypeId: legacyChipId });
    });

    await setPromptAndSettle('Lay out the onboarding screens.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [submittedLegacy] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submittedLegacy).toMatchObject({
      pluginId: null,
      automaticStrategyTaskProfile: 'prototype',
      projectKind: 'prototype',
    });
    expect(submittedLegacy.projectMetadata).toEqual(metadata);
  });

  it('keeps Slide deck available without retired bundled example scenes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')) {
        return new Response(JSON.stringify(DEFAULT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('deck');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
    });
    expect(screen.queryByTestId('home-hero-subtype-fundraising-pitch')).toBeNull();

    await setPromptAndSettle('Pitch our seed round to climate-tech investors.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'od-new-generation',
      pluginSelectionProvenance: 'automatic-default',
      appliedPluginSnapshotId: 'snap-default',
      projectKind: 'deck',
      projectMetadata: expect.objectContaining({ kind: 'deck' }),
    })));
    const [submittedDeck] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submittedDeck.automaticStrategyTaskProfile ?? null).toBeNull();
    expect(submittedDeck.projectMetadata).not.toHaveProperty('fidelity');
    expect(submittedDeck.projectMetadata).not.toHaveProperty('platformTargets');
    expect(submittedDeck).not.toHaveProperty('exampleReference');
  });

  it('keeps Document prompt entry submittable even when od-new-generation has required inputs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DOCUMENT_NEW_GENERATION_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')) {
        return new Response(JSON.stringify(DOCUMENT_NEW_GENERATION_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('document');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Document');
    });
    await setPromptAndSettle('Write a crisp launch memo for the new analytics product.');
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-new-generation/apply-local',
      expect.anything(),
    ));
    const applyCall = fetchMock.mock.calls.find(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')
    ));
    expect(JSON.parse(String((applyCall?.[1] as RequestInit).body))).toMatchObject({
      inputs: {
        artifactKind: 'document',
        audience: 'readers',
        topic: 'the user brief',
      },
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'od-new-generation',
      appliedPluginSnapshotId: 'snap-document-new-generation',
      projectKind: 'other',
      prompt: 'Write a crisp launch memo for the new analytics product.',
    })));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('defaults to "No design system" (不指定) when the user has no personal default and submits a null designSystemId', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    // A preset is offered (REFLY) but it is NOT the user's personal default, so
    // the composer must default to "No design system" rather than a preset.
    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId={null}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    // Round-4 skin: the unset trigger reads "Design system" (the field name)
    // instead of the "No design system" placeholder.
    expect(
      screen.getByTestId('home-hero-design-system-trigger').textContent,
    ).toContain('Design system');

    await setPromptAndSettle('Build a pricing-page prototype.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: null,
      automaticStrategyTaskProfile: 'prototype',
      projectKind: 'prototype',
      designSystemId: null,
    })));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('pluginInputs');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply-local'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets the user explicitly pick "No design system" to override a personal default and submit a null designSystemId', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');

    // The personal default pre-selects, as before.
    await waitFor(() => {
      expect(
        screen.getByTestId('home-hero-design-system-trigger').textContent,
      ).toContain('Refly Design System');
    });

    // Open the shared design-system picker popover and pick the explicit
    // "No design system" row.
    fireEvent.click(screen.getByTestId('home-hero-design-system-trigger'));
    const popover = await screen.findByTestId('project-ds-picker-popover');
    const noneOption = await within(popover).findByText('No design system');
    fireEvent.click(noneOption);
    await waitFor(() => {
      // Round-4 skin: with nothing selected the trigger reads "Design system".
      expect(
        screen.getByTestId('home-hero-design-system-trigger').textContent,
      ).toContain('Design system');
    });

    await setPromptAndSettle('Build a pricing-page prototype.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: null,
      automaticStrategyTaskProfile: 'prototype',
      designSystemId: null,
    })));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('pluginInputs');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply-local'))).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // 原型 no longer has an example rail to make this pick on — its strip is
  // websites only, and a website card is either a family generator or a stored
  // reference. Every other task type's rail is untouched by that, so the
  // example-card contract is pinned where it still lives: 文档.
  it('keeps an official example card under 文档 and pins its plugin on submit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN, DOCUMENT_EXAMPLE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('document');
    // The card itself is the single click-to-use affordance — clicking it
    // directly seeds the composer input.
    fireEvent.click(
      (await screen.findAllByTestId('home-hero-plugin-preset')).find(
        (item) => item.getAttribute('data-plugin-id') === 'example-eng-runbook',
      )!,
    );

    screen.getByTestId('home-hero-input');
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(
        'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
      );
    });
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/example-eng-runbook/apply-local')
    ))).toBe(false);
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Document');
    // Yielding the ROUTE to the task type does not change the composer chrome:
    // the example is still an explicit pick, so its own plugin badge (and
    // clear ×) renders exactly as it did when the pick pinned a plugin.
    expect(screen.getByTestId('home-hero-active-plugin').textContent).toContain('Eng Runbook');
    // The design-system picker is now the persistent control below the composer.
    expect(
      screen.getByTestId('home-hero-design-system-trigger').textContent,
    ).toContain('Refly Design System');
    // Fidelity is no longer a prototype footer control (asked in discovery).
    expect(screen.queryByTestId('home-hero-footer-option-fidelity')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-designSystem')).toBeNull();
    // Inline `{{slot}}` prompt widgets were removed in the Lexical migration.
    expect(screen.queryByTestId('home-hero-prompt-slot-fidelity')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-artifactKind')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-designSystem')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-template')).toBeNull();
    // The inline plugin inputs form was removed from the Home composer; the
    // preset card still seeds the prompt and keeps the chip's structured inputs
    // in state (submitted below), but no inputs form renders.
    expect(screen.queryByTestId('plugin-inputs-form')).toBeNull();

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    // 文档 owns no automatic OD Next route, so the pick IS the strategy: the
    // card's own plugin is pinned and its snapshot resolves on submit.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-eng-runbook',
      pluginSource: '/tmp/eng-runbook',
      pluginTitle: 'Eng Runbook',
      appliedPluginSnapshotId: 'snap-web-prototype',
      projectKind: 'other',
      prompt: 'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
      designSystemId: 'ds-refly',
      projectMetadata: expect.objectContaining({ kind: 'other', intent: 'document' }),
    })));
    const [submittedPreset] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submittedPreset).not.toHaveProperty('exampleReference');
    expect(submittedPreset).not.toHaveProperty('automaticStrategyTaskProfile');
  });

  it.each(AGENCY_FAMILY_EXAMPLE_CASES)(
    'places the $id card under Prototype according to its declared workflow',
    async (testCase) => {
      const record = agencyFamilyExampleRecord(testCase);
      const applyResult = {
        ...WEB_PROTOTYPE_APPLY_RESULT,
        query: record.manifest.od.useCase.query,
        inputs: [],
        appliedPlugin: {
          ...WEB_PROTOTYPE_APPLY_RESULT.appliedPlugin,
          snapshotId: `snap-${record.id}`,
          pluginId: record.id,
          inputs: {},
        },
      };
      const fetchMock = vi.fn<typeof fetch>(async (url) => {
        if (url === '/api/plugins') {
          return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN, record] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (typeof url === 'string' && url.includes('/apply-local')) {
          return new Response(JSON.stringify(applyResult), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      stubAnimationFrame();
      const onSubmit = vi.fn();

      render(
        <HomeView
          projects={[]}
          onSubmit={onSubmit}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
        />,
      );

      await clearActiveTypeChip();
      await pickHomeTemplate('prototype');
      await screen.findByTestId('home-hero-website-cards');
      const card = screen.queryAllByTestId('home-hero-plugin-preset')
        .find((item) => item.getAttribute('data-plugin-id') === record.id);

      if (!testCase.nativeUse) {
        // No declared Agency Site workflow means it is not a website card, and
        // the Prototype strip carries websites only: the record stays
        // installed and reachable elsewhere, but Home does not offer it here.
        expect(card).toBeUndefined();
        expect(onSubmit).not.toHaveBeenCalled();
        return;
      }

      expect(card).toBeDefined();
      fireEvent.click(card!);
      await waitFor(() => expect(homeHeroPromptText().length).toBeGreaterThan(0));
      fireEvent.click(screen.getByTestId('home-hero-submit'));

      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      const [submitted] = onSubmit.mock.calls[0] as [Record<string, unknown>];
      expect(submitted).toMatchObject({
        pluginId: record.id,
        pluginSource: record.source,
        appliedPluginSnapshotId: `snap-${record.id}`,
        projectKind: 'prototype',
        skillId: 'agency-site',
      });
      expect(submitted).not.toHaveProperty('exampleReference');
      expect(submitted).not.toHaveProperty('automaticStrategyTaskProfile');
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/${record.id}/apply-local`))).toBe(true);
    },
  );

  it('does not advertise retired bundled deck examples on the generic deck route', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('deck');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
    });
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { subtype: 'wireframe', metadata: { kind: 'prototype', fidelity: 'wireframe' } },
    {
      subtype: 'mobile',
      metadata: {
        kind: 'prototype',
        platform: 'auto',
        platformTargets: ['mobile-ios', 'mobile-android'],
      },
    },
  ])('keeps the $subtype Prototype scene metadata through a website-strip card pick', async ({
    subtype,
    metadata,
  }) => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN, AGENCY_FERVOR_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(AGENCY_FERVOR_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');
    // The legacy keyword scenes are no longer tabs under Prototype (that row
    // is the atlas spines now); the queued-intent path is how a retired
    // 'mobile' / 'wireframe' id still selects the scene it became.
    await clickHomeShortcut(subtype);
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem('mish:home-composer:chip') ?? '{}'))
        .toMatchObject({ chipId: 'prototype', prototypeSubtypeId: subtype });
    });
    fireEvent.click(
      (await screen.findAllByTestId('home-hero-plugin-preset')).find(
        (item) => item.getAttribute('data-plugin-id') === 'example-agency-fervor',
      )!,
    );

    await waitFor(() => expect(homeHeroPromptText().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    // 移动应用 / 线框图 stamp their own refinement onto the 原型 project
    // metadata, and the card the scene's strip offers is a family generator —
    // a declared Agency Site workflow, so the pick pins that plugin natively.
    // The refinement has to survive that pin: it is what the scene is for.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-agency-fervor',
      pluginSource: '/tmp/agency-fervor',
      appliedPluginSnapshotId: 'snap-agency-fervor',
      skillId: 'agency-site',
      projectKind: 'prototype',
      projectMetadata: expect.objectContaining(metadata),
    })));
    const [submittedScene] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submittedScene).not.toHaveProperty('exampleReference');
    expect(submittedScene).not.toHaveProperty('automaticStrategyTaskProfile');
  });

  it('still pins the plugin for a Community "Use" pick made under the same OD Next task type', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(21, 'example-web-prototype', {
          action: 'use',
          chipId: 'prototype',
          projectKind: 'prototype',
        })}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));
    await setPromptAndSettle('Use the Community pick as the driver');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    // The SAME record reaches Home's example rail and the Community grid. The
    // call site — not the record — decides: a Plugins / details "Use" is a
    // strategy choice and keeps pinning its plugin even under 原型.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      appliedPluginSnapshotId: 'snap-web-prototype',
      pluginSource: '/tmp/web-prototype',
    })));
    const [submittedUse] = onSubmit.mock.calls[0] as [Record<string, unknown>];
    expect(submittedUse).not.toHaveProperty('exampleReference');
    expect(submittedUse).not.toHaveProperty('automaticStrategyTaskProfile');
    expect(submittedUse).toHaveProperty('pluginInputs');
  });

  it('does not advertise retired bundled live-artifact templates', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('live-artifact');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Live artifact');
    });
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('binds the Home rail Live artifact chip to generic generation with live-artifact metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')) {
        return new Response(JSON.stringify(DEFAULT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('live-artifact');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Live artifact');
    });
    await setPromptAndSettle('Build a refreshable Stripe revenue dashboard.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-new-generation/apply-local',
      expect.anything(),
    ));
    const applyCall = fetchMock.mock.calls.find(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')
    ));
    expect(JSON.parse(String((applyCall?.[1] as RequestInit).body))).toMatchObject({
      inputs: {
        artifactKind: 'live data artifact',
        audience: 'the intended operators',
        topic: 'the user brief and connected data',
      },
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'od-new-generation',
      pluginSelectionProvenance: 'automatic-default',
      appliedPluginSnapshotId: 'snap-default',
      projectKind: 'prototype',
      projectMetadata: expect.objectContaining({
        kind: 'prototype',
        intent: 'live-artifact',
        fidelity: 'high-fidelity',
      }),
      prompt: 'Build a refreshable Stripe revenue dashboard.',
    })));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('binds the deck chip and keeps only the design-system picker in the footer', async () => {
    // Slide count + speaker-notes footer controls were removed from the deck
    // composer; the agent asks for them in the first-turn discovery flow. The
    // deck footer now mirrors the prototype footer — design system only.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [DEFAULT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/od-new-generation/apply-local')) {
        return new Response(JSON.stringify(DEFAULT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('deck');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
    });
    expect(screen.queryByTestId('home-hero-footer-option-speakerNotes')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-slideCount')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-designSystem')).toBeNull();
    // The design-system picker is the persistent control below the composer.
    expect(screen.getByTestId('home-hero-design-system-trigger')).toBeTruthy();

    await setPromptAndSettle('Create an investor deck for a local-first design tool.');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'od-new-generation',
      pluginSelectionProvenance: 'automatic-default',
      appliedPluginSnapshotId: 'snap-default',
      skillId: null,
      projectKind: 'deck',
      projectMetadata: expect.objectContaining({
        kind: 'deck',
      }),
    })));
    expect(onSubmit.mock.calls[0]?.[0].automaticStrategyTaskProfile ?? null).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => (
      String(url).includes('/api/plugins/od-new-generation/apply-local')
    ))).toBe(true);
  });

  it('switches output-type chips without replacing an existing prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(DEFAULT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await setPromptAndSettle('Keep my current brief');
    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')
    ))).toBe(false);
    expect(homeHeroPromptText()).toBe('Keep my current brief');
    expect(screen.queryByRole('dialog', { name: /replace current prompt/i })).toBeNull();
  });

  it('lets the selected Prototype chip seed the hero through a retained preset card', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN, AGENCY_FERVOR_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-agency-fervor/apply-local')) {
        return new Response(JSON.stringify(AGENCY_FERVOR_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    render(
      <HomeView
        projects={[]}
        designSystems={[REFLY_DESIGN_SYSTEM]}
        defaultDesignSystemId="ds-refly"
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await pickHomeTemplate('prototype');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-website-cards')).toBeTruthy();
    });
    fireEvent.click(screen.getAllByTestId('home-hero-plugin-preset')[0]!);
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/example-agency-fervor/apply-local')
    ))).toBe(false);
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(
        'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
      );
    });
  });

  it('appends a plugin-use query handoff without replacing an existing prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await setPromptAndSettle('Keep my current brief');

    rerender(
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(2, 'example-web-prototype', {
          action: 'use-with-query',
        })}
      />,
    );

    const expectedPrompt = [
      'Keep my current brief',
      '',
      'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
    ].join('\n');
    // `use-with-query` must APPEND the plugin query to the user's existing
    // draft, never replace it — this is the regression the reviewer flagged.
    await waitFor(() => {
      expect(homeHeroPromptText()).toBe(expectedPrompt);
    });
    expect(screen.queryByRole('dialog', { name: /replace current prompt/i })).toBeNull();
    // The plugin is now routed as the active driver (active-plugin badge),
    // and applied so its pipeline/context bind on submit.
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-plugin')).toBeTruthy();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));
  });

  it('seeds the rendered query on use-with-query and writes placeholder edits back into inputs', async () => {
    // For a plugin whose query is already human-readable, use-with-query seeds
    // the rendered query itself. Because the seed came from the query (not a
    // description/meta-instruction fallback), the raw `{{...}}` template is kept
    // so editing a hydrated value in the composer flows back into pluginInputs
    // and submit resolves the snapshot from what the user sees.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    // Empty draft + use-with-query seeds the example-preset text into the editor.
    rerender(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(3, 'example-web-prototype', {
          action: 'use-with-query',
        })}
      />,
    );

    const seed =
      'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.';
    await waitFor(() => expect(homeHeroPromptText()).toBe(seed));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));

    // The user edits the seeded audience; the placeholder edit flows back into
    // the submitted pluginInputs (not the stale applied default).
    const edited = seed.replace('product evaluators', 'enterprise architects');
    await setPromptAndSettle(edited);
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      pluginInputs: expect.objectContaining({ audience: 'enterprise architects' }),
    })));
  });

  it('extracts a placeholder edit even after the use-with-query draft prefix is also edited', async () => {
    // The "tweak a preset before running" case: with an existing draft,
    // use-with-query appends the rendered query; the user then edits BOTH the
    // prefix and a hydrated placeholder. `queryTemplateAllowsPrefix` matches the
    // query as a suffix after any prefix, so the placeholder edit still reaches
    // pluginInputs and submit resolves the snapshot from the visible prompt.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    await setPromptAndSettle('Keep my current brief');

    rerender(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(4, 'example-web-prototype', {
          action: 'use-with-query',
        })}
      />,
    );

    const query =
      'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.';
    const appended = `Keep my current brief\n\n${query}`;
    await waitFor(() => expect(homeHeroPromptText()).toBe(appended));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));

    const edited = appended
      .replace('Keep my current brief', 'Rewritten brief for the board')
      .replace('product evaluators', 'enterprise architects');
    await setPromptAndSettle(edited);
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      pluginInputs: expect.objectContaining({ audience: 'enterprise architects' }),
    })));
  });

  it('extracts a placeholder edit after the user prepends an intro to an empty-draft use-with-query seed', async () => {
    // The empty-draft → add-prefix → edit-placeholder case: the seed lands in an
    // empty composer, then the user prepends an intro AND edits a hydrated value.
    // queryTemplateAllowsPrefix must stay on (we have a query template) so the
    // extractor matches the query as a suffix after the freshly-added prefix and
    // the placeholder edit still flows into pluginInputs.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply-local')) {
        return new Response(JSON.stringify(WEB_PROTOTYPE_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    // Empty draft + use-with-query seeds the rendered query into the editor.
    rerender(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(6, 'example-web-prototype', {
          action: 'use-with-query',
        })}
      />,
    );

    const seed =
      'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.';
    await waitFor(() => expect(homeHeroPromptText()).toBe(seed));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-web-prototype/apply-local',
      expect.anything(),
    ));

    // The user now PREPENDS an intro above the seed and edits the audience.
    const edited = `My intro for the board\n\n${seed.replace('product evaluators', 'enterprise architects')}`;
    await setPromptAndSettle(edited);
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      pluginInputs: expect.objectContaining({ audience: 'enterprise architects' }),
    })));
  });

  it('seeds the plugin description, not the raw meta-instruction query, on use-with-query', async () => {
    // The plugin's useCase.query is a generator-facing meta-instruction
    // ("follow the en field verbatim; start from example.html"). The Home
    // example-prompt cards surface the description instead; the detail modal's
    // prompt-loading "Use" (use-with-query) must do the same rather than
    // dumping the meta-instruction into the composer.
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [META_INSTRUCTION_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/example-meta-landing/apply-local')) {
        return new Response(JSON.stringify(META_INSTRUCTION_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    rerender(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        promptHandoff={createPluginUseHandoff(5, 'example-meta-landing', {
          action: 'use-with-query',
        })}
      />,
    );

    await waitFor(() => expect(homeHeroPromptText()).toBe('Cinematic parallax landing page.'));
    expect(homeHeroPromptText()).not.toContain('verbatim');
    expect(homeHeroPromptText()).not.toContain('example.html');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/example-meta-landing/apply-local',
      expect.anything(),
    ));
  });

  it('binds od-plugin-authoring before submitting the rail create-plugin prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await clickHomeShortcut('create-plugin');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-plugin-authoring/apply-local',
      expect.anything(),
    ));
    await waitFor(() => {
      const badge = screen.getByTestId('home-hero-active-plugin');
      expect(badge.textContent).toContain('Create plugin');
      expect(badge.textContent).not.toContain('Plugin authoring');
    });
    const input = screen.getByTestId('home-hero-input');
    const inputCard = input.closest('.home-hero__input-card') as HTMLElement | null;
    expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT);
    expect(inputCard?.classList.contains('home-hero__input-card--compact-authoring')).toBe(true);
    expect(inputCard?.style.getPropertyValue('--home-hero-prompt-max-height')).toBe('132px');
    fireEvent.click(await screen.findByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: PLUGIN_AUTHORING_PROMPT,
      pluginId: 'od-plugin-authoring',
      appliedPluginSnapshotId: 'snap-authoring',
      pluginInputs: { pluginGoal: PLUGIN_AUTHORING_DEFAULT_GOAL },
      projectKind: 'other',
    }));
  });

  it('keeps the authoring goal input linked to the prompt and submit payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await clickHomeShortcut('create-plugin');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/od-plugin-authoring/apply-local',
      expect.anything(),
    ));

    const rewrittenGoal = 'catalog internal research notes into a reusable knowledge workflow';
    screen.getByTestId('home-hero-input');
    await setPromptAndSettle(
      homeHeroPromptText().replace(PLUGIN_AUTHORING_DEFAULT_GOAL, rewrittenGoal),
    );
    await waitFor(() => {
      expect(homeHeroPromptText()).toContain(rewrittenGoal);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(rewrittenGoal),
      pluginId: 'od-plugin-authoring',
      pluginInputs: {
        pluginGoal: rewrittenGoal,
      },
    })));
  });

  it('does not submit the create-plugin prompt before the authoring scenario is applied', async () => {
    let resolveApply: (response: Response) => void = () => undefined;
    const applyResponse = new Promise<Response>((resolve) => {
      resolveApply = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [AUTHORING_PLUGIN, WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply-local')) {
        return applyResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubAnimationFrame();
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await clearActiveTypeChip();
    await clickHomeShortcut('create-plugin');
    const input = screen.getByTestId('home-hero-input');
    const inputCard = input.closest('.home-hero__input-card') as HTMLElement | null;
    expect(homeHeroPromptText()).toBe(PLUGIN_AUTHORING_PROMPT);
    expect(inputCard?.classList.contains('home-hero__input-card--compact-authoring')).toBe(true);
    expect(inputCard?.style.getPropertyValue('--home-hero-prompt-max-height')).toBe('132px');
    fireEvent.click(await screen.findByTestId('home-hero-submit'));
    expect(onSubmit).not.toHaveBeenCalled();

    resolveApply(new Response(JSON.stringify(AUTHORING_APPLY_RESULT), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'od-plugin-authoring',
      appliedPluginSnapshotId: 'snap-authoring',
    }));
  });
});

// An empty Lexical editor renders `<p><br></p>` (a placeholder break node), so
// the DOM serializer in `homeHeroPromptText()` reads that lone `<br>` back as
// `'\n'`. The editor's real text is empty — `.textContent` is `''` — so this
// reads the empty case precisely without weakening the genuine-content path.
function homeHeroPromptValue(): string {
  const text = homeHeroPromptText();
  if (text === '\n' && (screen.getByTestId('home-hero-input').textContent ?? '') === '') {
    return '';
  }
  return text;
}

// Replace the Lexical editor's text the way a user edit would, then let the
// editor's OnChange → host `onPromptChange` React state update flush a
// microtask (mirrors lexical-composer's `typeAndSettle`) so flows that submit
// right after editing read the latest draft.
async function setPromptAndSettle(value: string): Promise<void> {
  setHomeHeroPrompt(value);
  await act(async () => {
    await Promise.resolve();
  });
}

async function clearActiveTypeChip() {
  // Reset the Template selection back to "None" via the radial's center Clear
  // (#5517 replaced the dropdown Clear with the radial menu's center button).
  const trigger = screen.queryByTestId('home-hero-template-trigger');
  if (!trigger) return;
  fireEvent.click(trigger);
  const clear = screen.queryByTestId('home-hero-template-radial-clear');
  if (clear) fireEvent.click(clear);
  fireEvent.keyDown(document, { key: 'Escape' });
}

// #5517 removed the inline template rail (and the "Start with a template…"
// bar that held it) from Home. Scenario templates are now picked from the
// composer footer's radial Template picker.
async function pickHomeTemplate(id: string) {
  const trigger = await screen.findByTestId('home-hero-template-trigger');
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  const wedge = await screen.findByTestId(`home-hero-template-wedge-${id}`);
  await waitFor(() =>
    expect(screen.getByTestId(`home-hero-template-wedge-${id}`).getAttribute('aria-disabled'))
      .not.toBe('true'),
  );
  fireEvent.click(wedge);
}

// The migrate shortcuts (plugin authoring / Figma / template) left the Home
// composer with the rail. Their surviving producers — the Extensions tab and
// the Design systems tab — dispatch the same chip through `requestHomeChip`,
// which is the entry this drives.
async function clickHomeShortcut(id: string) {
  await act(async () => {
    requestHomeChip(id);
    await Promise.resolve();
  });
}
