import type Database from 'better-sqlite3';
import { parseSessionExecutionChoice, type SessionRunAdmission } from '@open-design/contracts';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { resolveAmrProfile } from '../integrations/vela.js';
import { fetchVelaPresetModels, fetchVelaRemoteModelsWithRetry } from '../runtimes/defs/amr.js';
import type { RuntimeAgentDef } from '../runtimes/types.js';
import { AdmissionError, matchedTransientCarrier, publicExecutionChoice, readConversationCursor, resolveAdmissionChoice, type PreparedAdmission } from './admission.js';
import { getProject } from '../db.js';
import { resolveProjectDir } from '../projects.js';
import { getRememberedLiveModels, rememberLiveModels } from '../runtimes/models.js';
import { amrModelLoadingCache } from '../runtimes/amr-model-cache.js';
import { resolveAmrModelProbe } from '../runtimes/amr-model-probe.js';
import { buildOpenCodeByokProviderConfig, BYOK_OPENCODE_PROVIDER_ID } from '../runtimes/byok-opencode.js';
import { authorizeContinuationSource, prepareAuthorizedReplay, readAdmittedPublicInput, type AdmittedPublicInput, type ReplaySourceRun } from './replay.js';
import { readSessionModel } from './session-model.js';
import { resolveAdmissionPreferences } from './model-preferences.js';

/** External work runs before the immediate claim. No credentials enter the prepared facts. */
export async function prepareModelAdmission(input: {
  db: Database.Database; body: Record<string, unknown>; dataDir: string;
  fallbackAgentId: string | null; getAgentDef(agentId: string): RuntimeAgentDef | null | undefined;
  resolveDefaultAgent?: (config: Awaited<ReturnType<typeof readAppConfig>>) => Promise<string | null>;
  locked?: SessionRunAdmission | null;
  /** Host stage completion owns this source before publishing its terminal event. */
  trustedAutomaticSource?: { runId: string; input: AdmittedPublicInput };
  sameRunId?: string | null; projectsRoot?: string; getRun?: (id: string) => ReplaySourceRun | null;
}) {
  const { db, body } = input;
  const projectId = typeof body.projectId === 'string' ? body.projectId : null;
  const sessionId = typeof body.conversationId === 'string' ? body.conversationId : null;
  const selection = projectId && sessionId ? readSessionModel(db, projectId, sessionId) : null;
  const cursor = sessionId ? readConversationCursor(db, sessionId) : null;
  const source = input.trustedAutomaticSource ?? (!input.sameRunId && projectId && sessionId ? authorizeContinuationSource(db, projectId, sessionId, body.continueFromRunId, input.sameRunId ? null : input.locked?.runId, input.getRun) : null);
  if (!sessionId && body.continueFromRunId !== undefined) throw new AdmissionError('VALIDATION_FAILED', 'Continuation source requires a project conversation');
  const config = await readAppConfig(input.dataDir);
  const implicit = !body.agentId && !body.model;
  const agentId = input.locked?.requested.agentId ?? (implicit ? selection?.choice?.agentId : null) ?? (typeof body.agentId === 'string' && body.agentId ? body.agentId : input.fallbackAgentId) ?? (input.resolveDefaultAgent ? await input.resolveDefaultAgent(config) : config.agentId);
  if (!agentId) throw new AdmissionError('VALIDATION_FAILED', 'Choose an available agent before starting a turn');
  const def = input.getAgentDef(agentId);
  if (!def) throw new AdmissionError('VALIDATION_FAILED', 'Agent is not supported');
  const defaults = config.agentModels?.[agentId] ?? {};
  const modelId = typeof body.model === 'string' && body.model ? body.model : defaults.model ?? 'default';
  let fallback: ReturnType<typeof parseSessionExecutionChoice>;
  try { fallback = input.locked?.requested ?? (implicit && selection?.choice ? selection.choice : body.byokBinding !== undefined ? parseSessionExecutionChoice({ agentId, modelId, byokBinding: body.byokBinding }) : publicExecutionChoice(agentId, modelId, body.byokProvider)); }
  catch (error) { if (error instanceof AdmissionError) throw error; throw new AdmissionError('VALIDATION_FAILED', 'Pass a supported complete public model choice'); }
  const resolved = resolveAdmissionChoice(db, body, fallback, input.locked?.requested, selection);
  const carrier = matchedTransientCarrier(resolved.choice, body.byokProvider);
  const configuredEnv = agentCliEnvForAgent(config.agentCliEnv, agentId);
  const scope = agentId === 'amr' ? resolveAmrProfile({ ...process.env, ...(def.env ?? {}), ...configuredEnv }) : null;
  if (!input.locked && agentId === 'amr') {
    // Profile-only remembrance is not account/plan authority. Always consult
    // the current credential-keyed cache, including after its invalidation.
    // Admission and the picker must resolve the same scoped remote/preset list.
    // A direct live probe loses valid preset choices during gateway outages.
    try {
      const probe = await resolveAmrModelProbe({ dataDir: input.dataDir, env: process.env, readAppConfig: async () => config });
      const catalog = await amrModelLoadingCache.get(probe.cacheKey, {
        fetchPreset: () => fetchVelaPresetModels(probe.launchPath, probe.env),
        fetchRemote: () => fetchVelaRemoteModelsWithRetry(probe.launchPath, probe.env),
      });
      // Replace even with an empty list: an earlier account must not survive
      // an empty/all-disabled catalog under the current key.
      rememberLiveModels(agentId, catalog.models.filter(model => model.enabled !== false), scope);
    } catch {
      rememberLiveModels(agentId, [], scope);
      console.warn('[session-model] AMR catalog unavailable; refusing stale remembered choices');
    }
    if (getRememberedLiveModels(agentId, scope).length === 0) throw new AdmissionError('VALIDATION_FAILED', 'Load the scoped AMR model catalog before admitting a turn');
  }
  const prefs = input.locked ? { effectiveModel: input.locked.effectiveModel, reasoning: input.locked.reasoning, serviceTier: input.locked.serviceTier } : resolveAdmissionPreferences(def, resolved.choice, body, defaults, scope, process.env, Boolean(projectId && sessionId));
  const prepared: PreparedAdmission | null = projectId && sessionId && cursor && resolved.selection ? {
    projectId, sessionId, cursor, selection: resolved.selection, checkSelection: resolved.checkSelection,
    ...(carrier ? { transientCarrier: carrier } : {}),
    facts: { requested: resolved.choice, ...prefs, selectionSource: resolved.source, selectionRevision: resolved.source === 'session' ? resolved.selection.revision : input.locked?.selectionRevision ?? null, sourceRunId: source?.runId ?? null, replayNotice: null, routeBudget: null },
  } : null;
  let replayInput: { message: string; priorTranscript: string; currentPrompt: string } | null = null;
  if (prepared) {
    const prior = input.sameRunId ? readAdmittedPublicInput(db, input.sameRunId) : null;
    if (prior) replayInput = { currentPrompt: prior.prompt, message: prior.replay ? `${prior.replay}\n\n## user\n${prior.prompt}` : prior.prompt, priorTranscript: prior.replay ?? '' };
    else {
      const project = getProject(db, projectId!);
      const projectRoot = input.projectsRoot ? resolveProjectDir(input.projectsRoot, projectId!, project?.metadata) : null;
      const model = [...getRememberedLiveModels(agentId, scope), ...def.fallbackModels].find(model => model.id === prefs.effectiveModel);
      const byok = carrier ? buildOpenCodeByokProviderConfig(carrier, resolved.choice.modelId) : null;
      const providerConfig = byok?.config as { provider?: Record<string, { models?: Record<string, { limit?: { context: number; output: number } }> }> } | undefined;
      const limit = providerConfig?.provider?.[BYOK_OPENCODE_PROVIDER_ID]?.models?.[resolved.choice.modelId]?.limit;
      replayInput = prepareAuthorizedReplay({ db, prepared, body, projectRoot, projectMetadata: project?.metadata, source, contextWindowTokens: limit?.context ?? model?.metadata?.contextWindowTokens ?? null, outputReserveTokens: limit?.output ?? null });
    }
  }
  return { prepared, choice: resolved.choice, carrier, replayInput, ...prefs };
}
