import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { registerVelaRoutes } from '../src/routes/vela.js';
import { getProductAgentDef, PRODUCT_AGENT_DEFS } from '../src/runtimes/registry.js';

describe('Mishh Mashh upstream cloud policy', () => {
  it('excludes upstream cloud from detection and run admission', () => {
    expect(PRODUCT_AGENT_DEFS.some((agent) => agent.id === 'amr')).toBe(false);
    expect(getProductAgentDef('amr')).toBeNull();
    expect(getProductAgentDef('codex')?.id).toBe('codex');
    expect(getProductAgentDef('byok-opencode')?.id).toBe('byok-opencode');
  });
  it('rejects cloud login and proxy endpoints without reading credentials or invoking a CLI', async () => {
    const readAppConfig = vi.fn();
    const app = express();
    registerVelaRoutes(app, { paths: { RUNTIME_DATA_DIR: '' }, appConfig: { readAppConfig }, http: {} });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    try {
      for (const [path, method] of [
        ['/api/integrations/vela/login', 'POST'],
        ['/api/integrations/vela/api-proxy/account', 'GET'],
        ['/api/integrations/vela/wallet', 'GET'],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: 'Upstream cloud is not available in Mishh Mashh.' });
      }
      for (const path of ['/api/integrations/vela/status', '/api/amr/models']) {
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ configured: false });
      }
      expect(readAppConfig).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
