// @vitest-environment node

// AC-R02.2 (docs/plans/2026-10-02-design-workbench/prd.md): "Earlier messages
// must remain accessible in conversation API/CLI output and the UI; omitted
// replay exchanges are labeled, never deleted from app history."
//
// HTTP-boundary witness: a turn admitted over a conversation whose public
// history exceeds the bounded replay records which exchanges it left out, and
// the conversation message route (read by the web UI) and `od conversation
// messages` (which reads the same route) still return every earlier message
// unchanged afterwards. The daemon-side budget and labelling
// rules are pinned in apps/daemon/tests/workbench/replay-ac-r02.test.ts.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { createFakeAgentRuntimes } from '@/fake-agents';
import { requestJson } from '@/vitest/http';
import { listMessages, saveMessage, type E2eChatMessage } from '@/vitest/messages';
import { waitForRunTerminal } from '@/vitest/runs';
import { createSmokeSuite } from '@/vitest/suite';
import { e2eWorkspaceRoot } from '@/tools-dev/runtime';

const execFileAsync = promisify(execFile);

type ProjectResponse = {
  conversationId: string;
  project: { id: string };
};

type ReplayNotice = {
  includedMessages: number;
  omittedMessages: number;
  omittedRanges: Array<{ first: number; last: number }>;
  status: string;
};

const EARLIER_EXCHANGES = 20;
const MESSAGE_BYTES = 2_000;

describe('workbench replay keeps conversation history', () => {
  test('[P1] a turn whose replay omits earlier exchanges labels them and the message route still returns every one', async () => {
    const suite = await createSmokeSuite('workbench-replay-history-retained');

    await suite.with.toolsDev(async ({ webUrl, start }) => {
      const fakeAgents = await createFakeAgentRuntimes({
        root: join(suite.scratchDir, 'fake-agents'),
        runtimeIds: ['codex'],
      });
      await requestJson(webUrl, '/api/app-config', {
        body: {
          agentCliEnv: { codex: fakeAgents.codex.env },
          agentId: 'codex',
          agentModels: { codex: { model: 'default', reasoning: 'default' } },
          designSystemId: null,
          onboardingCompleted: true,
          skillId: null,
          telemetry: { artifactManifest: true, content: false, metrics: false },
        },
        method: 'PUT',
      });

      const created = await requestJson<ProjectResponse>(webUrl, '/api/projects', {
        body: {
          designSystemId: null,
          id: randomUUID(),
          metadata: { kind: 'prototype' },
          name: 'Replay history retained',
          pendingPrompt: null,
          skillId: null,
        },
      });
      const projectId = created.project.id;
      const conversationId = created.conversationId;
      const projectHeader = { 'x-od-project-id': projectId };

      // Public history well past the 16000-byte replay ceiling.
      const base = Date.now();
      const earlier: E2eChatMessage[] = [];
      for (let index = 0; index < EARLIER_EXCHANGES; index++) {
        const user: E2eChatMessage = { id: `earlier-user-${index}`, role: 'user', content: `EARLIER_USER_${index}_`.padEnd(MESSAGE_BYTES, 'u'), createdAt: base + index * 2 };
        const assistant: E2eChatMessage = {
          id: `earlier-assistant-${index}`, role: 'assistant', agentId: 'codex', agentName: 'Codex',
          content: `EARLIER_ASSISTANT_${index}_`.padEnd(MESSAGE_BYTES, 'a'), createdAt: base + index * 2 + 1,
          runStatus: 'succeeded', startedAt: base + index * 2 + 1, endedAt: base + index * 2 + 1,
        };
        await saveMessage(webUrl, projectId, conversationId, user);
        await saveMessage(webUrl, projectId, conversationId, assistant);
        earlier.push(user, assistant);
      }

      const model = await requestJson<{ revision: number }>(webUrl, `/api/workbench/sessions/${encodeURIComponent(conversationId)}/model`, {
        body: { agentId: 'codex', modelId: 'default', expectedRevision: 0 },
        headers: projectHeader,
        method: 'PUT',
      });

      const startedAt = Date.now();
      const userMessageId = `user-replay-${startedAt}`;
      const assistantMessageId = `assistant-replay-${startedAt}`;
      const prompt = 'Create a deterministic smoke artifact';
      await saveMessage(webUrl, projectId, conversationId, { id: userMessageId, role: 'user', content: prompt, createdAt: startedAt });
      await saveMessage(webUrl, projectId, conversationId, {
        id: assistantMessageId, role: 'assistant', agentId: 'codex', agentName: 'Codex', content: '', events: [],
        createdAt: startedAt, startedAt, runStatus: 'running',
      });
      const run = await requestJson<{ runId: string }>(webUrl, '/api/runs', {
        body: {
          agentId: 'codex',
          assistantMessageId,
          clientRequestId: `req-${startedAt}`,
          conversationId,
          designSystemId: null,
          expectedModelRevision: model.revision,
          message: prompt,
          model: 'default',
          projectId,
          reasoning: 'default',
          skillId: null,
          userMessageId,
        },
      });
      const terminal = await waitForRunTerminal(webUrl, run.runId, { timeoutMs: 30_000 });
      expect(terminal.status).toBe('succeeded');

      const messages = await listMessages(webUrl, projectId, conversationId);
      // Every earlier message is still in app history, byte for byte.
      for (const original of earlier) {
        const stored = messages.find(message => message.id === original.id);
        expect(stored, `${original.id} must remain in the conversation message route`).toBeDefined();
        expect(stored!.content).toBe(original.content);
      }
      // The admitted turn says which public exchanges its replay left out.
      const assistant = messages.find(message => message.id === assistantMessageId) as (E2eChatMessage & { replayNotice?: ReplayNotice }) | undefined;
      expect(assistant?.runId).toBe(run.runId);
      const notice = assistant?.replayNotice;
      expect(notice, 'the admitted assistant row carries its replay notice').toBeDefined();
      expect(notice!.status).toBe('truncated');
      expect(notice!.omittedMessages).toBeGreaterThan(0);
      expect(notice!.omittedRanges.length).toBeGreaterThan(0);
      expect(notice!.includedMessages + notice!.omittedMessages).toBe(earlier.length);

      // The CLI reads the same route, so it also lists every earlier message.
      const daemonUrl = start.daemon?.status.url;
      expect(daemonUrl, 'tools-dev reports the daemon URL').toBeTruthy();
      const { stdout } = await execFileAsync(process.execPath, [
        join(e2eWorkspaceRoot(), 'apps/daemon/dist/cli.js'), 'conversation', 'messages', projectId, conversationId,
        '--daemon-url', daemonUrl!, '--json',
      ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, OD_DAEMON_URL: daemonUrl! } });
      const viaCli = (JSON.parse(stdout) as { messages: E2eChatMessage[] }).messages;
      for (const original of earlier) {
        expect(viaCli.find(message => message.id === original.id)?.content, `${original.id} must remain in od conversation messages`).toBe(original.content);
      }
      expect(viaCli.map(message => message.id)).toEqual(messages.map(message => message.id));
    });
  }, 240_000);
});
