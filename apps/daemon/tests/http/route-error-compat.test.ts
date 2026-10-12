import express from 'express';
import { ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError } from '@mish/agency-fast-lane/deepseek';
import type { Server } from 'node:http';
import os from 'node:os';
import { renderKieImage } from '../../src/media/kie.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMediaRoutes, type RegisterMediaRoutesDeps } from '../../src/routes/media.js';
import { registerDaemonRoutes } from '../../src/routes/daemon.js';
import { sendApiError } from '../../src/http/api-errors.js';

const terminalLaunch = vi.hoisted(() => vi.fn());
vi.mock('../../src/runtimes/terminal-launch.js', () => ({ launchAgentInSystemTerminal: terminalLaunch }));
let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function serve(failure: Error): Promise<string> {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  terminalLaunch.mockRejectedValue(new Error('failed at /private/tools/agy'));
  const app = express();
  app.use(express.json());
  const pass: express.RequestHandler = (_req, _res, next) => next();
  registerDaemonRoutes(app, {
    db: {}, paths: { PROJECT_ROOT: os.tmpdir(), RESOURCE_ROOT: os.tmpdir(), RUNTIME_DATA_DIR: os.tmpdir() },
    http: { sendApiError, requireLocalDaemonRequest: pass }, host: '127.0.0.1', getResolvedPort: () => 0,
    getDaemonShuttingDown: () => false, sandboxRuntime: { enabled: false }, env: { OD_METRICS_ENDPOINT: 'disabled' },
  });
  registerMediaRoutes(app, {
    db: {}, design: {}, http: { sendApiError, requireLocalDaemonRequest: pass, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } },
    paths: { PROJECT_ROOT: os.tmpdir(), PROJECTS_DIR: os.tmpdir(), RUNTIME_DATA_DIR: os.tmpdir() },
    ids: {}, auth: {}, media: { readMaskedConfig: async () => { throw failure; } }, appConfig: {}, orbit: {},
    nativeDialogs: { openBrowser: () => { throw failure; } }, projectStore: {}, projectFiles: {}, conversations: {}, research: {},
  } as unknown as RegisterMediaRoutesDeps);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return `http://127.0.0.1:${address.port}`;
}
describe('route error compatibility', () => {
  it.each([
    [new ProviderKeyError('deepseek', new Error('private key at /private/customer')), 'PROVIDER_CREDENTIAL_MISSING', 'provider deepseek has no configured API key'],
    [new ProviderKeyUnreadableError('cerebras', new Error('private key at /private/customer')), 'PROVIDER_CREDENTIAL_UNREADABLE', 'provider cerebras credential could not be read'],
    [new ProviderHttpError('/private/customer', 403, 'secret'), 'PROVIDER_AUTH_REJECTED', 'the model provider rejected key'],
  ])('keeps safe typed provider reason %s without its cause/detail', async (failure, code, message) => {
    const base = await serve(failure);
    const response = await fetch(`${base}/api/media/config`);
    expect(await response.json()).toEqual({ error: { code, message } });
  });
  it('keeps the actual KIE adapter credential-validation reason', async () => {
    const failure = await renderKieImage({ wireModel: 'kie/nano-banana-2', prompt: 'test', imageRefs: [] }, { apiKey: 'invalid key' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const base = await serve(failure as Error);
    const response = await fetch(`${base}/api/media/config`);
    expect(await response.json()).toEqual({ error: { code: 'PROVIDER_CREDENTIAL_INVALID', message: 'invalid KIE API key' } });
  });
  it.each(['/api/agents/antigravity/oauth-launch', '/api/system/open-external'])('keeps ok:false on %s', async (route) => {
    const base = await serve(new Error('private failure at /private/customer'));
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
  });
  it('keeps safe provider rejection reasons as typed errors', async () => {
    const base = await serve(new ProviderHttpError('openai', 401, 'rejected at /private/customer with sk-secret'));
    const response = await fetch(`${base}/api/media/config`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'PROVIDER_AUTH_REJECTED', message: 'provider openai rejected key' } });
  });
  it('keeps returned terminal failures safe and retains platform and ok:false', async () => {
    const base = await serve(new Error('unused'));
    terminalLaunch.mockResolvedValue({ ok: false, platform: 'darwin', reason: 'osascript failed at /private/tools' });
    const response = await fetch(`${base}/api/agents/antigravity/oauth-launch`, { method: 'POST' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, platform: 'darwin', error: { code: 'AGENT_EXECUTION_FAILED', message: 'could not open a system terminal' } });
  });
  it.each(['provider /private/customer rejected key', 'provider openai rejected key\n at /private/customer', 'provider openai rejected key: sk-secret'])('redacts unrecognised provider detail (%s)', async (message) => {
    const base = await serve(new Error(message));
    const response = await fetch(`${base}/api/media/config`);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
  });
});
