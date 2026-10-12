import { switchApiProtocolConfig } from '../../components/SettingsDialog';
import type { AppConfig, ApiProtocol, ApiProtocolConfig } from '../../types';
import { findSessionByokCarrier, sessionChoiceFromConfig } from './session-model-config';

type PublicByokDraft = Pick<ApiProtocolConfig, 'baseUrl' | 'apiVersion' | 'model' | 'apiProviderBaseUrl'>;
/** Picker drafts are scope-local public identity, never a credential carrier. */
export interface ExecutionModelDrafts {
  nativeAgentId: string | null;
  byokProtocol: ApiProtocol | null;
  byokSlots: Partial<Record<ApiProtocol, PublicByokDraft>>;
}
export function emptyExecutionModelDrafts(): ExecutionModelDrafts {
  return { nativeAgentId: null, byokProtocol: null, byokSlots: {} };
}
export function rememberExecutionModelDraft(drafts: ExecutionModelDrafts, config: AppConfig): ExecutionModelDrafts {
  if (config.mode !== 'api' && config.agentId !== 'byok-opencode') {
    return config.agentId ? { ...drafts, nativeAgentId: config.agentId } : drafts;
  }
  const protocol = config.apiProtocol ?? 'anthropic';
  return { ...drafts, byokProtocol: protocol, byokSlots: { ...drafts.byokSlots, [protocol]: {
    baseUrl: config.baseUrl, apiVersion: config.apiVersion, model: config.model,
    apiProviderBaseUrl: config.apiProviderBaseUrl,
  } } };
}
export function configForExecutionProtocol(config: AppConfig, protocol: ApiProtocol, drafts: ExecutionModelDrafts, defaults: AppConfig): AppConfig {
  const next = switchApiProtocolConfig(config, protocol);
  const draft = drafts.byokSlots[protocol];
  if (!draft) return next;
  const fresh = switchApiProtocolConfig(defaults, protocol);
  const freshChoice = sessionChoiceFromConfig(fresh);
  // Use Settings' concrete model only for the carrier identity probe, so an
  // incomplete user model can retain its draft while adopting a repaired URL.
  const previousChoice = sessionChoiceFromConfig({ ...fresh, ...draft, model: fresh.model });
  const repaired = freshChoice && findSessionByokCarrier(defaults, freshChoice)
    && (!previousChoice || !findSessionByokCarrier(defaults, previousChoice));
  const endpoint = repaired ? { baseUrl: fresh.baseUrl, apiVersion: fresh.apiVersion,
    apiProviderBaseUrl: fresh.apiProviderBaseUrl } : draft;
  // A remembered endpoint must never inherit another slot's key. Valid choices
  // are projected through the existing Settings carrier lookup by both hooks.
  return { ...next, ...endpoint, model: draft.model, apiKey: '' };
}
export function configForExecutionMode(config: AppConfig, mode: AppConfig['mode'], drafts: ExecutionModelDrafts, defaults: AppConfig): AppConfig {
  if (mode === 'daemon') return { ...config, mode, agentId: drafts.nativeAgentId
    ?? (defaults.agentId !== 'byok-opencode' ? defaults.agentId : null) };
  return configForExecutionProtocol(config, drafts.byokProtocol ?? config.apiProtocol ?? 'anthropic', drafts, defaults);
}
