// ComposioConnectorProvider.proxyRequest: the one new Composio call the link-page builder uses. A
// stubbed fetch stands in for Composio; nothing leaves the machine.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorCatalogDefinition } from '../src/connectors/catalog.js';
import { composioConnectorProvider } from '../src/connectors/composio.js';
import { configureComposioConfigStore, writeComposioConfig } from '../src/connectors/composio-config.js';

let dir: string;
const calls: Array<{ method: string; path: string; body: any }> = [];

const definition = (id: string, slug: string): ConnectorCatalogDefinition => ({
  id, name: id, provider: 'composio', providerConnectorId: slug, category: 'social', authentication: 'composio', tools: [], allowedToolNames: [],
} as ConnectorCatalogDefinition);

function stubComposio(account: Record<string, unknown>, proxy: Record<string, unknown> = { status: 200, data: { ok: true } }) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: String(init?.method), path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    return url.pathname.endsWith('/tools/execute/proxy') ? json(proxy) : json(account);
  }));
}

beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'od-linkpage-composio-'));
  configureComposioConfigStore(dir);
  composioConnectorProvider.clearDiscoveryCache();
  writeComposioConfig({ apiKey: 'test_key_1234', authConfigIds: { instagram: 'ac_ig' } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('proxyRequest', () => {
  it('checks the account, then sends the request as that account', async () => {
    stubComposio({ id: 'ca_1', user_id: 'mish-local-user', auth_config: { id: 'ac_ig' }, toolkit: { slug: 'instagram' } });
    const result = await composioConnectorProvider.proxyRequest(
      definition('instagram', 'instagram'), 'ca_1',
      { endpoint: 'https://graph.instagram.com/me', method: 'get', headers: { accept: 'application/json' } },
    );
    expect(result).toEqual({ status: 200, data: { ok: true } });
    const sent = calls.filter((c) => !c.path.endsWith('/auth_configs'));
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v3/connected_accounts/ca_1', 'POST /api/v3/tools/execute/proxy']);
    expect(sent[1]!.body).toEqual({
      endpoint: 'https://graph.instagram.com/me', method: 'GET', connected_account_id: 'ca_1',
      parameters: [{ name: 'accept', value: 'application/json', type: 'header' }],
    });
  });

  it('refuses an account that belongs to another toolkit, without sending the request', async () => {
    stubComposio({ id: 'ca_1', user_id: 'mish-local-user', auth_config: { id: 'ac_ig' }, toolkit: { slug: 'github' } });
    await expect(composioConnectorProvider.proxyRequest(
      definition('instagram', 'instagram'), 'ca_1', { endpoint: 'https://graph.instagram.com/me', method: 'GET' },
    )).rejects.toThrow(/different toolkit/);
    expect(calls.some((c) => c.path.endsWith('/proxy'))).toBe(false);
  });

  it('refuses an account whose owner cannot be confirmed, or is someone else, without sending the request', async () => {
    for (const account of [
      { id: 'ca_1', auth_config: { id: 'ac_ig' }, toolkit: { slug: 'instagram' } },
      { id: 'ca_1', user_id: 'someone-else', auth_config: { id: 'ac_ig' }, toolkit: { slug: 'instagram' } },
    ]) {
      calls.length = 0;
      stubComposio(account);
      await expect(composioConnectorProvider.proxyRequest(
        definition('instagram', 'instagram'), 'ca_1', { endpoint: 'https://graph.instagram.com/me', method: 'GET' },
      )).rejects.toThrow(/user/);
      expect(calls.some((c) => c.path.endsWith('/proxy'))).toBe(false);
    }
  });
});
