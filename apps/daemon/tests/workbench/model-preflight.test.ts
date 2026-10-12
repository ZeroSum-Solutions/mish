import { expect, it } from 'vitest';
import { evaluateModelPreflight } from '../../src/workbench/model-preflight.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const fileAccessAgent = {
  id: 'claude', name: 'Claude Code', bin: 'claude', versionArgs: [], buildArgs: () => [], streamFormat: 'claude-stream-json',
  fallbackModels: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', default: true }],
} satisfies RuntimeAgentDef;

const acpAgentNoImageRouting = {
  id: 'hermes', name: 'Hermes', bin: 'hermes', versionArgs: [], buildArgs: () => [], streamFormat: 'acp-json-rpc',
  fallbackModels: [{ id: 'grok-4.20-reasoning', label: 'Grok 4.20 Reasoning', default: true }],
} satisfies RuntimeAgentDef;

const acpAgentWithImageRouting = {
  id: 'pi', name: 'Pi', bin: 'pi', versionArgs: [], buildArgs: () => [], streamFormat: 'pi-rpc', supportsImagePaths: true,
  fallbackModels: [{ id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', default: true }],
} satisfies RuntimeAgentDef;

const byokOpenCodeAgent = {
  id: 'byok-opencode', name: 'BYOK OpenCode', bin: 'opencode-cli', versionArgs: [], buildArgs: () => [], streamFormat: 'json-event-stream',
  fallbackModels: [{ id: 'default', label: 'Default', default: true }], supportsCustomModel: true,
} satisfies RuntimeAgentDef;

function agentsFor(...defs: RuntimeAgentDef[]) {
  return {
    getAgentDef: (id: string) => defs.find(def => def.id === id) ?? null,
    modelScopeForAgent: async () => null,
  };
}

it('passes a known model and ordinary file attachments for a file-access CLI agent', async () => {
  const result = await evaluateModelPreflight(agentsFor(fileAccessAgent), {
    agentId: 'claude', modelId: 'claude-opus-5-5',
    attachments: [{ name: 'brief.png', kind: 'image', size: 1024 }],
  });
  // claude.ts ignores imagePaths and reads attachments off disk through its
  // own tool calls — no "image-attachments-unsupported" mismatch here.
  expect(result).toEqual({ agentId: 'claude', modelId: 'claude-opus-5-5', ok: true, mismatches: [] });
});

it('flags an image attachment for an ACP agent that never declared explicit image routing', async () => {
  const result = await evaluateModelPreflight(agentsFor(acpAgentNoImageRouting), {
    agentId: 'hermes', modelId: 'grok-4.20-reasoning',
    attachments: [{ name: 'mock.png', kind: 'image', size: 10 }, { name: 'notes.txt', kind: 'text', size: 10 }],
  });
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    { code: 'image-attachments-unsupported', message: 'Hermes does not forward image attachments to its model', attachmentNames: ['mock.png'] },
  ]);
});

it('does not flag the same ACP protocol once the adapter declares explicit image routing', async () => {
  const result = await evaluateModelPreflight(agentsFor(acpAgentWithImageRouting), {
    agentId: 'pi', modelId: 'anthropic/claude-sonnet-4-5',
    attachments: [{ name: 'mock.png', kind: 'image', size: 10 }],
  });
  expect(result).toEqual({ agentId: 'pi', modelId: 'anthropic/claude-sonnet-4-5', ok: true, mismatches: [] });
});

it('reports an unavailable agent and an unknown model as model-unavailable, independent of attachments', async () => {
  const missingAgent = await evaluateModelPreflight(agentsFor(fileAccessAgent), { agentId: 'not-installed', modelId: 'default' });
  expect(missingAgent.ok).toBe(false);
  expect(missingAgent.mismatches).toEqual([{ code: 'model-unavailable', message: 'Agent "not-installed" is not installed or not currently available' }]);

  // A bare unrecognized id (no spaces, safe charset) is treated as a
  // forward-compat custom model id by `sanitizeCustomModel` — matching the
  // PUT route's own policy (models.ts) — so it must NOT trigger a mismatch.
  const customModel = await evaluateModelPreflight(agentsFor(fileAccessAgent), { agentId: 'claude', modelId: 'claude-opus-9-9' });
  expect(customModel).toEqual({ agentId: 'claude', modelId: 'claude-opus-9-9', ok: true, mismatches: [] });

  const unknownModel = await evaluateModelPreflight(agentsFor(fileAccessAgent), { agentId: 'claude', modelId: 'unknown model with spaces' });
  expect(unknownModel.ok).toBe(false);
  expect(unknownModel.mismatches).toEqual([{ code: 'model-unavailable', message: 'Model "unknown model with spaces" is not available for Claude Code' }]);
});

it('flags an oversized attachment regardless of agent/model availability, and can report both mismatches at once', async () => {
  const oversized = await evaluateModelPreflight(agentsFor(acpAgentNoImageRouting), {
    agentId: 'hermes', modelId: 'grok-4.20-reasoning',
    attachments: [{ name: 'scene.png', kind: 'image', size: 300 * 1024 * 1024 }],
  });
  expect(oversized.ok).toBe(false);
  expect(oversized.mismatches).toEqual([
    { code: 'image-attachments-unsupported', message: 'Hermes does not forward image attachments to its model', attachmentNames: ['scene.png'] },
    { code: 'attachment-too-large', message: 'Attachment exceeds the 200 MiB upload limit', attachmentNames: ['scene.png'] },
  ]);
});

it('flags a byok-opencode candidate with no binding and a non-concrete model, matching putSessionModel admission (BLOCK finding)', async () => {
  // Exactly the combination `modelKnown` alone would wrongly pass:
  // `{agentId: 'byok-opencode', modelId: 'default'}` with no `byokBinding` at
  // all. `putSessionModel`'s `validateCompleteChoice` (packages/contracts)
  // rejects this same choice, so preflight must report it as a mismatch too.
  const result = await evaluateModelPreflight(agentsFor(byokOpenCodeAgent), { agentId: 'byok-opencode', modelId: 'default' });
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    { code: 'model-unavailable', message: 'Model "default" is not usable for byok-opencode: BYOK session choices require a complete public binding' },
    { code: 'model-unavailable', message: 'Model "default" is not usable for byok-opencode: BYOK session choices require a concrete raw model ID without the OpenCode provider prefix' },
  ]);
});

it('passes a byok-opencode candidate with a concrete raw model ID and a complete binding', async () => {
  const result = await evaluateModelPreflight(agentsFor(byokOpenCodeAgent), {
    agentId: 'byok-opencode', modelId: 'anthropic/claude-sonnet-4-5',
    byokBinding: { protocol: 'anthropic', baseUrl: 'https://gateway.example/v1', requiresApiKey: true },
  });
  expect(result).toEqual({ agentId: 'byok-opencode', modelId: 'anthropic/claude-sonnet-4-5', ok: true, mismatches: [] });
});

it('rejects an unsafe or incomplete request before reaching agent lookup', async () => {
  await expect(evaluateModelPreflight(agentsFor(fileAccessAgent), { agentId: 'claude' })).rejects.toThrow();
  await expect(evaluateModelPreflight(agentsFor(fileAccessAgent), { agentId: 'claude', modelId: 'default', attachments: [{ name: '../escape', kind: 'file' }] })).rejects.toThrow();
});
