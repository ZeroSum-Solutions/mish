/**
 * A creator's own login, as a `fetch` the link-page engine can use. The login is a Composio
 * connected account held by the daemon's existing Composio provider; the engine sees only a
 * function, and the request carries an account id, never a token.
 */
import type { LinkPageConnectedAccounts, LinkPageLoginConnectorId } from '@mish/contracts';
import { LINKPAGE_LOGIN_CONNECTORS } from '@mish/contracts';
import type { ConnectorCatalogDefinition } from '../connectors/catalog.js';

/** The part of the Composio provider this needs. */
export interface LinkPageLoginProvider {
  getDefinition(connectorId: string, signal?: AbortSignal): Promise<ConnectorCatalogDefinition | undefined>;
  proxyRequest(
    definition: ConnectorCatalogDefinition,
    providerConnectionId: string,
    request: { endpoint: string; method: string; headers?: Record<string, string>; body?: unknown },
    signal?: AbortSignal,
  ): Promise<{ status: number; data: unknown }>;
}

const ALLOWED_HOSTS = new Set(['graph.instagram.com', 'open.tiktokapis.com']);

export type LoginFetch = typeof fetch;

/** One login fetch per connector that has a connected account; others read as a visitor. */
export function createLoginFetches(
  provider: LinkPageLoginProvider | undefined,
  accounts: LinkPageConnectedAccounts,
  warnings: string[],
): Partial<Record<LinkPageLoginConnectorId, LoginFetch>> {
  const out: Partial<Record<LinkPageLoginConnectorId, LoginFetch>> = {};
  for (const connector of LINKPAGE_LOGIN_CONNECTORS) {
    const accountId = accounts[connector];
    if (!accountId) continue;
    if (!provider) {
      warnings.push(`${connector}: no login is available on this machine, read as a visitor`);
      continue;
    }
    out[connector] = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      // The engine only ever calls each platform's official API; refuse anything else.
      if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw new Error(`login requests may not go to ${url.hostname}`);
      const definition = await provider.getDefinition(connector);
      if (!definition) throw new Error(`the ${connector} connector is not available`);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
      let body: unknown;
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      const result = await provider.proxyRequest(definition, accountId, { endpoint: url.href, method: init.method ?? 'GET', headers, body });
      return new Response(JSON.stringify(result.data ?? null), { status: result.status, headers: { 'content-type': 'application/json' } });
    }) as LoginFetch;
  }
  return out;
}
