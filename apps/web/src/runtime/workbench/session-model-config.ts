import {
  parseSessionModelChoice, parseSessionByokBinding, sessionByokBindingsEqual,
  type SessionModelChoice, type SessionByokBinding, type ByokChatProviderConfig,
} from '@open-design/contracts';
import { KNOWN_PROVIDERS } from '../../state/config';
import type { AppConfig, ApiProtocol, ApiProtocolConfig } from '../../types';
import { byokProviderRequiresApiKey } from '../../utils/byokProvider';

function bindingForSlot(protocol: ApiProtocol, slot: ApiProtocolConfig): SessionByokBinding | null {
  // Bedrock has only catalogue/connection-test support, no enabled chat route.
  if (protocol === 'bedrock') return null;
  const provider = KNOWN_PROVIDERS.find(p => p.protocol === protocol && p.baseUrl === slot.baseUrl
    && (slot.apiProviderBaseUrl == null || p.baseUrl === slot.apiProviderBaseUrl));
  return parseSessionByokBinding({ protocol, baseUrl: slot.baseUrl,
    requiresApiKey: byokProviderRequiresApiKey(protocol, provider, slot.baseUrl),
    ...(protocol === 'azure' ? { apiVersion: slot.apiVersion ?? '' } : {}) });
}

/** Public identity only; creation can retain a draft before Settings supplies a complete choice. */
export function sessionChoiceFromConfig(config: AppConfig): SessionModelChoice | null {
  try {
    if (config.mode === 'api' || config.agentId === 'byok-opencode') {
      const byokBinding = bindingForSlot(config.apiProtocol ?? 'anthropic', config);
      if (!byokBinding) return null;
      return parseSessionModelChoice({ agentId: 'byok-opencode', modelId: config.model, byokBinding });
    }
    if (!config.agentId) return null;
    return parseSessionModelChoice({ agentId: config.agentId,
      modelId: config.agentModels?.[config.agentId]?.model?.trim() || 'default' });
  } catch { return null; }
}

/** Guarded selection/send paths refuse incomplete config without exposing input. */
export function requireSessionChoiceFromConfig(config: AppConfig): SessionModelChoice {
  const choice = sessionChoiceFromConfig(config);
  if (choice) return choice;
  if (config.mode === 'api' || config.agentId === 'byok-opencode') {
    throw new Error(config.apiProtocol === 'bedrock'
      ? 'session-model-protocol-unsupported' : 'session-model-config-incomplete');
  }
  throw new Error(config.agentId ? 'session-model-config-incomplete' : 'session-model-agent-required');
}

/** Reuse complete existing credential slots only when the public execution identity matches. */
export function findSessionByokCarrier(config: AppConfig, choice: SessionModelChoice): ByokChatProviderConfig | undefined {
  if (!choice.byokBinding || choice.agentId !== 'byok-opencode') return undefined;
  const candidates: Array<{ protocol: ApiProtocol; slot: ApiProtocolConfig }> = [
    { protocol: config.apiProtocol ?? 'anthropic', slot: config },
    ...Object.entries(config.byokProviderConfigDrafts ?? {}).map(([key, value]) => ({
      protocol: key.slice(0, key.indexOf(':')) as ApiProtocol, slot: value.apiConfig,
    })),
    ...Object.entries(config.apiProtocolConfigs ?? {}).map(([protocol, slot]) => ({ protocol: protocol as ApiProtocol, slot })),
  ];
  for (const { protocol, slot } of candidates) {
    if (!slot.model?.trim() || slot.model.trim().toLowerCase() === 'default') continue;
    try {
      const binding = bindingForSlot(protocol, slot);
      if (!binding || !sessionByokBindingsEqual(binding, choice.byokBinding)) continue;
      if (binding.requiresApiKey && !slot.apiKey?.trim()) continue;
      return { ...binding, model: choice.modelId, apiKey: slot.apiKey?.trim() ?? '' };
    } catch { /* An incomplete or unsupported Settings draft is never a replacement. */ }
  }
  return undefined;
}

/** Local execution projection for existing preflight/pickers; Settings remain the default. */
export function configForSessionChoice(config: AppConfig, choice: SessionModelChoice, displayOnly = false): AppConfig {
  if (choice.agentId === 'byok-opencode') {
    const carrier = findSessionByokCarrier(config, choice);
    if (!carrier && !displayOnly) throw new Error('session-model-credentials-unavailable');
    if (!carrier) return { ...config, mode: displayOnly ? 'api' : 'daemon', agentId: choice.agentId, apiProtocol: choice.byokBinding!.protocol, baseUrl: choice.byokBinding!.baseUrl, apiVersion: choice.byokBinding!.apiVersion ?? '', model: choice.modelId, apiKey: '', apiProviderBaseUrl: null };
    return { ...config, mode: displayOnly ? 'api' : 'daemon', agentId: choice.agentId,
      apiProtocol: carrier.protocol, baseUrl: carrier.baseUrl ?? choice.byokBinding!.baseUrl, apiVersion: carrier.apiVersion ?? '',
      apiKey: carrier.apiKey ?? '', model: choice.modelId, apiProviderBaseUrl: null };
  }
  return { ...config, mode: 'daemon', agentId: choice.agentId, agentModels: {
    ...config.agentModels, [choice.agentId]: { ...config.agentModels?.[choice.agentId], model: choice.modelId },
  } };
}
