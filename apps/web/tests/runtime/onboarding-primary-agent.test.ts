import { describe, expect, it } from 'vitest';

import {
  isFirstRunOnboarding,
  shouldPromoteLocalAgentOnboarding,
} from '../../src/runtime/onboarding-primary-agent';

describe('shouldPromoteLocalAgentOnboarding', () => {
  it('promotes the local agent when the daemon reports it available', () => {
    expect(
      shouldPromoteLocalAgentOnboarding([
        { id: 'amr', available: true },
        { id: 'claude-code', available: true },
      ]),
    ).toBe(true);
  });

  it('keeps AMR primary when the only detected local agent is not usable yet', () => {
    expect(
      shouldPromoteLocalAgentOnboarding([
        { id: 'amr', available: true },
        { id: 'deepseek-harness', available: false },
      ]),
    ).toBe(false);
  });

  it('keeps AMR primary when no agents are reported', () => {
    expect(shouldPromoteLocalAgentOnboarding([])).toBe(false);
  });

  it('ignores an available AMR entry by itself', () => {
    expect(shouldPromoteLocalAgentOnboarding([{ id: 'amr', available: true }])).toBe(false);
  });

  it('keeps AMR primary when the only local agent is available but unauthenticated', () => {
    expect(
      shouldPromoteLocalAgentOnboarding([
        { id: 'amr', available: true },
        { id: 'claude-code', available: true, authStatus: 'missing' },
      ]),
    ).toBe(false);
  });

  it('promotes the local agent when one candidate is unauthenticated but another is ok', () => {
    expect(
      shouldPromoteLocalAgentOnboarding([
        { id: 'amr', available: true },
        { id: 'claude-code', available: true, authStatus: 'missing' },
        { id: 'codex', available: true, authStatus: 'ok' },
      ]),
    ).toBe(true);
  });
});

describe('isFirstRunOnboarding', () => {
  it('is a first run when no agent has ever been saved', () => {
    expect(isFirstRunOnboarding(null)).toBe(true);
    expect(isFirstRunOnboarding(undefined)).toBe(true);
  });

  it('is a first run when the saved agent is a local CLI', () => {
    expect(isFirstRunOnboarding('claude-code')).toBe(true);
  });

  it('is NOT a first run when the saved agent is AMR (re-authentication, not onboarding)', () => {
    expect(isFirstRunOnboarding('amr')).toBe(false);
  });
});
