import type { Express, RequestHandler } from 'express';
import type { StagedDraftingResponse } from '@mish/contracts';

import { stagedDraftingStatus, type StagedAgentAvailability } from '../staged-routing.js';

/**
 * Report whether staged drafting is on and which fast model it would use.
 *
 * The switch itself lives in app config (`stagedDrafting`), which
 * `PUT /api/app-config` already owns; this route is the read side that adds
 * what the saved value cannot say — whether a fast model is reachable now.
 */
export function registerStagedDraftingRoutes(app: Express, deps: {
  requireLocalDaemonRequest: RequestHandler;
  readStagedPreference: () => Promise<{ enabled: boolean; mainAgentId: string | null; mainModel: string | null }>;
  detectAgentAvailability: () => Promise<StagedAgentAvailability[]>;
}): void {
  app.get('/api/agents/staged', deps.requireLocalDaemonRequest, async (_req, res) => {
    const [preference, agents] = await Promise.all([
      deps.readStagedPreference(),
      deps.detectAgentAvailability().catch((): StagedAgentAvailability[] => []),
    ]);
    const body: StagedDraftingResponse = {
      status: stagedDraftingStatus({
        enabled: preference.enabled,
        main: { agentId: preference.mainAgentId ?? '', model: preference.mainModel ?? 'default' },
        agents,
      }),
    };
    res.json(body);
  });
}
