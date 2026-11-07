import type { BoundedJsonObject, BoundedJsonValue } from './live-artifacts';

export type ConnectorStatus = 'available' | 'connected' | 'error' | 'disabled';

export type ConnectorToolSideEffect = 'read' | 'write' | 'destructive' | 'unknown';

export type ConnectorToolApproval = 'auto' | 'confirm' | 'disabled';

export type ConnectorToolUseCase = 'personal_daily_digest';

export interface ConnectorToolSafety {
  sideEffect: ConnectorToolSideEffect;
  approval: ConnectorToolApproval;
  reason: string;
}

export interface ConnectorToolCuration {
  useCases?: ConnectorToolUseCase[];
  reason?: string;
}

export interface ConnectorToolDetail {
  name: string;
  title: string;
  description?: string;
  inputSchemaJson?: BoundedJsonObject;
  outputSchemaJson?: BoundedJsonObject;
  safety: ConnectorToolSafety;
  refreshEligible: boolean;
  curation?: ConnectorToolCuration;
}

export interface ConnectorDetail {
  id: string;
  name: string;
  provider: string;
  category: string;
  description?: string;
  status: ConnectorStatus;
  accountLabel?: string;
  tools: ConnectorToolDetail[];
  /**
   * Runtime execution allowlist. Subset of `tools` — the catalog's
   * static curation plus any provider-discovered tools that are
   * read-only with auto approval. Used by the agent layer to gate
   * which tools are invocable. Note: this list **grows** on Composio
   * hydration (a GitHub-style provider can add tens of read tools to
   * the catalog baseline of 2), so it is not the right anchor for the
   * advertised provider tool count — see `toolCount` for that.
   *
   * Optional in the type only to keep test fixtures terse — the daemon
   * always populates this from `connectorDefinitionToDetail` so wire
   * payloads are guaranteed to carry it.
   */
  allowedToolNames?: string[];
  /**
   * Hand-curated catalog subset. Stable across hydration: never
   * extended by provider discovery, only the static catalog names.
   * This preserves the static catalog baseline for consumers that
   * need that curated subset, but it does not represent the
   * advertised provider inventory. UI summary badges should use
   * `toolCount` when present, while the drawer's rendered tool rows
   * still come from `tools` directly.
   *
   * Optional in the type only for fixture brevity, see `allowedToolNames`.
   */
  curatedToolNames?: string[];
  toolCount?: number;
  toolsNextCursor?: string;
  toolsHasMore?: boolean;
  featuredToolNames?: string[];
  minimumApproval?: ConnectorToolApproval;
  lastError?: string;
  auth?: ConnectorAuthDetail;
}

/**
 * How a connector authenticates. `composio` goes through Composio's hosted OAuth; `native` is Mish's
 * own OAuth provider (tokens held encrypted by the daemon, never sent to the browser).
 */
export const CONNECTOR_AUTH_PROVIDERS = ['local', 'none', 'oauth', 'composio', 'native'] as const;
export type ConnectorAuthProvider = (typeof CONNECTOR_AUTH_PROVIDERS)[number];

export function isConnectorAuthProvider(value: unknown): value is ConnectorAuthProvider {
  return typeof value === 'string' && (CONNECTOR_AUTH_PROVIDERS as readonly string[]).includes(value);
}

export interface ConnectorAuthDetail {
  provider: ConnectorAuthProvider;
  configured: boolean;
}

export interface ConnectorListResponse {
  connectors: ConnectorDetail[];
}

export interface ConnectorStatusSummary {
  status: ConnectorStatus;
  accountLabel?: string;
  lastError?: string;
}

export interface ConnectorStatusResponse {
  statuses: Record<string, ConnectorStatusSummary>;
}

export interface ConnectorDiscoveryMeta {
  provider: 'composio';
  refreshRequested?: boolean;
}

export interface ConnectorDiscoveryResponse extends ConnectorListResponse {
  meta?: ConnectorDiscoveryMeta;
}

export interface ConnectorDetailResponse {
  connector: ConnectorDetail;
}

/**
 * Shape of an opener-created OAuth callback nonce. The connector OAuth
 * callback page renders with an opaque origin (it is reached by a cross-site
 * navigation), so its `postMessage` arrives with `event.origin === 'null'`.
 * The opener trusts such a message only when it echoes a nonce the opener
 * itself created for a pending flow.
 */
export const CONNECTOR_CALLBACK_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export interface ConnectorConnectRequest {
  accountLabel?: string;
  credentials?: Record<string, unknown>;
  /** See CONNECTOR_CALLBACK_NONCE_PATTERN. Ignored unless it matches. */
  callbackNonce?: string;
}

/** The message the connector OAuth callback page posts to its opener. */
export interface ConnectorCallbackMessage {
  type: 'mish:connector-connected';
  connectorId: string;
  connectorLabel: string;
  callbackNonce?: string;
}

export interface ConnectorConnectResponse extends ConnectorDetailResponse {
  auth?: {
    kind: 'redirect_required' | 'pending' | 'connected';
    redirectUrl?: string;
    providerConnectionId?: string;
    expiresAt?: string;
  };
}

export interface ConnectorAuthConfigPrepareRequest {
  connectorIds: string[];
}

export type ConnectorAuthConfigPrepareResult =
  | { status: 'ready'; authConfigId: string }
  | { status: 'custom_required'; message: string }
  | { status: 'error'; message: string };

export interface ConnectorAuthConfigPrepareResponse {
  results: Record<string, ConnectorAuthConfigPrepareResult>;
}

export interface ConnectorExecuteRequest {
  connectorId: string;
  toolName: string;
  input: BoundedJsonObject;
}

export interface ConnectorExecuteResponse {
  ok: true;
  connectorId: string;
  accountLabel?: string;
  toolName: string;
  safety: ConnectorToolSafety;
  output: BoundedJsonValue;
  outputSummary?: string;
  providerExecutionId?: string;
  metadata?: BoundedJsonObject;
}

/** The `state` a native OAuth flow sends out and expects back: 32 random bytes, base64url. */
export const NATIVE_OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const NATIVE_OAUTH_CODE_MAX_CHARS = 2048;

export type NativeOAuthCallbackQuery =
  | { ok: true; state: string; code: string }
  | { ok: false; reason: 'denied'; state: string }
  | { ok: false; reason: 'invalid' };

/**
 * Reads the redirect query of a native OAuth flow. Anything that is not exactly one well-formed
 * `state` plus one `code` (or a provider `error` for that state) is `invalid`.
 */
export function parseNativeOAuthCallbackQuery(query: Record<string, unknown>): NativeOAuthCallbackQuery {
  const { state, code, error } = query;
  if (typeof state !== 'string' || !NATIVE_OAUTH_STATE_PATTERN.test(state)) return { ok: false, reason: 'invalid' };
  if (typeof error === 'string' && error.length > 0) return { ok: false, reason: 'denied', state };
  if (typeof code !== 'string' || code.length === 0 || code.length > NATIVE_OAUTH_CODE_MAX_CHARS) return { ok: false, reason: 'invalid' };
  return { ok: true, state, code };
}
