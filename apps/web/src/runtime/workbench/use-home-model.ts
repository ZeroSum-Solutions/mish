import { useRef, useState } from 'react';
import { parseSessionModelChoice, type SessionModelChoice, type WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';
import type { AppConfig, ApiProtocol, AgentModelChoice } from '../../types';
import { configForSessionChoice, requireSessionChoiceFromConfig, sessionChoiceFromConfig } from './session-model-config';
import { configForExecutionMode, configForExecutionProtocol, emptyExecutionModelDrafts, rememberExecutionModelDraft } from './execution-model-drafts';
/** Home has no Conversation yet. Keep the public pick until create returns its actual identity. */
export function useHomeModel(defaults: AppConfig, context: WorkspaceCollabContext | null) {
  const key = `od:home-model-choice:${workspaceAccountScopedCacheKey(context)}`;
  const draftsRef = useRef({ key, value: emptyExecutionModelDrafts() });
  if (draftsRef.current.key !== key) draftsRef.current = { key, value: emptyExecutionModelDrafts() };
  const [draft, setDraft] = useState<{ key: string; choice: SessionModelChoice; preferences: AppConfig['agentModels'] } | null>(() => {
    try { const value = window.sessionStorage.getItem(key); return value ? { key, choice: parseSessionModelChoice(JSON.parse(value)), preferences: defaults.agentModels } : null; } catch { return null; }
  });
  const [invalid, setInvalid] = useState<{ key: string; config: AppConfig } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const config = invalid?.key === key ? invalid.config : draft?.key === key
    ? configForSessionChoice({ ...defaults, agentModels: { ...defaults.agentModels, ...draft.preferences } }, draft.choice, true) : defaults;
  function update(next: AppConfig) {
    if (draftsRef.current.key !== key || key !== `od:home-model-choice:${workspaceAccountScopedCacheKey(context)}`) return;
    draftsRef.current.value = rememberExecutionModelDraft(rememberExecutionModelDraft(draftsRef.current.value, config), next);
    try {
      const choice = requireSessionChoiceFromConfig(next);
      setDraft({ key, choice, preferences: next.agentModels }); setInvalid(null); setError(null);
      try { window.sessionStorage.setItem(key, JSON.stringify(choice)); } catch { /* Public choice only; no new credential store. */ }
    } catch (error) { setInvalid({ key, config: next }); setError(error); }
  }
  return { config, error,
    choice: () => sessionChoiceFromConfig(config),
    onModeChange: (mode: AppConfig['mode']) => update(configForExecutionMode(config, mode, rememberExecutionModelDraft(draftsRef.current.value, config), defaults)),
    onAgentChange: (agentId: string) => update({ ...config, mode: 'daemon', agentId }),
    onAgentModelChange: (agentId: string, choice: AgentModelChoice) => update({ ...config, mode: 'daemon', agentId, agentModels: { ...config.agentModels, [agentId]: { ...config.agentModels?.[agentId], ...choice } } }),
    onApiProtocolChange: (protocol: ApiProtocol) => update(configForExecutionProtocol(config, protocol, rememberExecutionModelDraft(draftsRef.current.value, config), defaults)),
    onApiModelChange: (model: string) => update({ ...config, model }),
  };
}
