// AC-R02.2 (prd.md) / technical-spec.md "Planned V1 contract": a cross-agent
// change occurs when the newly submitted turn's agent differs from the previous
// submitted turn's agent, regardless of that turn's completed, failed or
// cancelled status, and it always starts a fresh native session.
//
// These cases exercise the resume guard at the DB boundary
// (`resolveAgentResumeContext`); they do not consume CLI stream frames, so the
// recorded CLI fixtures in tests/fixtures/claude-cli-recordings/ do not apply.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertAgentSession,
  upsertMessage,
} from '../src/db.js';
import { resolveAgentResumeContext } from '../src/agent-session-resume.js';

type Db = ReturnType<typeof openDatabase>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('cross-agent resume guard (AC-R02.2)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-cross-agent-resume-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(): Db {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1', projectId: 'proj-1', title: 'C', createdAt: now, updatedAt: now,
    });
    return db;
  }

  function turn(
    db: Db,
    n: number,
    agentId: string,
    runStatus: string | null,
  ): string {
    upsertMessage(db, 'conv-1', { id: `user-${n}`, role: 'user', content: `u${n}` });
    const id = `asst-${n}`;
    upsertMessage(db, 'conv-1', {
      id,
      role: 'assistant',
      content: `a${n}`,
      agentId,
      agentName: agentId,
      runId: `run-${n}`,
      runStatus,
    });
    return id;
  }

  // Agent A ('claude') succeeded on turn 1 and stored an in-sync native session.
  function agentASucceeded(db: Db): void {
    turn(db, 1, 'claude', 'succeeded');
    upsertAgentSession(db, {
      conversationId: 'conv-1',
      agentId: 'claude',
      sessionId: 'sess-A',
      lastMessageId: 'asst-1',
      model: 'opus',
      cwd: '/work/proj',
    });
  }

  function resolveForA(db: Db, currentAssistantMessageId: string) {
    return resolveAgentResumeContext(db, {
      conversationId: 'conv-1',
      agentId: 'claude',
      currentModel: 'opus',
      currentCwd: '/work/proj',
      currentAssistantMessageId,
    });
  }

  function expectFresh(ctx: ReturnType<typeof resolveForA>): void {
    expect(ctx.isResuming).toBe(false);
    expect(ctx.resumeSessionId).toBeNull();
    expect(ctx.newSessionId).toMatch(UUID_RE);
    expect(ctx.newSessionId).not.toBe('sess-A');
    expect(ctx.invalidationReason).toBe('conversation_advanced');
  }

  it('control: A resumes its own session when A also ran the preceding turn', () => {
    const db = seed();
    agentASucceeded(db);
    const current = turn(db, 2, 'claude', null);
    const ctx = resolveForA(db, current);
    expect(ctx.isResuming).toBe(true);
    expect(ctx.resumeSessionId).toBe('sess-A');
  });

  it('starts fresh when the preceding submitted turn belongs to another agent, even though A model/cwd/cursor would resume', () => {
    const db = seed();
    agentASucceeded(db);
    // Agent B's turn was submitted but never reached a terminal success.
    turn(db, 2, 'codex', 'running');
    const current = turn(db, 3, 'claude', null);
    expectFresh(resolveForA(db, current));
  });

  it('A (succeeded) -> B (failed) -> A starts fresh', () => {
    const db = seed();
    agentASucceeded(db);
    turn(db, 2, 'codex', 'failed');
    const current = turn(db, 3, 'claude', null);
    expectFresh(resolveForA(db, current));
  });

  it('A (succeeded) -> B (canceled) -> A starts fresh', () => {
    const db = seed();
    agentASucceeded(db);
    turn(db, 2, 'codex', 'canceled');
    const current = turn(db, 3, 'claude', null);
    expectFresh(resolveForA(db, current));
  });

  it('a same-agent model change still reports model_changed', () => {
    const db = seed();
    agentASucceeded(db);
    const current = turn(db, 2, 'claude', null);
    const ctx = resolveAgentResumeContext(db, {
      conversationId: 'conv-1',
      agentId: 'claude',
      currentModel: 'sonnet',
      currentCwd: '/work/proj',
      currentAssistantMessageId: current,
    });
    expect(ctx.isResuming).toBe(false);
    expect(ctx.resumeSessionId).toBeNull();
    expect(ctx.storedSessionId).toBe('sess-A');
    expect(ctx.invalidationReason).toBe('model_changed');
  });

  it('a same-turn re-run of A keeps its session when B ran before that turn was first created', () => {
    // A daemon-internal restart re-enters with the stored cursor as the current
    // placeholder. The preceding turn for that placeholder is A's own, so the
    // cross-agent rule must not fire.
    const db = seed();
    turn(db, 1, 'codex', 'succeeded');
    turn(db, 2, 'claude', 'failed');
    upsertAgentSession(db, {
      conversationId: 'conv-1',
      agentId: 'claude',
      sessionId: 'sess-A',
      lastMessageId: 'asst-2',
      model: 'opus',
      cwd: '/work/proj',
    });
    const ctx = resolveForA(db, 'asst-2');
    expect(ctx.invalidationReason).toBeNull();
    expect(ctx.isResuming).toBe(true);
  });
});
