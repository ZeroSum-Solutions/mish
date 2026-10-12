import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/state/config';
import { sessionChoiceFromConfig, requireSessionChoiceFromConfig, configForSessionChoice, findSessionByokCarrier } from '../src/runtime/workbench/session-model-config';
import type { AppConfig } from '../src/types';
const native = { ...DEFAULT_CONFIG, agentId: 'codex', agentModels: { codex: { model: 'default', reasoning: 'high' } } } satisfies AppConfig;
const binding = { protocol: 'openai' as const, baseUrl: 'https://gateway.example/v1', requiresApiKey: true };
const slot = { apiKey: 'fixture-secret', baseUrl: binding.baseUrl, model: 'old-model', apiProviderBaseUrl: null };
const pinned = { agentId: 'byok-opencode', modelId: 'owner/next:tag', byokBinding: binding };
describe('session choice and existing credential carriers', () => {
  it('keeps native default and reasoning without changing settings', () => {
    expect(sessionChoiceFromConfig(native)).toEqual({ agentId: 'codex', modelId: 'default' });
    const projected = configForSessionChoice(native, { agentId: 'claude', modelId: 'opus' });
    expect(projected.agentId).toBe('claude');
    expect(projected.agentModels?.codex?.reasoning).toBe('high');
    expect(native.agentId).toBe('codex');
  });
  it('pins BYOK to the enabled daemon carrier and canonical public binding only', () => {
    const choice = sessionChoiceFromConfig({ ...native, mode: 'api', apiProtocol: 'openai', ...slot });
    expect(choice).toEqual({ agentId: 'byok-opencode', modelId: 'old-model', byokBinding: binding });
    expect(JSON.stringify(choice)).not.toContain(slot.apiKey);
  });
  it('resupplies a matching saved protocol slot and overrides its model', () => {
    const cfg = { ...native, apiProtocol: 'anthropic' as const, apiProtocolConfigs: { openai: slot } };
    expect(findSessionByokCarrier(cfg, pinned)?.model).toBe(pinned.modelId);
    const projected = configForSessionChoice(cfg, pinned);
    expect(projected.mode).toBe('daemon');
    expect(projected.agentId).toBe('byok-opencode');
    expect(projected.apiProtocol).toBe('openai');
    expect(projected.apiKey).toBe(slot.apiKey);
    expect(projected.model).toBe(pinned.modelId);
  });
  it('uses a complete Settings draft after skipping an incomplete active slot', () => {
    const cfg: AppConfig = { ...native, apiProtocol: 'openai', ...slot, apiKey: '', byokProviderConfigDrafts: { 'openai:custom:fixture': { apiConfig: slot } } };
    expect(findSessionByokCarrier(cfg, pinned)?.apiKey).toBe(slot.apiKey);
  });
  it.each([
    { baseUrl: 'https://other.example/v1' },
    { baseUrl: 'https://gateway.example/v2' },
    { apiKey: '' },
    { model: '' },
  ])('does not substitute a different or incomplete slot %j', patch => {
    const cfg = { ...native, apiProtocolConfigs: { openai: { ...slot, ...patch } } };
    expect(findSessionByokCarrier(cfg, pinned)).toBeUndefined();
    expect(() => configForSessionChoice(cfg, pinned)).toThrow('session-model-credentials-unavailable');
  });
  it('compares Azure API versions and protocol identity', () => {
    const cfg = { ...native, apiProtocolConfigs: { azure: { ...slot, baseUrl: 'https://azure.example', apiVersion: '2024-10-21' } } };
    expect(findSessionByokCarrier(cfg, { ...pinned, byokBinding: { ...binding, protocol: 'azure', baseUrl: 'https://azure.example', apiVersion: 'other' } })).toBeUndefined();
    expect(findSessionByokCarrier(cfg, pinned)).toBeUndefined();
  });
  it('canonicalizes URLs and effective local Ollama key policy', () => {
    const cfg = { ...native, apiProtocolConfigs: { ollama: { ...slot, apiKey: '', baseUrl: 'http://LOCALHOST:11434/api/' } } };
    expect(findSessionByokCarrier(cfg, { ...pinned, byokBinding: { protocol: 'ollama', baseUrl: 'http://localhost:11434/v1', requiresApiKey: false } })?.apiKey).toBe('');
  });
  it.each([
    { mode: 'api' as const, apiProtocol: 'bedrock' as const, ...slot },
    { mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, model: '' },
    { mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, model: 'default' },
    { mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, baseUrl: 'https://gateway.example/v1?secret=fixture-secret' },
    { mode: 'api' as const, apiProtocol: 'azure' as const, ...slot, baseUrl: '' },
    { mode: 'daemon' as const, agentId: '' },
    { mode: 'daemon' as const, agentId: null },
  ])('lets creation project an unconfigured or unrepresentable choice as null: %j', patch => {
    const cfg = { ...native, ...patch };
    const before = JSON.stringify(cfg);
    expect(sessionChoiceFromConfig(cfg)).toBeNull();
    expect(JSON.stringify(cfg)).toBe(before);
  });
  it.each(['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'] as const)(
    'preserves complete existing %s choices and their executable credential carrier', protocol => {
      const cfg = { ...native, mode: 'api' as const, apiProtocol: protocol, ...slot };
      const choice = sessionChoiceFromConfig(cfg);
      expect(choice).not.toBeNull();
      expect(choice?.byokBinding?.protocol).toBe(protocol);
      expect(requireSessionChoiceFromConfig(cfg)).toEqual(choice);
      const projected = configForSessionChoice(cfg, choice!);
      expect(projected.apiProtocol).toBe(protocol);
      expect(projected.model).toBe(slot.model);
      expect(projected.apiKey).toBe(slot.apiKey);
    },
  );
  it('keeps a valid public choice when credentials still need Settings repair', () => {
    const cfg = { ...native, mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, apiKey: '' };
    const choice = requireSessionChoiceFromConfig(cfg);
    expect(choice.modelId).toBe(slot.model);
    expect(() => configForSessionChoice(cfg, choice)).toThrow('session-model-credentials-unavailable');
    expect(configForSessionChoice({ ...cfg, apiKey: slot.apiKey }, choice).model).toBe(slot.model);
  });
  it('skips a retired Bedrock active slot while resupplying a supported saved slot', () => {
    const cfg = { ...native, mode: 'api' as const, apiProtocol: 'bedrock' as const, ...slot, apiProtocolConfigs: { openai: slot } };
    expect(sessionChoiceFromConfig(cfg)).toBeNull();
    expect(configForSessionChoice(cfg, pinned).apiProtocol).toBe('openai');
  });
  it('keeps unconfigured selection recoverable without choosing a different model', () => {
    const cfg = { ...native, mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, model: '' };
    expect(sessionChoiceFromConfig(cfg)).toBeNull();
    expect(() => requireSessionChoiceFromConfig(cfg)).toThrow('session-model-config-incomplete');
    const repaired = { ...cfg, model: 'owner/selected:tag' };
    expect(requireSessionChoiceFromConfig(repaired).modelId).toBe('owner/selected:tag');
    expect(cfg.model).toBe('');
  });
  it('refuses unsupported Bedrock pinning explicitly without leaking a credential in errors', () => {
    expect(() => requireSessionChoiceFromConfig({ ...native, mode: 'api', apiProtocol: 'bedrock', ...slot })).toThrow('session-model-protocol-unsupported');
    expect(() => requireSessionChoiceFromConfig({ ...native, agentId: '' })).toThrow('session-model-agent-required');
    const cfg = { ...native, mode: 'api' as const, apiProtocol: 'openai' as const, ...slot, baseUrl: 'https://gateway.example/v1?secret=fixture-secret' };
    try { requireSessionChoiceFromConfig(cfg); throw new Error('expected refusal'); }
    catch (error) {
      expect((error as Error).message).toBe('session-model-config-incomplete');
      expect((error as Error).message).not.toContain(slot.apiKey);
    }
  });
});
