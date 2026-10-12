import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  mishAmrRunAttempt,
  mishAmrTraceEnv,
} from '../../src/runtimes/env.js';

test('mishAmrRunAttempt counts cumulative retries and manual recharge resumes', () => {
  assert.equal(
    mishAmrRunAttempt({
      cumulativeRetryAttemptCount: 1,
      retryAttemptCount: 2,
      manualResumeAttemptCount: 1,
    }),
    4,
  );
  assert.equal(
    mishAmrRunAttempt({
      manualResumeAttemptCount: 1,
    }),
    1,
  );
});

test('mishAmrTraceEnv builds Mishh Mashh trace identity env for AMR only', () => {
  const amrEnv = mishAmrTraceEnv({
    agentId: 'amr',
    runId: ' run_trace_123 ',
    runAttempt: 2,
    conversationId: ' conversation_trace_456 ',
  });

  assert.equal(amrEnv.MISH_RUN_ID, 'run_trace_123');
  assert.equal(amrEnv.MISH_RUN_ATTEMPT, '2');
  assert.equal(amrEnv.MISH_SESSION_ID, 'conversation_trace_456');

  const claudeEnv = mishAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 2,
    conversationId: 'conversation_trace_456',
  });

  assert.deepEqual(claudeEnv, {});
});

test('mishAmrTraceEnv omits optional AMR session trace env when no conversation exists', () => {
  const env = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_no_session',
    runAttempt: 0,
  });

  assert.equal(env.MISH_RUN_ID, 'run_trace_no_session');
  assert.equal(env.MISH_RUN_ATTEMPT, '0');
  assert.equal(env.MISH_SESSION_ID, undefined);
});

test('mishAmrTraceEnv fails fast on invalid AMR trace inputs', () => {
  assert.throws(
    () => mishAmrTraceEnv({ agentId: 'amr', runId: ' ', runAttempt: 0 }),
    /MISH_RUN_ID/,
  );
  assert.throws(
    () => mishAmrTraceEnv({ agentId: 'amr', runId: 'run_trace', runAttempt: -1 }),
    /MISH_RUN_ATTEMPT/,
  );
});

// Vela's workspace-credit isolation (spec: workspace-scoped wallet and
// credit isolation) attributes an AMR spend by the MISH_WORKSPACE_ID
// env the daemon forwards to the vela CLI, which the CLI turns into
// `X-Mish-Workspace-Id` + `x-vela-workspace-id` request headers.
test('mishAmrTraceEnv forwards an exact persisted workspace id for AMR runs', () => {
  const env = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_team',
    runAttempt: 0,
    workspaceId: ' workspace_team_123 ',
  });

  assert.equal(env.MISH_WORKSPACE_ID, 'workspace_team_123');
});

test('mishAmrTraceEnv forwards a persisted Personal workspace id too', () => {
  const env = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_personal',
    runAttempt: 0,
    workspaceId: ' workspace_personal_123 ',
  });
  assert.equal(env.MISH_WORKSPACE_ID, 'workspace_personal_123');
});

// Null/undefined/blank means the caller found no persisted binding at all.
// Only that genuinely unbound historical-project case omits the env var.
test('mishAmrTraceEnv omits MISH_WORKSPACE_ID only without a persisted binding', () => {
  const withNull = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound',
    runAttempt: 0,
    workspaceId: null,
  });
  assert.equal('MISH_WORKSPACE_ID' in withNull, false);

  const withUndefined = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound_2',
    runAttempt: 0,
  });
  assert.equal('MISH_WORKSPACE_ID' in withUndefined, false);

  const withBlank = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_unbound_3',
    runAttempt: 0,
    workspaceId: '   ',
  });
  assert.equal('MISH_WORKSPACE_ID' in withBlank, false);
});

test('mishAmrTraceEnv never forwards workspaceId for non-AMR agents', () => {
  const env = mishAmrTraceEnv({
    agentId: 'claude',
    runId: 'run_trace_123',
    runAttempt: 0,
    workspaceId: 'workspace_team_123',
  });
  assert.deepEqual(env, {});
});

test('mishAmrTraceEnv forwards only bounded plugin correlation to Vela', () => {
  const env = mishAmrTraceEnv({
    agentId: 'amr',
    runId: 'run_trace_plugin',
    runAttempt: 0,
    externalPluginAnalytics: {
      pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      logicalRequestDigest: 'a'.repeat(64),
      logicalRequestDigestVersion: 1,
      externalPluginId: 'mish',
      externalPluginVersion: '0.4.0',
      distributionMechanism: 'git_marketplace',
      publisherClass: 'mish_first_party',
      apiKey: 'must-not-forward',
      accountId: 'must-not-forward',
    },
  });

  assert.equal(
    env.MISH_PLUGIN_WORKFLOW_ID,
    '018f6f2e-4444-7444-8444-444444444444',
  );
  assert.equal(env.MISH_LOGICAL_REQUEST_DIGEST, 'a'.repeat(64));
  assert.equal(env.MISH_LOGICAL_REQUEST_DIGEST_VERSION, '1');
  assert.equal(env.MISH_EXTERNAL_PLUGIN_ID, 'mish');
  assert.equal(env.MISH_EXTERNAL_PLUGIN_VERSION, '0.4.0');
  assert.equal(env.MISH_DISTRIBUTION_MECHANISM, 'git_marketplace');
  assert.equal(
    env.MISH_PUBLISHER_CLASS,
    'mish_first_party',
  );
  assert.equal(env.MISH_API_KEY, undefined);
  assert.equal(env.MISH_ACCOUNT_ID, undefined);
});
