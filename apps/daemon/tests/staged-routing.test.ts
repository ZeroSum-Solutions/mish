import { describe, expect, it } from 'vitest';

import {
  STAGED_CLAUDE_DRAFT_MODEL,
  STAGED_DEEPSEEK_DRAFT_MODEL,
  buildFinishPrompt,
  createStagedChain,
  pipelineBlocksStaging,
  planStagedRouting,
  stagedDraftingStatus,
} from '../src/staged-routing.js';

const claude = { id: 'claude', available: true };
const deepseek = { id: 'deepseek', available: true };
const main = { agentId: 'claude', model: 'claude-opus-5-5' };

describe('planStagedRouting', () => {
  it('stays off by default and reports no fallback', () => {
    expect(planStagedRouting({ enabled: false, main, agents: [claude] })).toEqual({
      kind: 'single',
      reason: null,
    });
  });

  it('drafts on Claude Haiku 5.5 when the Claude CLI is available', () => {
    expect(planStagedRouting({ enabled: true, main, agents: [claude, deepseek] })).toEqual({
      kind: 'staged',
      draft: { agentId: 'claude', model: STAGED_CLAUDE_DRAFT_MODEL, source: 'claude' },
    });
    expect(STAGED_CLAUDE_DRAFT_MODEL).toBe('claude-haiku-5-5');
  });

  it('drafts on DeepSeek Flash when only DeepSeek is reachable', () => {
    expect(
      planStagedRouting({
        enabled: true,
        main: { agentId: 'codex', model: 'gpt-6.1-sol' },
        agents: [{ id: 'claude', available: false }, deepseek],
      }),
    ).toEqual({
      kind: 'staged',
      draft: { agentId: 'deepseek', model: STAGED_DEEPSEEK_DRAFT_MODEL, source: 'deepseek' },
    });
  });

  it('falls back to a single pass when no fast model is reachable', () => {
    expect(
      planStagedRouting({ enabled: true, main, agents: [{ id: 'claude', available: false }] }),
    ).toEqual({ kind: 'single', reason: 'draft_unavailable' });
  });

  it('skips staging when the main model already is the fast model', () => {
    expect(
      planStagedRouting({
        enabled: true,
        main: { agentId: 'claude', model: STAGED_CLAUDE_DRAFT_MODEL },
        agents: [claude],
      }),
    ).toEqual({ kind: 'single', reason: 'same_model' });
  });

  it('does not stage runs the host marks unsupported', () => {
    expect(
      planStagedRouting({ enabled: true, main, agents: [claude], unsupported: true }),
    ).toEqual({ kind: 'single', reason: 'unsupported_run' });
  });
});

describe('stagedDraftingStatus', () => {
  it('names the draft stage a turn would use', () => {
    expect(stagedDraftingStatus({ enabled: true, main, agents: [claude] })).toEqual({
      enabled: true,
      draft: { agentId: 'claude', model: 'claude-haiku-5-5', source: 'claude' },
      unavailableReason: null,
    });
  });

  it('reports why nothing is available', () => {
    expect(stagedDraftingStatus({ enabled: false, main, agents: [] })).toEqual({
      enabled: false,
      draft: null,
      unavailableReason: 'draft_unavailable',
    });
  });
});

describe('createStagedChain', () => {
  it('lists draft then finish with the models of each stage', () => {
    const chain = createStagedChain({
      draft: { agentId: 'claude', model: 'claude-haiku-5-5' },
      finish: { agentId: 'claude', model: 'claude-opus-5-5' },
    });
    expect(chain.fallback).toBeNull();
    expect(chain.stages.map((s) => [s.stage, s.agentId, s.model, s.status])).toEqual([
      ['draft', 'claude', 'claude-haiku-5-5', 'pending'],
      ['finish', 'claude', 'claude-opus-5-5', 'pending'],
    ]);
  });
});

describe('buildFinishPrompt', () => {
  it('carries the original request and points at the draft files', () => {
    const prompt = buildFinishPrompt('Make a pricing page');
    expect(prompt).toContain('Make a pricing page');
    expect(prompt.toLowerCase()).toContain('draft');
  });
});


describe('pipelineBlocksStaging', () => {
  const critique = { stages: [{ id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'ok' }] };

  it('lets an automatic default pipeline through (the main prototype case)', () => {
    const automatic = { stages: [
      { id: 'discovery', atoms: ['discovery-question-form'] },
      { id: 'generate', atoms: ['file-write', 'live-artifact'] },
      critique.stages[0]!,
    ] };
    expect(pipelineBlocksStaging(automatic, false)).toBe(false);
    expect(pipelineBlocksStaging(undefined, true)).toBe(false);
  });

  it('blocks multi-agent and workflow pipelines of an explicitly chosen plugin', () => {
    expect(pipelineBlocksStaging(critique, true)).toBe(true);
    expect(pipelineBlocksStaging({ stages: [{ id: 'ask', atoms: ['discovery-question-form'] }] }, true)).toBe(true);
    expect(pipelineBlocksStaging({ stages: [{ id: 'loop', atoms: ['file-write'], repeat: true }] }, true)).toBe(true);
  });

  it('lets a plain explicit plugin pipeline through', () => {
    expect(pipelineBlocksStaging({ stages: [{ id: 'build', atoms: ['file-write', 'live-artifact'] }] }, true)).toBe(false);
  });
});
