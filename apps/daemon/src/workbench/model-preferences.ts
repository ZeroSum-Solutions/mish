import type { SessionExecutionChoice } from '@mish/contracts';
import type { AgentModelPrefs } from '../app-config.js';
import type { RuntimeAgentDef } from '../runtimes/types.js';
import { getRememberedLiveModels, isKnownModel, isKnownReasoningEffort, isKnownServiceTier, resolveDefaultModelFromOptions, resolveModelForAgent, resolveModelForServiceTier, sanitizeCustomModel } from '../runtimes/models.js';
import { AdmissionError } from './admission.js';

/** Resolve only absent preferences. The resulting values belong to this run. */
export function resolveAdmissionPreferences(def: RuntimeAgentDef, choice: SessionExecutionChoice, input: { reasoning?: unknown; serviceTier?: unknown }, defaults: AgentModelPrefs = {}, scope: string | null = null, env: NodeJS.ProcessEnv = process.env, requireConcreteDefault = true): { effectiveModel: string | null; reasoning: string | null; serviceTier: string | null } {
  if (choice.modelId !== 'default' && !isKnownModel(def, choice.modelId, scope) && !(def.supportsCustomModel !== false && sanitizeCustomModel(choice.modelId) === choice.modelId)) throw new AdmissionError('VALIDATION_FAILED', 'Requested model is not supported by this agent');
  const requestedReasoning = input.reasoning === undefined ? defaults.reasoning ?? null : input.reasoning;
  const requestedTier = input.serviceTier === undefined ? defaults.serviceTier ?? null : input.serviceTier;
  if ((requestedReasoning !== null && typeof requestedReasoning !== 'string') || (requestedTier !== null && typeof requestedTier !== 'string')) throw new AdmissionError('VALIDATION_FAILED', 'Reasoning and service tier must be supported strings or null');
  let effectiveModel = resolveModelForAgent(def, choice.modelId, env, scope);
  if (def.id === 'amr' && (!effectiveModel || effectiveModel === 'default')) {
    effectiveModel = resolveDefaultModelFromOptions(getRememberedLiveModels(def.id, scope));
    if (!effectiveModel && requireConcreteDefault) throw new AdmissionError('VALIDATION_FAILED', 'Load the scoped AMR model catalog before admitting a default-model turn');
    if (!effectiveModel) effectiveModel = 'default';
  }
  const envOverride = def.defaultModelEnvVar && typeof env[def.defaultModelEnvVar] === 'string' && Boolean(env[def.defaultModelEnvVar]?.trim());
  effectiveModel = resolveModelForServiceTier(def, effectiveModel, requestedTier, scope, choice.modelId === 'default' && !envOverride && def.fallbackModels.some(model => model.default && model.id === effectiveModel));
  const serviceTier = requestedTier === 'default' ? null : requestedTier;
  if (serviceTier !== null && !isKnownServiceTier(def, effectiveModel, serviceTier, scope)) throw new AdmissionError('VALIDATION_FAILED', 'Requested service tier is not supported by the effective model');
  const reasoning = requestedReasoning === 'default' ? null : requestedReasoning;
  if (reasoning !== null && !isKnownReasoningEffort(def, effectiveModel, reasoning, scope)) throw new AdmissionError('VALIDATION_FAILED', 'Requested reasoning is not supported by the effective model');
  return { effectiveModel, reasoning, serviceTier };
}
