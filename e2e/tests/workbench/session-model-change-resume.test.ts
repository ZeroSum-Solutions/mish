// @vitest-environment node

// AC-R02.2 (docs/plans/2026-10-02-design-workbench/prd.md): "Test that
// same-agent changes report `model_changed`, do not pass the old native resume
// ID and send transcript context."
//
// HTTP-boundary witness with the fake Codex app-server, which records the
// JSON-RPC methods it receives. A second turn on the same saved model resumes
// the native thread (`thread/resume`), which proves the fixture can observe a
// resume at all. Switching the conversation's saved model to another Codex
// model makes the next turn start a fresh thread (`thread/start`, which carries
// no thread id), report `resume_skipped` / `model_changed` in its run events,
// and admit a `model-switch` replay that includes the earlier public turns.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { createFakeAgentRuntimes } from '@/fake-agents';
import { requestJson } from '@/vitest/http';
import { listMessages, saveMessage, type E2eChatMessage } from '@/vitest/messages';
import { readRunEvents, waitForRunTerminal } from '@/vitest/runs';
import { createSmokeSuite } from '@/vitest/suite';

type ProjectResponse = { conversationId: string; project: { id: string } };
type SessionModelSnapshot = { revision: number; choice: { agentId: string; modelId: string } | null };
type Receipt = { pid: number; mode: string; event: string; method?: string };
type NativeSessionRecovery = { state: string; guardReason: string | null };
type ReplayNotice = { reason: string; includedMessages: number };

const MODEL_A = 'gpt-6-sol';
const MODEL_B = 'gpt-6-luna';

describe('workbench session model change and native resume', () => {
  test('[P0] a same-agent model change reports model_changed, starts a fresh native thread and replays the transcript', async () => {
    const suite = await createSmokeSuite('workbench-session-model-change-resume');

    await suite.with.toolsDev(async ({ webUrl }) => {
      const fakeAgents = await createFakeAgentRuntimes({
        root: join(suite.scratchDir, 'fake-agents'),
        runtimeIds: ['codex'],
        recordInvocations: true,
      });
      await requestJson(webUrl, '/api/app-config', {
        body: {
          agentCliEnv: { codex: fakeAgents.codex.env },
          agentId: 'codex',
          agentModels: { codex: { model: MODEL_A, reasoning: 'default' } },
          designSystemId: null,
          onboardingCompleted: true,
          skillId: null,
          telemetry: { artifactManifest: true, content: false, metrics: false },
        },
        method: 'PUT',
      });
      const created = await requestJson<ProjectResponse>(webUrl, '/api/projects', {
        body: { designSystemId: null, id: randomUUID(), metadata: { kind: 'prototype' }, name: 'Model change resume', pendingPrompt: null, skillId: null },
      });
      const projectId = created.project.id;
      const conversationId = created.conversationId;
      const projectHeader = { 'x-od-project-id': projectId };
      const modelPath = `/api/workbench/sessions/${encodeURIComponent(conversationId)}/model`;
      const receiptsPath = fakeAgents.codex.invocation!.path;

      async function saveChoice(modelId: string): Promise<SessionModelSnapshot> {
        const current = await requestJson<SessionModelSnapshot>(webUrl, modelPath, { headers: projectHeader });
        return await requestJson<SessionModelSnapshot>(webUrl, modelPath, {
          body: { agentId: 'codex', modelId, expectedRevision: current.revision }, headers: projectHeader, method: 'PUT',
        });
      }
      async function readReceipts(): Promise<Receipt[]> {
        const text = await readFile(receiptsPath, 'utf8');
        return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line) as Receipt) : [];
      }
      /** Runs one turn on the saved choice and returns what its native process received. */
      async function turn(label: string, prompt: string, snapshot: SessionModelSnapshot) {
        const before = new Set((await readReceipts()).map(receipt => receipt.pid));
        const startedAt = Date.now();
        const userMessageId = `user-${label}-${startedAt}`;
        const assistantMessageId = `assistant-${label}-${startedAt}`;
        await saveMessage(webUrl, projectId, conversationId, { id: userMessageId, role: 'user', content: prompt, createdAt: startedAt });
        await saveMessage(webUrl, projectId, conversationId, {
          id: assistantMessageId, role: 'assistant', agentId: 'codex', agentName: 'Codex', content: '', events: [],
          createdAt: startedAt, startedAt, runStatus: 'running',
        });
        const run = await requestJson<{ runId: string }>(webUrl, '/api/runs', {
          body: {
            agentId: snapshot.choice!.agentId, assistantMessageId, clientRequestId: `req-${label}-${startedAt}`, conversationId,
            designSystemId: null, expectedModelRevision: snapshot.revision, message: prompt, model: snapshot.choice!.modelId,
            projectId, reasoning: 'default', skillId: null, userMessageId,
          },
        });
        const terminal = await waitForRunTerminal(webUrl, run.runId, { timeoutMs: 30_000 });
        expect(terminal.status, `${label} run status`).toBe('succeeded');
        const events = await readRunEvents(webUrl, run.runId);
        const recovery = nativeSessionRecovery(events);
        const appServerMethods = (await readReceipts())
          .filter(receipt => receipt.mode === 'app-server' && receipt.event === 'request' && !before.has(receipt.pid))
          .map(receipt => receipt.method);
        const messages = await listMessages(webUrl, projectId, conversationId);
        const assistant = messages.find(message => message.id === assistantMessageId) as (E2eChatMessage & { replayNotice?: ReplayNotice }) | undefined;
        return { runId: run.runId, recovery, appServerMethods, replayNotice: assistant?.replayNotice ?? null };
      }

      // Real daemon discovery offers both models; the Playwright journey in
      // e2e/ui/workbench-session-model-binding.test.ts picks them by label.
      const discovery = await requestJson<{ agents: Array<{ id: string; available: boolean; models: Array<{ id: string; label: string }> }> }>(webUrl, '/api/agents');
      const codex = discovery.agents.find(agent => agent.id === 'codex');
      expect(codex?.available).toBe(true);
      expect(codex?.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: MODEL_A, label: 'GPT-6 Sol' }),
        expect.objectContaining({ id: MODEL_B, label: 'GPT-6 Luna' }),
      ]));

      const onA = await saveChoice(MODEL_A);
      const first = await turn('first', 'Create a deterministic smoke artifact', onA);
      expect(first.appServerMethods).toContain('thread/start');
      expect(first.appServerMethods).not.toContain('thread/resume');

      // Control: the same saved model resumes, so the fixture does observe resume.
      const second = await turn('second', 'Create a follow-up deterministic smoke artifact', onA);
      expect(second.appServerMethods).toContain('thread/resume');
      expect(second.recovery?.state).toBe('resume_attempted');

      const onB = await saveChoice(MODEL_B);
      expect(onB.choice).toEqual({ agentId: 'codex', modelId: MODEL_B });
      const third = await turn('third', 'Create a follow-up deterministic smoke artifact', onB);
      expect(third.recovery).toMatchObject({ state: 'resume_skipped', guardReason: 'model_changed' });
      expect(third.appServerMethods).toContain('thread/start');
      expect(third.appServerMethods, 'the old native thread id must not be passed').not.toContain('thread/resume');
      // The fresh session gets the bounded daemon transcript instead.
      expect(third.replayNotice?.reason).toBe('model-switch');
      expect(third.replayNotice?.includedMessages).toBeGreaterThanOrEqual(4);
    }, {
      // The fixture records JSON-RPC methods only on the app-server transport;
      // the suite default pins exec-json for the other fake-CLI smoke tests.
      env: { OD_CODEX_TRANSPORT: 'app-server' },
    });
  }, 300_000);
});

function nativeSessionRecovery(sse: string): NativeSessionRecovery | null {
  let found: NativeSessionRecovery | null = null;
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:') || !line.includes('native_session_recovery')) continue;
    try {
      const payload = JSON.parse(line.slice(5).trim()) as { type?: string; nativeSessionRecovery?: NativeSessionRecovery };
      // The first frame is the guard decision taken before spawn.
      if (payload.type === 'native_session_recovery' && payload.nativeSessionRecovery && !found) found = payload.nativeSessionRecovery;
    } catch { /* ignore non-JSON frames */ }
  }
  return found;
}
