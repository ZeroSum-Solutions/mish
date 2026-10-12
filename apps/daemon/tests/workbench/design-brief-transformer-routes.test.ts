import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { BriefTransformerLane } from '@mish/contracts';
import { registerWorkbenchBriefRoutes } from '../../src/routes/workbench-brief.js';
import { runBriefCli } from '../../src/workbench/brief/cli.js';
import { createDesignBriefService } from '../../src/workbench/brief/service.js';
import { fakeGenerator, tempDir } from './design-brief-fixture.js';

let server: Server | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(cleanups.splice(0).map(fn => fn()));
});

/** The brief routes plus a stand-in for PUT /api/app-config holding one lane. */
async function boot() {
  const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
  let lane: BriefTransformerLane = 'claude';
  const writes: unknown[] = [];
  const app = express(); app.use(express.json());
  app.put('/api/app-config', (req, res) => { writes.push(req.body); lane = req.body.improvePromptTransformer; res.json({ config: {} }); });
  registerWorkbenchBriefRoutes(app, {
    http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) },
    authorizeProjectRequest: async () => true,
    briefs: createDesignBriefService({ dataDir: dir, generator: fakeGenerator([]) }),
    transformerStatus: async () => ({ lane, terraModel: 'openai/gpt-5.6-terra', terraKeyAvailable: true, fallbackModel: 'claude-sonnet-5-5' }),
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, writes };
}
async function cli(base: string, args: string[]) {
  const values: unknown[] = [];
  const code = await runBriefCli(args, { baseUrl: base, env: {}, readStdin: async () => '', write: value => values.push(value) });
  return { code, value: values[0] as Record<string, any> };
}

describe('Improve prompt transformer: one endpoint for the Labs row and the CLI', () => {
  it('reads the status over HTTP', async () => {
    const { base } = await boot();
    const body = await (await fetch(`${base}/api/workbench/briefs/transformer`)).json() as { status: unknown };
    expect(body.status).toMatchObject({ lane: 'claude', terraModel: 'openai/gpt-5.6-terra', fallbackModel: 'claude-sonnet-5-5' });
  });

  it('od workbench brief transformer reads, and --set writes the same app-config field', async () => {
    const { base, writes } = await boot();
    expect(await cli(base, ['brief', 'transformer', '--json'])).toMatchObject({ code: 0, value: { status: { lane: 'claude' } } });
    expect(await cli(base, ['brief', 'transformer', '--set', 'terra', '--json'])).toMatchObject({ code: 0, value: { status: { lane: 'terra' } } });
    expect(writes).toEqual([{ improvePromptTransformer: 'terra' }]);
  });

  it('rejects an unknown lane before calling the daemon', async () => {
    const { base, writes } = await boot();
    expect((await cli(base, ['brief', 'transformer', '--set', 'gpt', '--json'])).code).toBe(2);
    expect(writes).toEqual([]);
  });
});
