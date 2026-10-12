import { describe, expect, it } from 'vitest';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { codexAgentDef, parseCodexDebugModels } from '../../src/runtimes/defs/codex.js';
import { mergeMmdRouteModels } from '../../src/runtimes/mmd-routes.js';
import { mergeFallbackModelMetadata, resolveDefaultModelFromOptions, resolveModelForAgent, resolveModelForServiceTier } from '../../src/runtimes/models.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

describe.each([
  { def: claudeAgentDef as RuntimeAgentDef, model: 'claude-opus-5-5', explicit: 'claude-haiku-5-5' },
  { def: codexAgentDef as RuntimeAgentDef, model: 'gpt-6.1-sol', explicit: 'gpt-6-sol' },
])('$def.id driver default', ({ def, model, explicit }) => {
  it('advertises the requested model as the picker default', () => {
    expect(resolveDefaultModelFromOptions(def.fallbackModels)).toBe(model);
    expect(def.fallbackModels.find((option) => option.id === 'default')?.label).not.toContain('CLI config');
  });

  it.each([null, 'default'])('resolves %s to the driver model and forwards it to the CLI', (choice) => {
    const resolved = resolveModelForAgent(def, choice, {});
    expect(resolved).toBe(model);
    const args = def.buildArgs('', [], [], { model: resolved }, {});
    expect(args[args.indexOf('--model') + 1]).toBe(model);
  });

  it('preserves an explicit model choice', () => {
    expect(resolveModelForAgent(def, explicit, {})).toBe(explicit);
  });

  it('keeps the driver default when the live catalog prefers another model', () => {
    const live = [
      { id: 'default', label: 'CLI config', default: true },
      { id: model, label: 'Live label', reasoningOptions: [{ id: 'high', label: 'High' }] },
    ];
    const merged = mergeFallbackModelMetadata(def, live);
    expect(resolveDefaultModelFromOptions(merged)).toBe(model);
    expect(merged.filter((option) => option.default).map((option) => option.id)).toEqual([model]);
    expect(merged.find((option) => option.id === model)?.reasoningOptions).toEqual(live[1]?.reasoningOptions);
    expect(live[0]?.default).toBe(true);
    expect(merged.find((option) => option.id === 'default')?.label).not.toContain('CLI config');
  });

  it('offers the driver default when an older CLI catalog omits it', () => {
    const merged = mergeFallbackModelMetadata(def, [{ id: 'default', label: 'CLI config' }]);
    expect(resolveDefaultModelFromOptions(merged)).toBe(model);
    expect(merged.some((option) => option.id === 'default')).toBe(true);
  });
});

it('retains the Claude default after loading proxy routes', () => {
  const routed = mergeMmdRouteModels(['claude-sonnet-5-5'], claudeAgentDef.fallbackModels);
  expect(resolveDefaultModelFromOptions(mergeFallbackModelMetadata(claudeAgentDef, routed))).toBe('claude-opus-5-5');
});

it('retains the Codex default after parsing an older debug catalog', () => {
  const parsed = parseCodexDebugModels(JSON.stringify({ models: [{ slug: 'gpt-5.5' }] }));
  expect(parsed).not.toBeNull();
  expect(resolveDefaultModelFromOptions(mergeFallbackModelMetadata(codexAgentDef, parsed!))).toBe('gpt-6.1-sol');
});

it('keeps a requested service tier when the driver default lacks that capability', () => {
  const def = codexAgentDef as RuntimeAgentDef;
  expect(resolveModelForServiceTier(def, 'gpt-6.1-sol', null, null, true)).toBe('gpt-6.1-sol');
  expect(resolveModelForServiceTier(def, 'gpt-6.1-sol', 'priority', null, true)).toBe('gpt-5.5');
  // Selecting a concrete model explicitly must not silently switch models.
  expect(resolveModelForServiceTier(def, 'gpt-6.1-sol', 'priority')).toBe('gpt-6.1-sol');
});
