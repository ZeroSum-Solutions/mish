import { describe, expect, it } from 'vitest';
import {
  modelPreflightChoicesEqual,
} from '../src/runtime/workbench/model-preflight-recovery';

const amrDefault = { agentId: 'amr', modelId: 'default' };
const claudeOpus = { agentId: 'claude', modelId: 'opus' };
const byokA = { agentId: 'byok-opencode', modelId: 'raw-model-a', byokBinding: { protocol: 'anthropic' as const, baseUrl: 'https://a.example', requiresApiKey: true } };
const byokB = { agentId: 'byok-opencode', modelId: 'raw-model-a', byokBinding: { protocol: 'anthropic' as const, baseUrl: 'https://b.example', requiresApiKey: true } };

describe('modelPreflightChoicesEqual', () => {
  it('treats two null/undefined choices as equal', () => {
    expect(modelPreflightChoicesEqual(null, null)).toBe(true);
    expect(modelPreflightChoicesEqual(undefined, null)).toBe(true);
  });
  it('is false when only one side is null', () => {
    expect(modelPreflightChoicesEqual(amrDefault, null)).toBe(false);
    expect(modelPreflightChoicesEqual(null, amrDefault)).toBe(false);
  });
  it('is true for the same agent/model with no BYOK binding', () => {
    expect(modelPreflightChoicesEqual(amrDefault, { ...amrDefault })).toBe(true);
  });
  it('is false when the agentId or modelId differs', () => {
    expect(modelPreflightChoicesEqual(amrDefault, claudeOpus)).toBe(false);
    expect(modelPreflightChoicesEqual(amrDefault, { ...amrDefault, modelId: 'other' })).toBe(false);
  });
  it('compares byokBinding structurally, not by reference', () => {
    expect(modelPreflightChoicesEqual(byokA, { ...byokA, byokBinding: { ...byokA.byokBinding } })).toBe(true);
    expect(modelPreflightChoicesEqual(byokA, byokB)).toBe(false);
  });
});
