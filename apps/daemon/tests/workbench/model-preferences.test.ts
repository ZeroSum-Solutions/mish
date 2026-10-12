import { expect, it } from 'vitest';
import { resolveAdmissionPreferences } from '../../src/workbench/model-preferences.js';
import { rememberLiveModels } from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';
const def = { id: 'test', name: 'Test', bin: 'test', versionArgs: [], buildArgs: () => [], streamFormat: 'text', supportsCustomModel: true, fallbackModels: [
  { id: 'base', label: 'Base', default: true, reasoningOptions: [{ id: 'high', label: 'High' }] },
  { id: 'fast', label: 'Fast', serviceTierOptions: [{ id: 'priority', label: 'Priority' }], reasoningOptions: [{ id: 'high', label: 'High' }] },
] } satisfies RuntimeAgentDef;
it('resolves missing defaults after tier selection but preserves explicit null preferences', () => {
  expect(resolveAdmissionPreferences(def, { agentId: 'test', modelId: 'default' }, {}, { reasoning: 'high', serviceTier: 'priority' }, null, {})).toEqual({ effectiveModel: 'fast', reasoning: 'high', serviceTier: 'priority' });
  expect(resolveAdmissionPreferences(def, { agentId: 'test', modelId: 'default' }, { reasoning: null, serviceTier: null }, { reasoning: 'high', serviceTier: 'priority' }, null, {})).toEqual({ effectiveModel: 'base', reasoning: null, serviceTier: null });
});
it('rejects unsupported explicit preferences without silently changing an explicit model', () => {
  expect(() => resolveAdmissionPreferences(def, { agentId: 'test', modelId: 'base' }, { serviceTier: 'priority' }, {}, null, {})).toThrow('service tier');
  expect(() => resolveAdmissionPreferences(def, { agentId: 'test', modelId: 'fast' }, { reasoning: 'unknown' }, {}, null, {})).toThrow('reasoning');
});

it('requires a concrete scoped AMR default before immutable admission', () => {
  const amr = { ...def, id: 'amr', fallbackModels: [], supportsCustomModel: false };
  rememberLiveModels('amr', [], 'admission-test');
  expect(() => resolveAdmissionPreferences(amr, { agentId: 'amr', modelId: 'default' }, {}, {}, 'admission-test', {})).toThrow('scoped AMR');
  rememberLiveModels('amr', [{ id: 'concrete', label: 'Concrete', default: true }], 'admission-test');
  expect(resolveAdmissionPreferences(amr, { agentId: 'amr', modelId: 'default' }, {}, {}, 'admission-test', {}).effectiveModel).toBe('concrete');
  rememberLiveModels('amr', [], 'admission-test');
});

it('normalizes the existing default reasoning sentinel from caller or Settings', () => {
  const choice = { agentId: 'test', modelId: 'default' };
  expect(resolveAdmissionPreferences(def, choice, { reasoning: 'default', serviceTier: 'default' }, { reasoning: 'high' }, null, {})).toEqual({ effectiveModel: 'base', reasoning: null, serviceTier: null });
  expect(resolveAdmissionPreferences(def, choice, {}, { reasoning: 'default' }, null, {})).toEqual({ effectiveModel: 'base', reasoning: null, serviceTier: null });
  expect(() => resolveAdmissionPreferences(def, choice, { reasoning: {} }, {}, null, {})).toThrow('strings or null');
  expect(() => resolveAdmissionPreferences(def, choice, { reasoning: 'not-supported' }, {}, null, {})).toThrow('reasoning');
});
