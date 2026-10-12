import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { registerStagedDraftingRoutes } from '../../src/routes/staged-drafting.js';

describe('GET /api/agents/staged', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  const get = async (enabled: boolean, agents: Array<{ id: string; available: boolean }>) => {
    const app = express();
    registerStagedDraftingRoutes(app, {
      requireLocalDaemonRequest: (_req, _res, next) => next(),
      readStagedPreference: async () => ({ enabled, mainAgentId: 'claude', mainModel: 'claude-opus-5-5' }),
      detectAgentAvailability: async () => agents,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return (await fetch(`http://127.0.0.1:${address.port}/api/agents/staged`)).json();
  };

  it('reports on with the Haiku draft stage', async () => {
    expect(await get(true, [{ id: 'claude', available: true }])).toEqual({
      status: {
        enabled: true,
        draft: { agentId: 'claude', model: 'claude-haiku-5-5', source: 'claude' },
        unavailableReason: null,
      },
    });
  });

  it('reports off and unavailable when no fast model is reachable', async () => {
    expect(await get(false, [])).toEqual({
      status: { enabled: false, draft: null, unavailableReason: 'draft_unavailable' },
    });
  });
});
