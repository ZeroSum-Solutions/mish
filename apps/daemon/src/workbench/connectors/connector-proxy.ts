import { McpCredentialFileError } from '../../mcp-private-file.js';
import { setTimeout as wait } from 'node:timers/promises';
import { untilAborted } from '../references/abort.js';
import {
  CONNECTOR_IDS, CONNECTOR_PLATFORMS, SOURCE_OPERATIONS, parseConnectorDetailRequest, parseConnectorDetailResponse, parseConnectorSearchRequest, parseConnectorSearchResponse, parseConnectorSelectionRequest,
  type ConnectorErrorCode, type ConnectorId, type ConnectorReceipt, type ConnectorReferenceDetailResponse, type ConnectorResource, type ConnectorSearchRequest, type ConnectorSearchResponse,
} from '@mish/contracts';
import { MobbinImageCache, mobbinImageUrl } from './mobbin-image-cache.js';
import { ConnectorError } from './connector-error.js';
export { ConnectorError } from './connector-error.js';
import { resolveMotionSitesMcpConnection } from '../../motionsites/connection.js';
import { MotionSitesLoginRequiredError } from '../../motionsites/errors.js';
import { callMotionSitesTool, McpHttpTransportError } from '../../motionsites/mcp-client.js';
import { INTEGRATION_ROSTER_ROWS } from '../integration-roster-data.js';
import { DaemonBindingError, requireDaemonMcpServer, resolveDaemonMcpConnection, type DaemonMcpConnection, type DaemonMcpMatch } from './mcp-binding.js';
import {
  MOBBIN_ALLOWED_REASON, MOBBIN_BINDING_STEPS, MOBBIN_EVIDENCE, MOBBIN_FROZEN_TOOLS, MOBBIN_RIGHTS_ASSESSMENT, MOBBIN_RIGHTS_SUMMARY, MOBBIN_SERVER_ID, MOBBIN_UNASSESSED_REASON,
} from './mobbin.js';
import { REFERO_BINDING_STEPS, REFERO_EVIDENCE, REFERO_RIGHTS_ASSESSMENT, REFERO_RIGHTS_SUMMARY, REFERO_SERVER_ID, freezeReferoSchema, referoSearchPlan } from './refero.js';

/**
 * AC-R12.2 typed read-only connector proxy. The daemon resolves the connector's own
 * configured MCP binding and saved credential (never copied, never returned), calls
 * only a tool whose schema was frozen from a recorded handshake, validates every
 * provider item and maps it to an attributed ConnectorResource whose rights come
 * from daemon policy. Provider text is bounded data; it never reaches a prompt here.
 *
 * Bounds: one attempt timeout (15 s by default), at most one transient retry with
 * jitter, Retry-After above the retry ceiling is reported instead of waited on.
 * Detail is served from the permission-safe captured reference (id, title, link,
 * category, access); no protected body (MotionSites `get_prompt`) is fetched, and
 * Mobbin exposes no detail tool. A revoked credential invalidates every captured
 * reference for that connector.
 *
 * Bindings (G29/B069): MotionSites resolves its built-in daemon entry; Mobbin and Refero need their own
 * daemon MCP server entry and daemon-saved OAuth token. Without one it refuses with
 * `connector-binding-missing` before any I/O. Another agent's login is never read.
 */

interface FrozenTool { name: string; schemaDigest: string | null; evidenceRef: string }
type Operation = (typeof SOURCE_OPERATIONS)[number];
type OperationDecision = ConnectorResource['rights']['operations'][number];
/** One validated provider row, before daemon policy adds attribution and rights. */
interface ProviderRow { itemId: unknown; title: unknown; url: unknown; category: string | null; access: unknown }
/** What one search dispatches: a frozen tool and arguments that tool's frozen schema accepts. */
interface SearchPlan { tool: FrozenTool; args: Record<string, unknown> }
interface ConnectorDefinition {
  id: ConnectorId; provider: string; providerUrl: string;
  /** Null until a recorded handshake froze the tool schema; such a connector never dispatches. */
  plan: ((request: ConnectorSearchRequest) => SearchPlan) | null;
  /** Every frozen tool `plan` may dispatch, for evidence cross-checks. */
  tools: readonly FrozenTool[];
  /** Where the daemon's own binding lives. Absent: the built-in MotionSites resolution. */
  binding?: { match: DaemonMcpMatch; nextSteps: readonly string[] };
  rowsKeys: readonly string[];
  row: (value: Record<string, unknown>, request: ConnectorSearchRequest) => ProviderRow;
  /** Provider notice the tool contract asks hosts to show word for word. */
  notice?: (data: Record<string, unknown>) => unknown;
  rights: { status: ConnectorResource['rights']['status']; summary: string; decide: (operation: Operation) => OperationDecision };
  canonicalHosts: readonly string[];
}
const decideFromPolicy = (blocked: Partial<Record<Operation, string>>, unknownReason: string) => (operation: Operation): OperationDecision => {
  const reason = blocked[operation];
  return reason ? { operation, decision: 'blocked', reason } : { operation, decision: 'unknown', reason: unknownReason };
};
/** Mobbin rights come from its committed RightsAssessment, never from provider output. */
const decideFromMobbinAssessment = (operation: Operation): OperationDecision => {
  const right = MOBBIN_RIGHTS_ASSESSMENT.operationRights.find(item => item.operation === operation);
  if (!right) return { operation, decision: 'unknown', reason: MOBBIN_UNASSESSED_REASON };
  if (right.decision === 'allowed') return { operation, decision: 'allowed', reason: right.reason ?? MOBBIN_ALLOWED_REASON, evidenceRefs: [MOBBIN_EVIDENCE.rightsAssessment] };
  return { operation, decision: right.decision, reason: right.reason ?? MOBBIN_UNASSESSED_REASON, evidenceRefs: [MOBBIN_EVIDENCE.rightsAssessment] };
};
const requestInvalid = (message: string) => new ConnectorError(400, 'connector-request-invalid', message);
/** Local credential refusal is a setup error, never evidence that the provider is down. */
function credentialFileRefusal(error: McpCredentialFileError): ConnectorError {
  return new ConnectorError(409, 'connector-binding-missing', error.message, {
    retryable: false, nextSteps: ['Repair saved credentials in Settings → External MCP servers'],
  });
}
const firstString = (...values: unknown[]): unknown => values.find(value => typeof value === 'string' && value.trim());

const MOTIONSITES_SCHEMA_EVIDENCE = 'docs/plans/2026-10-03-motionsites-native-routing-proof.md';
const MOTIONSITES_SEARCH: FrozenTool = { name: 'search_prompts', schemaDigest: 'e860ed5577971f1c95c13c60ccf91b153402b07942ad18be9421348207253292', evidenceRef: MOTIONSITES_SCHEMA_EVIDENCE };
/** Frozen Mobbin arguments: deep relevance first for screens; fallback is bounded and recorded by the proxy. */
function mobbinPlan(request: ConnectorSearchRequest): SearchPlan {
  if (!request.kind) throw requestInvalid('Mobbin search needs a kind: screens, flows or sections');
  const frozen = MOBBIN_FROZEN_TOOLS[request.kind];
  if (frozen.platform && !request.platform) throw requestInvalid(`Mobbin ${request.kind} search needs a platform: ios or web`);
  if (!frozen.platform && request.platform) throw requestInvalid('Mobbin sections search takes no platform');
  const args: Record<string, unknown> = {
    query: request.query, ...(request.platform ? { platform: request.platform } : {}), limit: Math.min(request.limit, frozen.maxLimit),
    ...(request.kind === 'screens' ? { mode: 'deep' } : {}), output_destination: 'design_tool', output_tool: 'Mishh Mashh',
  };
  return { tool: { name: frozen.name, schemaDigest: frozen.schemaDigest, evidenceRef: frozen.evidenceRef }, args };
}
export const CONNECTOR_DEFINITIONS: Readonly<Record<ConnectorId, ConnectorDefinition>> = Object.freeze({
  motionsites: {
    id: 'motionsites', provider: 'MotionSites', providerUrl: 'https://motionsites.ai',
    // Live read-only handshake of 2026-10-03: search_prompts, list_prompts, get_prompt, get_related_prompts.
    plan: request => {
      if (request.kind || request.platform) throw requestInvalid('MotionSites search takes no kind or platform');
      return { tool: MOTIONSITES_SEARCH, args: { query: request.query, limit: request.limit } };
    },
    tools: [MOTIONSITES_SEARCH],
    rowsKeys: ['results'],
    row: value => ({ itemId: value.id, title: value.title, url: value.url, category: typeof value.category === 'string' ? value.category : null, access: value.access }),
    rights: {
      status: 'restricted', summary: 'All rights reserved; no redistribution grant. Attributed reference viewing through the owner\'s own account only.',
      decide: decideFromPolicy({
        'cache-source-content': 'Terms of 2026-09-30 forbid bulk access; only non-secret reference metadata is held, in memory.',
        'derive-from-reference': 'No derive-from-reference grant recorded (G30); R15 input stays blocked.',
        'redistribute-unit': 'Terms of 2026-09-30 forbid raw redistribution.',
      }, 'No RightsAssessment recorded for this operation (G30).'),
    },
    canonicalHosts: ['motionsites.ai'],
  },
  refero: {
    id: 'refero', provider: 'Refero', providerUrl: 'https://refero.design',
    plan: request => {
      let plan;
      try { plan = referoSearchPlan(request); } catch { throw requestInvalid('Refero search needs screens or flows and a platform: ios or web'); }
      return { tool: { name: plan.name, schemaDigest: null, evidenceRef: REFERO_EVIDENCE }, args: plan.args };
    },
    // Actual schemas are frozen by tools/list in the same session before each search.
    tools: [], binding: { match: { serverId: REFERO_SERVER_ID, hosts: ['api.refero.design'] }, nextSteps: REFERO_BINDING_STEPS },
    rowsKeys: ['results', 'screens', 'flows', 'records'],
    row: (value, request) => {
      const site = value.site && typeof value.site === 'object' && !Array.isArray(value.site) ? value.site as Record<string, unknown> : null;
      return { itemId: typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id >= 0 ? String(value.id) : firstString(value.id, value.uuid), title: firstString(value.title, value.name, value.app_name, site?.name), url: firstString(value.refero_url, value.url), category: request.kind === 'flows' ? 'flow' : 'screen', access: null };
    },
    rights: { status: 'reference-only', summary: REFERO_RIGHTS_SUMMARY, decide: operation => {
      const right = REFERO_RIGHTS_ASSESSMENT.operationRights.find(item => item.operation === operation);
      return { operation, decision: right?.decision ?? 'unknown', reason: right?.reason ?? 'Not assessed by B069.', evidenceRefs: [REFERO_EVIDENCE] };
    } }, canonicalHosts: ['refero.design'],
  },
  mobbin: {
    id: 'mobbin', provider: 'Mobbin', providerUrl: 'https://mobbin.com',
    // Agent-run receipt of 2026-10-08 (G29): search_screens, search_flows, search_sections; no detail tool.
    plan: mobbinPlan,
    tools: Object.values(MOBBIN_FROZEN_TOOLS).map(({ name, schemaDigest, evidenceRef }) => ({ name, schemaDigest, evidenceRef })),
    binding: { match: { serverId: MOBBIN_SERVER_ID, hosts: ['api.mobbin.com'] }, nextSteps: MOBBIN_BINDING_STEPS },
    // The receipt recorded item fields, not the envelope key, so each search kind's plural is accepted too.
    rowsKeys: ['results', 'screens', 'flows', 'sections'],
    row: (value, request) => {
      const platform = (CONNECTOR_PLATFORMS as readonly unknown[]).includes(value.platform) ? value.platform as string : request.platform ?? null;
      const label = MOBBIN_FROZEN_TOOLS[request.kind ?? 'screens'].label;
      return { itemId: value.id, title: firstString(value.app_name, value.title, value.name, value.site_name), url: value.mobbin_url, category: platform ? `${label} · ${platform}` : label, access: null };
    },
    notice: data => {
      const notice = data.ai_usage_notice;
      return notice && typeof notice === 'object' ? (notice as { text?: unknown }).text : notice;
    },
    rights: { status: 'restricted', summary: MOBBIN_RIGHTS_SUMMARY, decide: decideFromMobbinAssessment },
    canonicalHosts: ['mobbin.com'],
  },
});

export interface ConnectorProxyDeps {
  dataDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}
const throwIfSearchAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new ConnectorError(504, 'connector-timeout', 'Reference search deadline exceeded');
};
const RETRY_CEILING_SECONDS = 2;
const CACHE_LIMIT = 500;

/** R15 brief references (`deriveFromReference`) read a connector's derive decision from daemon policy. */
export function connectorDeriveDecision(id: ConnectorId): 'permitted' | 'unknown' | 'blocked' {
  const decision = CONNECTOR_DEFINITIONS[id].rights.decide('derive-from-reference').decision;
  return decision === 'allowed' ? 'permitted' : decision;
}
const NOTICE_MAX = 4000;
/** Bounded plain text that keeps line breaks; other control/format characters are dropped. */
const sanitizeNotice = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/gu, '\n').replace(/[\p{Cf}]|(?![\n])[\p{Cc}]/gu, '').trim().slice(0, NOTICE_MAX).trim();
  return text || null;
};

const sanitize = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, max);
function canonicalLink(value: unknown, hosts: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (!hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.toString();
  } catch { return null; }
}

export class ConnectorProxy {
  readonly #deps: ConnectorProxyDeps;
  readonly #captured = new Map<ConnectorId, Map<string, { resource: ConnectorResource; receipt: ConnectorReceipt; imageUrl?: unknown; providerNotice?: string }>>();
  readonly #revoked = new Map<ConnectorId, ConnectorErrorCode>();
  readonly #images: MobbinImageCache;
  constructor(deps: ConnectorProxyDeps) { this.#deps = deps; this.#images = new MobbinImageCache(deps); }

  async search(connectorId: string, input: unknown, options?: { signal?: AbortSignal }): Promise<ConnectorSearchResponse> {
    const definition = this.#definition(connectorId);
    let request;
    try { request = parseConnectorSearchRequest(input); } catch { throw new ConnectorError(400, 'connector-request-invalid', 'Invalid connector search request'); }
    const plan = this.#plan(definition, request);
    throwIfSearchAborted(options?.signal);
    await this.#requireBinding(definition);
    throwIfSearchAborted(options?.signal);
    const { tool } = plan;
    const { result, attempts, durationMs, schemaDigest, searchMode } = await this.#searchCall(definition, plan, options?.signal);
    throwIfSearchAborted(options?.signal);
    const capturedAt = new Date(this.#now()).toISOString();
    const receipt: ConnectorReceipt = { binding: 'daemon-mcp-config', toolName: tool.name, schemaDigest, attempts, durationMs, retrievedAt: capturedAt, ...(searchMode ? { searchMode } : {}) };
    const { rows, data } = this.#resultRows(definition, result);
    const providerNotice = definition.notice ? sanitizeNotice(definition.notice(data)) : null;
    const results: ConnectorResource[] = [];
    const images = new Map<ConnectorResource, string | null>();
    let excluded = 0;
    for (const row of rows.slice(0, request.limit)) {
      const resource = this.#resource(definition, row, request, capturedAt);
      if (resource) {
        results.push(resource);
        if (definition.id === 'mobbin') images.set(resource, mobbinImageUrl((row as { image_url?: unknown }).image_url));
      } else excluded++;
    }
    excluded += Math.max(0, rows.length - request.limit);
    // Validate the complete DTO before mutating captured state, including provider links.
    const response = parseConnectorSearchResponse({ schema: 'connector-search/1', connectorId: definition.id, results, receipt, excluded, ...(providerNotice ? { providerNotice } : {}) });
    this.#revoked.delete(definition.id);
    if (definition.id === 'mobbin') await this.#images.allow();
    const cache = this.#captured.get(definition.id) ?? new Map();
    for (const resource of results) {
      cache.delete(resource.itemId); cache.set(resource.itemId, { resource, receipt, ...(definition.id === 'mobbin' ? { imageUrl: images.get(resource) } : {}), ...(providerNotice ? { providerNotice } : {}) });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }
    this.#captured.set(definition.id, cache);
    return response;
  }

  async detail(connectorId: string, input: unknown): Promise<ConnectorReferenceDetailResponse> {
    const definition = this.#definition(connectorId);
    let request;
    try { request = parseConnectorDetailRequest(input); } catch { throw new ConnectorError(400, 'connector-request-invalid', 'Invalid connector detail request'); }
    if (!definition.plan) this.#unfrozen(definition);
    await this.#requireBinding(definition);
    const revoked = this.#revoked.get(definition.id);
    if (revoked) throw this.#accessError(revoked);
    const captured = this.#captured.get(definition.id)?.get(request.itemId);
    if (!captured) throw new ConnectorError(404, 'connector-item-unknown', 'This reference was not captured by a search in this session; search again', { nextSteps: ['Search the connector, then open the result'] });
    return parseConnectorDetailResponse({ schema: 'connector-detail/1', connectorId: definition.id, resource: captured.resource, source: 'captured-reference', receipt: captured.receipt, ...(captured.providerNotice ? { providerNotice: captured.providerNotice } : {}) });
  }

  /** User selection only: exact capture revision, daemon rights, own binding, then local bytes. */
  async select(connectorId: string, input: unknown): Promise<ConnectorReferenceDetailResponse> {
    const definition = this.#definition(connectorId);
    if (definition.id !== 'mobbin') throw requestInvalid('Image selection is only available for Mobbin');
    let request;
    try { request = parseConnectorSelectionRequest(input); } catch { throw requestInvalid('Invalid connector selection'); }
    await this.#imageAccess(definition);
    const saved = await this.#images.read(this.#images.key(request.itemId, request.capturedAt));
    if (saved) return saved.detail;
    const captured = this.#captured.get(definition.id)?.get(request.itemId);
    if (!captured) throw new ConnectorError(404, 'connector-item-unknown', 'Search Mobbin before selecting this reference');
    if (captured.resource.capturedAt !== request.capturedAt) throw new ConnectorError(409, 'connector-request-invalid', 'The selected Mobbin capture is stale; reselect its current revision');
    const detail = parseConnectorDetailResponse({ schema: 'connector-detail/1', connectorId: definition.id, source: 'captured-reference',
      resource: captured.resource, receipt: captured.receipt, ...(captured.providerNotice ? { providerNotice: captured.providerNotice } : {}) });
    const selected = await this.#images.select(detail, captured.imageUrl);
    // A concurrent revocation or config removal cannot admit completed bytes to the caller.
    await this.#imageAccess(definition);
    const cache = this.#captured.get(definition.id);
    if (cache?.get(request.itemId) === captured) cache.set(request.itemId, { ...captured, resource: selected.resource });
    return selected;
  }

  /** Serves verified local bytes; never refetches the expiring CDN URL on a GET. */
  async selectedImage(connectorId: string, key: string): Promise<{ bytes: Buffer; contentType: string }> {
    const definition = this.#definition(connectorId);
    if (definition.id !== 'mobbin') throw requestInvalid('Image cache is only available for Mobbin');
    await this.#imageAccess(definition);
    const saved = await this.#images.read(key);
    if (!saved) throw new ConnectorError(404, 'connector-item-unknown', 'No saved Mobbin image');
    return { bytes: saved.bytes, contentType: saved.detail.resource.cachedImage!.contentType };
  }

  async #imageAccess(definition: ConnectorDefinition): Promise<void> {
    for (const operation of ['cache-source-content', 'host-preview'] as const) {
      if (definition.rights.decide(operation).decision !== 'allowed') throw new ConnectorError(403, 'connector-operation-blocked', 'Mobbin private image caching or viewing is not permitted by daemon policy');
    }
    const revoked = this.#revoked.get(definition.id);
    if (revoked) throw this.#accessError(revoked);
    if (await this.#images.revoked()) throw this.#accessError('connector-access-revoked');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#deps.timeoutMs ?? 15_000);
    const base = this.#deps.fetchImpl ?? fetch;
    try { await this.#connection(definition, (input, init) => base(input, { ...init, signal: controller.signal })); }
    finally { clearTimeout(timer); }
  }

  /** Deep and standard each get one timeout-bound pass, without multiplying transient retries. */
  async #searchCall(definition: ConnectorDefinition, plan: SearchPlan, signal?: AbortSignal) {
    if (definition.id !== 'mobbin' || plan.args.mode !== 'deep') return { ...await this.#call(definition, plan.tool, plan.args, 2, signal), searchMode: undefined };
    const started = this.#now();
    let fallbackReason: NonNullable<ConnectorReceipt['searchMode']>['fallbackReason'] = null;
    try {
      const call = await this.#call(definition, plan.tool, plan.args, 1, signal);
      this.#resultRows(definition, call.result);
      return { ...call, searchMode: { requested: 'deep' as const, used: 'deep' as const, fallbackReason } };
    } catch (error) {
      if (!(error instanceof ConnectorError) || !['connector-timeout', 'connector-unavailable', 'connector-response-invalid', 'connector-tool-denied'].includes(error.code)) throw error;
      throwIfSearchAborted(signal);
      fallbackReason = error.code as NonNullable<ConnectorReceipt['searchMode']>['fallbackReason'];
    }
    const call = await this.#call(definition, plan.tool, { ...plan.args, mode: 'standard' }, 1, signal);
    return { ...call, attempts: 2, durationMs: Math.max(0, Math.round(this.#now() - started)), searchMode: { requested: 'deep' as const, used: 'standard' as const, fallbackReason } };
  }

  /** A reference this daemon captured and still holds (cleared on revocation or a lost binding). No I/O. */
  capturedReference(connectorId: ConnectorId, itemId: string): ConnectorResource | null {
    return this.#captured.get(connectorId)?.get(itemId)?.resource ?? null;
  }

  #now(): number { return (this.#deps.now ?? Date.now)(); }
  #definition(connectorId: string): ConnectorDefinition {
    if (!(CONNECTOR_IDS as readonly string[]).includes(connectorId)) throw new ConnectorError(404, 'connector-unknown', 'Unknown connector');
    return CONNECTOR_DEFINITIONS[connectorId as ConnectorId];
  }
  #plan(definition: ConnectorDefinition, request: ConnectorSearchRequest): SearchPlan {
    if (!definition.plan) this.#unfrozen(definition);
    return definition.plan(request);
  }
  #unfrozen(definition: ConnectorDefinition): never {
    const row = INTEGRATION_ROSTER_ROWS.find(entry => entry.id === definition.id);
    throw new ConnectorError(422, 'connector-schema-not-frozen', `${definition.provider} has no frozen tool schema or daemon-reachable binding; nothing was dispatched`, {
      missingReceipts: row?.pendingReceipts ?? ['Frozen tool schema and same-principal binding receipt'], gateIds: row?.gateIds ?? [],
      nextSteps: row?.pendingReceipts ?? [],
    });
  }
  /** Config read only (no token, no network): a connector with its own binding must have one configured. */
  async #requireBinding(definition: ConnectorDefinition): Promise<void> {
    if (!definition.binding) return;
    try { await requireDaemonMcpServer(this.#deps.dataDir, definition.binding.match); } catch (error) {
      if (error instanceof McpCredentialFileError) throw credentialFileRefusal(error);
      if (error instanceof DaemonBindingError) { await this.#lostBinding(definition.id, error.code); throw this.#bindingError(definition, error.code); }
      throw error;
    }
  }
  #bindingError(definition: ConnectorDefinition, code: DaemonBindingError['code']): ConnectorError {
    if (code === 'connector-needs-sign-in') return this.#accessError(code);
    return new ConnectorError(409, 'connector-binding-missing', `Mishh Mashh has no ${definition.provider} connection of its own; nothing was sent to ${definition.provider}`, {
      nextSteps: [...(definition.binding?.nextSteps ?? [])],
    });
  }
  async #connection(definition: ConnectorDefinition, fetchImpl: typeof fetch): Promise<DaemonMcpConnection> {
    try {
      if (!definition.binding) return await resolveMotionSitesMcpConnection(this.#deps.dataDir, fetchImpl);
      return await resolveDaemonMcpConnection(this.#deps.dataDir, definition.binding.match, fetchImpl);
    } catch (error) {
      if (error instanceof McpCredentialFileError) throw credentialFileRefusal(error);
      if (error instanceof DaemonBindingError) { await this.#lostBinding(definition.id, error.code); throw this.#bindingError(definition, error.code); }
      throw error;
    }
  }
  #accessError(code: ConnectorErrorCode): ConnectorError {
    return code === 'connector-needs-sign-in'
      ? new ConnectorError(409, 'connector-needs-sign-in', 'Connect this source with your own account in Settings → External MCP, then search again', { nextSteps: ['Sign in to the connector from Settings → External MCP'] })
      : new ConnectorError(409, 'connector-access-revoked', 'The connector refused the saved credential; captured references were cleared. Reconnect, then search again', { nextSteps: ['Reconnect the connector from Settings'] });
  }
  async #invalidate(id: ConnectorId, code: ConnectorErrorCode): Promise<void> {
    this.#captured.delete(id); this.#revoked.set(id, code);
    if (id === 'mobbin' && code === 'connector-access-revoked') await this.#images.revoke();
  }
  /** A removed binding drops captured references; a missing sign-in also reports itself on detail. */
  async #lostBinding(id: ConnectorId, code: DaemonBindingError['code']): Promise<void> {
    if (code === 'connector-needs-sign-in') await this.#invalidate(id, code); else { this.#captured.delete(id); this.#revoked.delete(id); }
  }

  /** One attempt, plus at most one transient retry. Never echoes provider text, URL or credential. */
  async #call(definition: ConnectorDefinition, tool: FrozenTool, args: Record<string, unknown>, maxAttempts = 2, signal?: AbortSignal): Promise<{ result: { isError: boolean; text: string; data: unknown }; attempts: number; durationMs: number; schemaDigest: string }> {
    const started = this.#now();
    for (let attempt = 1; ; attempt++) {
      throwIfSearchAborted(signal);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#deps.timeoutMs ?? 15_000);
      const base = this.#deps.fetchImpl ?? fetch;
      // Configured credentials belong to this endpoint; a redirect must not forward them elsewhere.
      const fetchImpl: typeof fetch = (input, init) => base(input, { ...init, signal: requestSignal, redirect: 'error' });
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const connection = await untilAborted(requestSignal, () => this.#connection(definition, fetchImpl));
        const freezeSchema = definition.id === 'refero' ? (catalog: unknown, name: string, toolArgs: Record<string, unknown>) => {
          try { return freezeReferoSchema(catalog, name, toolArgs); } catch {
            throw new ConnectorError(422, 'connector-schema-not-frozen', 'Refero search schema is missing or incompatible; nothing was dispatched', { gateIds: ['G18'], nextSteps: ['Reconnect Refero and verify its screens/flows search schema'] });
          }
        } : undefined;
        const result = await untilAborted(requestSignal, () => callMotionSitesTool({ ...connection, fetchImpl, ...(freezeSchema ? { freezeSchema } : {}) }, tool.name, { ...args }));
        if (result.isError) throw new ConnectorError(409, 'connector-tool-denied', `${definition.provider} declined this request; check the account's access and plan`);
        const schemaDigest = result.schemaDigest ?? tool.schemaDigest;
        if (!schemaDigest) throw new ConnectorError(422, 'connector-schema-not-frozen', 'No frozen schema receipt');
        return { result, attempts: attempt, durationMs: Math.max(0, Math.round(this.#now() - started)), schemaDigest };
      } catch (error) {
        if (signal?.aborted) throw new ConnectorError(504, 'connector-timeout', 'Reference search deadline exceeded');
        if (error instanceof ConnectorError) throw error;
        if (error instanceof MotionSitesLoginRequiredError) { await this.#invalidate(definition.id, 'connector-needs-sign-in'); throw this.#accessError('connector-needs-sign-in'); }
        if (controller.signal.aborted) throw new ConnectorError(504, 'connector-timeout', `${definition.provider} did not answer in time; try again`, { retryable: true });
        if (!(error instanceof McpHttpTransportError)) throw new ConnectorError(502, 'connector-unavailable', `${definition.provider} is unavailable`);
        if (error.status === 401 || error.status === 403) { await this.#invalidate(definition.id, 'connector-access-revoked'); throw this.#accessError('connector-access-revoked'); }
        const rateLimited = error.status === 429;
        const transient = rateLimited ? (error.retryAfterSeconds ?? 0) <= RETRY_CEILING_SECONDS : error.status === undefined || error.status >= 500;
        if (transient && attempt < maxAttempts) {
          const delay = Math.round(250 + (this.#deps.random ?? Math.random)() * 500);
          try {
            if (this.#deps.sleep) await untilAborted(requestSignal, () => this.#deps.sleep!(delay));
            else await wait(delay, undefined, { signal: requestSignal });
          } catch (error) {
            if (requestSignal.aborted) throw new ConnectorError(504, 'connector-timeout', 'Reference search deadline exceeded');
            throw error;
          }
          continue;
        }
        if (rateLimited) throw new ConnectorError(429, 'connector-rate-limited', `${definition.provider} is rate limiting requests; try again later`, { retryAfterSeconds: error.retryAfterSeconds ?? null, retryable: true });
        throw new ConnectorError(502, 'connector-unavailable', `${definition.provider} is unavailable`, { retryable: true });
      } finally { clearTimeout(timer); }
    }
  }

  #resultRows(definition: ConnectorDefinition, result: { text: string; data: unknown }): { rows: unknown[]; data: Record<string, unknown> } {
    const pick = (value: unknown): { rows: unknown[]; data: Record<string, unknown> } | null => {
      if (!value || typeof value !== 'object') return null;
      const data = value as Record<string, unknown>;
      const key = definition.rowsKeys.find(name => Array.isArray(data[name]));
      return key ? { rows: data[key] as unknown[], data } : null;
    };
    let picked = pick(result.data);
    if (!picked) { try { picked = pick(JSON.parse(result.text)); } catch { picked = null; } }
    if (!picked) throw new ConnectorError(502, 'connector-response-invalid', 'The connector answered with an unexpected shape; nothing was captured');
    return picked;
  }

  /** Daemon policy maps one provider row; unknown fields (including any rights claim) are ignored. */
  #resource(definition: ConnectorDefinition, row: unknown, request: ConnectorSearchRequest, capturedAt: string): ConnectorResource | null {
    if (!row || typeof row !== 'object') return null;
    const value = definition.row(row as Record<string, unknown>, request);
    if (typeof value.itemId !== 'string' || typeof value.title !== 'string') return null;
    const itemId = sanitize(value.itemId, 200), title = sanitize(value.title, 300);
    const canonicalUrl = canonicalLink(value.url, definition.canonicalHosts);
    if (!itemId || !title || !canonicalUrl) return null;
    const category = value.category !== null && sanitize(value.category, 120) ? sanitize(value.category, 120) : null;
    const operations = SOURCE_OPERATIONS.map(definition.rights.decide);
    return {
      connectorId: definition.id, itemId, title, category, access: value.access === 'free' || value.access === 'premium' ? value.access : 'unknown',
      canonicalUrl, capturedAt, attribution: { provider: definition.provider, url: definition.providerUrl },
      rights: { status: definition.rights.status, summary: definition.rights.summary, operations },
      supportedOperations: ['open-source-link'], untrusted: true,
    };
  }
}
