import { expect, type Page, type Request, type Route } from '@playwright/test';
import { byokChoiceCompletenessIssues, FILE_UPLOAD_MAX_BYTES, parseModelPreflightRequest, parsePutSessionModel, sessionModelChoicesEqual, type ModelPreflightMismatch, type ModelPreflightResult, type SessionModelSnapshot } from '@open-design/contracts';
import { expectStableCount } from './assertions.js';

export const STORAGE_KEY = 'open-design:config';

const STANDARD_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'mock',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

const STANDARD_APP_CONFIG = {
  onboardingCompleted: true,
  agentId: 'mock',
  skillId: null,
  designSystemId: null,
  agentModels: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

const STANDARD_MOCK_AGENT = {
  id: 'mock',
  name: 'Mock Agent',
  bin: 'mock-agent',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

export type RunRequestBody = Record<string, unknown>;

export type RunRequestTracker = {
  bodies: RunRequestBody[];
  expectCount: (count: number, options?: { timeout?: number; message?: string }) => Promise<void>;
  expectNone: (options?: { timeout?: number; message?: string }) => Promise<void>;
  dispose?: () => void;
};

type RunEventBodyFactory = (
  requestIndex: number,
  body: RunRequestBody | null,
) => string | Promise<string>;

/**
 * Seed localStorage with the standard daemon/mock-agent config and intercept
 * /api/agents and /api/app-config GET with deterministic fixtures.
 *
 * Call this from beforeEach for tests that don't need a custom agent or
 * protocol setup. Tests that need custom agents/config should call the
 * individual helpers below instead.
 */
export async function applyStandardMocks(page: Page): Promise<void> {
  await applyStorageConfig(page);
  await routeMockAgents(page);
  await routeAppConfig(page);
  // Keep both explicit even though the shared suite fixture also installs them:
  // callers use applyStandardMocks for extra pages/contexts that are created
  // outside the built-in Playwright `page` fixture, and the fixture's routes are
  // bound to that one page.
  await routeUnavailableVelaStatus(page);
  await suppressWhatsNew(page);
}

/**
 * Keep non-authentication UI specs independent from Cloud account state.
 *
 * Cloud-first onboarding makes a completed local app config and the Cloud
 * session two separate boot gates. A fake signed-in account changes project
 * and conversation APIs to Workspace-scoped behavior, so unrelated local UI
 * specs instead model a valid transient status outage: the app keeps the
 * account state unresolved and does not redirect. Authentication specs route
 * this endpoint themselves with explicit signed-in/signed-out responses.
 */
export async function routeUnavailableVelaStatus(page: Page): Promise<void> {
  await page.route('**/api/integrations/vela/status*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: 'Vela status unavailable in this spec' },
    });
  });
}

/**
 * Keep local-agent scenarios independent from a developer machine's Vela
 * session. Workspace-aware project creation treats a signed-in account as
 * requiring an exact Workspace authority, so leaking the host login here can
 * reject a mocked local-agent create before POST /api/projects is dispatched.
 * AMR scenarios register their own status route after this standard fallback.
 */
export async function routeSignedOutVelaStatus(page: Page): Promise<void> {
  await page.route('**/api/integrations/vela/status*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { loggedIn: false } });
  });
}

/** Keep unrelated release announcements from covering the surface under test. */
export async function suppressWhatsNew(page: Page): Promise<void> {
  await page.route('**/api/whats-new', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { version: 'e2e', id: null, content: null } });
  });
}

/** Seed localStorage with the standard config only (no route interception). */
export async function applyStorageConfig(page: Page): Promise<void> {
  const configJson = JSON.stringify(STANDARD_CONFIG);
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: configJson },
  );
}

/** Intercept GET /api/app-config with the standard fixture. */
export async function routeAppConfig(page: Page): Promise<void> {
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { config: STANDARD_APP_CONFIG } });
  });
}

/** Intercept GET /api/agents with a single standard mock agent. */
export async function routeMockAgents(page: Page): Promise<void> {
  await routeAgents(page, [STANDARD_MOCK_AGENT]);
}

/** Intercept /api/agents for both JSON and streaming callers. */
export async function routeAgents(
  page: Page,
  agents: readonly unknown[],
): Promise<void> {
  await routeSessionModelFixtures(page, agents);
  await page.route('**/api/agents**', async (route) => {
    await fulfillAgentsRoute(route, agents);
  });
}

// The agents each page's UI-only catalog declares, by id. A page can register
// more than one catalog, so the map only grows; a later declaration of the
// same id replaces the earlier one.
const fixtureAgentsByPage = new WeakMap<Page, Map<string, FixtureAgent>>();

/**
 * What a fixture agent declares that the daemon's preflight reads. `models`
 * and `supportsCustomModel` are `AgentInfo` fields. `streamFormat` and
 * `supportsImagePaths` are `RuntimeAgentDef` fields that `AgentInfo` does not
 * expose, so a catalog sets them only when a spec needs the image rule.
 */
type FixtureAgent = {
  modelIds: Set<string>;
  supportsCustomModel?: boolean;
  streamFormat?: string;
  supportsImagePaths?: boolean;
};

function fixtureAgents(agents: readonly unknown[]): Array<[string, FixtureAgent]> {
  return agents.flatMap(agent => {
    const record = agent as {
      id?: unknown; models?: unknown; supportsCustomModel?: unknown;
      streamFormat?: unknown; supportsImagePaths?: unknown;
    } | null;
    const id = record?.id;
    if (typeof id !== 'string' || !id) return [];
    const models = Array.isArray(record?.models) ? record.models : [];
    const modelIds = new Set(models.flatMap(model => {
      const modelId = (model as { id?: unknown } | null)?.id;
      return typeof modelId === 'string' && modelId ? [modelId] : [];
    }));
    return [[id, {
      modelIds,
      ...(typeof record?.supportsCustomModel === 'boolean' ? { supportsCustomModel: record.supportsCustomModel } : {}),
      ...(typeof record?.streamFormat === 'string' ? { streamFormat: record.streamFormat } : {}),
      ...(typeof record?.supportsImagePaths === 'boolean' ? { supportsImagePaths: record.supportsImagePaths } : {}),
    }]];
  });
}

// Mirrors `sanitizeCustomModel` in apps/daemon/src/runtimes/models.ts. The e2e
// layer must not import daemon source, so the rule is restated here.
function customModelIdAccepted(modelId: string): boolean {
  const trimmed = modelId.trim();
  return trimmed === modelId
    && trimmed.length > 0
    && trimmed.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(trimmed);
}

// Mirrors `IMAGE_ROUTING_STREAM_FORMATS` in apps/daemon/src/workbench/model-preflight.ts.
const IMAGE_ROUTING_STREAM_FORMATS = new Set(['pi-rpc', 'acp-json-rpc']);

/**
 * AC-R02.3 preflight for a fixture agent, mirroring `evaluateModelPreflight`
 * in apps/daemon/src/workbench/model-preflight.ts against what the catalog
 * declares:
 * - model: `default`, a declared model, or (unless the agent declares
 *   `supportsCustomModel: false`) a well-formed custom id passes; anything
 *   else is `model-unavailable`. `byok-opencode` uses the contracts'
 *   completeness rule, as the daemon does.
 * - images: rejected only for an agent that declares an image-routing
 *   `streamFormat` without `supportsImagePaths: true`. A catalog that does not
 *   declare `streamFormat` models a file-access CLI, for which the daemon
 *   never rejects images.
 * - size: any attachment over `FILE_UPLOAD_MAX_BYTES`.
 */
function evaluateFixturePreflight(
  agent: FixtureAgent,
  request: ReturnType<typeof parseModelPreflightRequest>,
): ModelPreflightResult {
  const mismatches: ModelPreflightMismatch[] = [];
  if (request.agentId === 'byok-opencode') {
    for (const issue of byokChoiceCompletenessIssues(request)) {
      mismatches.push({ code: 'model-unavailable', message: `Model "${request.modelId}" is not usable for byok-opencode: ${issue.message}` });
    }
  } else {
    const known = request.modelId === 'default'
      || agent.modelIds.has(request.modelId)
      || (agent.supportsCustomModel !== false && customModelIdAccepted(request.modelId));
    if (!known) {
      mismatches.push({ code: 'model-unavailable', message: `Model "${request.modelId}" is not available for ${request.agentId}` });
    }
  }
  const images = (request.attachments ?? []).filter(attachment => attachment.kind === 'image');
  if (
    images.length > 0
    && agent.streamFormat !== undefined
    && IMAGE_ROUTING_STREAM_FORMATS.has(agent.streamFormat)
    && agent.supportsImagePaths !== true
  ) {
    mismatches.push({
      code: 'image-attachments-unsupported',
      message: `${request.agentId} does not forward image attachments to its model`,
      attachmentNames: images.map(attachment => attachment.name),
    });
  }
  const oversized = (request.attachments ?? []).filter(attachment => typeof attachment.size === 'number' && attachment.size > FILE_UPLOAD_MAX_BYTES);
  if (oversized.length > 0) {
    mismatches.push({
      code: 'attachment-too-large',
      message: 'Attachment exceeds the 200 MiB upload limit',
      attachmentNames: oversized.map(attachment => attachment.name),
    });
  }
  return { agentId: request.agentId, modelId: request.modelId, ok: mismatches.length === 0, mismatches };
}

/**
 * UI-only agent fixtures need matching model transport. A catalog's mock
 * agent does not exist in the real daemon. Real-daemon specs do not call
 * routeAgents and retain actual model authority, storage and admission.
 */
export async function routeSessionModelFixtures(page: Page, agents: readonly unknown[] = []): Promise<void> {
  const known = fixtureAgentsByPage.get(page);
  if (known) {
    for (const [id, agent] of fixtureAgents(agents)) known.set(id, agent);
    return;
  }
  const declared = new Map(fixtureAgents(agents));
  fixtureAgentsByPage.set(page, declared);
  // AC-R02.3 preflight for a fixture agent: the real daemon has never heard of
  // it and would report it unavailable. Any other agent keeps real authority.
  await page.route('**/api/workbench/sessions/*/model/preflight', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    let request: ReturnType<typeof parseModelPreflightRequest>;
    try { request = parseModelPreflightRequest(route.request().postDataJSON()); }
    catch { return route.fallback(); }
    const agent = declared.get(request.agentId);
    if (!agent) return route.fallback();
    await route.fulfill({ json: evaluateFixturePreflight(agent, request) });
  });
  const snapshots = new Map<string, SessionModelSnapshot>();
  await page.route('**/api/workbench/sessions/*/model**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/model$/);
    if (!match || !['GET', 'PUT'].includes(request.method())) return route.fallback();
    const headers = request.headers();
    const projectId = headers['x-od-project-id'] ?? url.searchParams.get('projectId');
    const sessionId = decodeURIComponent(match[1]!);
    if (!projectId) return route.fulfill({ status: 400, json: { error: { code: 'BAD_REQUEST', message: 'Pass a project scope' } } });
    const key = JSON.stringify([projectId, sessionId, headers['x-od-workspace-id'], headers['x-od-workspace-member-id']]);
    const current = snapshots.get(key) ?? { projectId, sessionId, revision: 0, choice: null, updatedAt: 0 };
    if (request.method() === 'GET') return route.fulfill({ json: current });
    let input: ReturnType<typeof parsePutSessionModel>;
    try { input = parsePutSessionModel(request.postDataJSON()); }
    catch { return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_FAILED', message: 'Pass a complete public model choice and revision' } } }); }
    const { expectedRevision, ...choice } = input;
    if (expectedRevision > current.revision) return route.fulfill({ status: 400, json: { error: { code: 'VALIDATION_FAILED', message: 'Expected revision is in the future' } } });
    if (sessionModelChoicesEqual(current.choice, choice)) return route.fulfill({ json: current });
    if (expectedRevision !== current.revision) return route.fulfill({ status: 409, json: { error: { code: 'session-model-conflict', message: 'Model choice changed', details: { current } } } });
    const next = { projectId, sessionId, revision: current.revision + 1, choice, updatedAt: Date.now() };
    snapshots.set(key, next);
    await route.fulfill({ json: next });
  });
}

export async function fulfillAgentsRoute(
  route: Route,
  agents: readonly unknown[],
): Promise<void> {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }

  const url = new URL(route.request().url());
  if (url.pathname !== '/api/agents') {
    await route.fallback();
    return;
  }

  if (url.searchParams.get('stream') !== '1') {
    await route.fulfill({ json: { agents } });
    return;
  }

  const agentEvents = agents
    .map((agent) => `event: agent\ndata: ${JSON.stringify(agent)}\n\n`)
    .join('');
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream; charset=utf-8',
    body: `${agentEvents}event: done\ndata: {}\n\n`,
  });
}

export async function routeSuccessfulRuns(
  page: Page,
  options: {
    bodies?: RunRequestBody[];
    runId?: string;
    runIdPrefix?: string;
    events?: boolean | 'pending';
    eventBody?: string | RunEventBodyFactory;
  } = {},
): Promise<RunRequestTracker> {
  const bodies = options.bodies ?? [];
  const runIdPrefix = options.runIdPrefix ?? 'mock-run';
  let requestCount = 0;

  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    const raw = route.request().postData();
    const body = raw ? JSON.parse(raw) as RunRequestBody : null;
    if (body) bodies.push(body);
    requestCount += 1;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: options.runId ?? `${runIdPrefix}-${requestCount}` }),
    });
  });

  if (options.events === 'pending') {
    await page.route('**/api/runs/*/events', async () => {
      await new Promise(() => undefined);
    });
  } else if (options.events !== false) {
    await page.route('**/api/runs/*/events', async (route) => {
      const eventBody = typeof options.eventBody === 'function'
        ? await options.eventBody(bodies.length, bodies.at(-1) ?? null)
        : options.eventBody ?? successfulRunEventBody();
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: eventBody,
      });
    });
  }

  return makeRunRequestTracker(bodies);
}

export async function routeRunSequence(
  page: Page,
  options: {
    bodies?: RunRequestBody[];
    runIdPrefix?: string;
    eventBodies: Array<string | RunEventBodyFactory>;
  },
): Promise<RunRequestTracker> {
  const bodies = options.bodies ?? [];
  const runIdPrefix = options.runIdPrefix ?? 'mock-run';
  let requestCount = 0;
  let eventCount = 0;

  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    const raw = route.request().postData();
    const body = raw ? JSON.parse(raw) as RunRequestBody : null;
    if (body) bodies.push(body);
    requestCount += 1;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: `${runIdPrefix}-${requestCount}` }),
    });
  });

  await page.route('**/api/runs/*/events', async (route) => {
    eventCount += 1;
    const index = Math.min(eventCount - 1, options.eventBodies.length - 1);
    const selected = options.eventBodies[index] ?? successfulRunEventBody();
    const eventBody = typeof selected === 'function'
      ? await selected(eventCount, bodies.at(-1) ?? null)
      : selected;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: eventBody,
    });
  });

  return makeRunRequestTracker(bodies);
}

export function successfulRunEventBody(events: string[] = []): string {
  return [...events, 'event: end', 'data: {"code":0,"status":"succeeded"}', '', ''].join('\n');
}

export function failedRunEventBody(message: string): string {
  return [
    'event: start',
    'data: {"bin":"mock-agent"}',
    '',
    'event: error',
    `data: ${JSON.stringify({ message })}`,
    '',
    '',
  ].join('\n');
}

export function trackRunRequests(page: Page): RunRequestTracker {
  const bodies: RunRequestBody[] = [];
  const listener = (request: Request) => {
    if (!isCreateRunRequest(request)) return;
    const raw = request.postData();
    bodies.push(raw ? JSON.parse(raw) as RunRequestBody : {});
  };
  page.on('request', listener);
  return {
    ...makeRunRequestTracker(bodies),
    dispose: () => page.off('request', listener),
  };
}

function isCreateRunRequest(request: Request): boolean {
  const url = new URL(request.url());
  return url.pathname === '/api/runs' && request.method() === 'POST';
}

function makeRunRequestTracker(bodies: RunRequestBody[]): RunRequestTracker {
  const expectCount = async (count: number, options: { timeout?: number; message?: string } = {}) => {
    const pollOptions: { timeout: number; message?: string } = {
      timeout: options.timeout ?? 10_000,
    };
    if (options.message) pollOptions.message = options.message;
    await expect.poll(() => bodies.length, pollOptions).toBe(count);
  };

  return {
    bodies,
    expectCount,
    async expectNone(options = {}) {
      await expectStableCount(() => bodies.length, 0, {
        timeout: options.timeout ?? 750,
        message: options.message ?? 'expected no POST /api/runs requests during the settled observation window',
      });
    },
  };
}
