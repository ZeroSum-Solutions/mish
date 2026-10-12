// AC-R02.2 (docs/plans/2026-10-02-design-workbench/prd.md) acceptance cases for
// the daemon's bounded transcript replay: oversize truncation is labelled and
// never deletes app history, a continuation source keeps its attachment
// references and its anchor request, and no hidden reasoning, native session,
// tool or private provider state reaches the replay or the admission record.
//
// These run at the SQLite-fixture layer `replay.test.ts` uses. They do not read
// CLI stream frames, so tests/fixtures/claude-cli-recordings/ does not apply.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  upsertAgentSession,
  upsertMessage,
} from '../../src/db.js';
import { claimSessionAdmission, readConversationCursor, readRunAdmission, type PreparedAdmission } from '../../src/workbench/admission.js';
import { readSessionModel } from '../../src/workbench/session-model.js';
import { parseProviderStdin } from '../../src/workbench/provider-stdin.js';
import { authorizeContinuationSource, prepareAuthorizedReplay, readAdmittedPublicInput } from '../../src/workbench/replay.js';

const TRUNCATION_LABEL = '[Mishh Mashh truncated replay; full history remains stored.]';

let dir: string | null = null;
afterEach(() => {
  closeDatabase();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-r02-replay-'));
  const db = openDatabase(dir, { dataDir: path.join(dir, 'runtime') });
  insertProject(db, { id: 'p', name: 'Replay', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 's', projectId: 'p', title: 'Replay', createdAt: 1, updatedAt: 1 });
  fs.writeFileSync(path.join(dir, 'kept.png'), 'png');
  fs.writeFileSync(path.join(dir, 'current.txt'), 'txt');
  return db;
}
type Db = ReturnType<typeof fixture>;

function prepare(db: Db, agentId = 'codex', modelId = 'A'): PreparedAdmission {
  return {
    projectId: 'p', sessionId: 's', cursor: readConversationCursor(db, 's'), selection: readSessionModel(db, 'p', 's'), checkSelection: false,
    facts: { requested: { agentId, modelId }, effectiveModel: modelId, reasoning: null, serviceTier: null, selectionSource: 'override', selectionRevision: null, sourceRunId: null, routeBudget: null, replayNotice: null },
  };
}

/** Admits one turn and persists its public user/assistant rows, as the run path does. */
function admitTurn(db: Db, runId: string, body: Record<string, unknown>, status: 'succeeded' | 'failed' | 'canceled', agentId = 'codex', modelId = 'A') {
  const prepared = prepare(db, agentId, modelId);
  prepareAuthorizedReplay({ db, prepared, body, projectRoot: dir, source: null });
  claimSessionAdmission(db, runId, prepared);
  upsertMessage(db, 's', { id: `${runId}-user`, role: 'user', content: String(body.message ?? '') });
  upsertMessage(db, 's', { id: `${runId}-assistant`, role: 'assistant', content: `${runId} public reply`, runId, runStatus: status, endedAt: 2 });
}

function sourceRun(runId: string, status: string) {
  return () => ({ id: runId, projectId: 'p', conversationId: 's', assistantMessageId: `${runId}-assistant`, status });
}

describe('AC-R02.2 bounded replay', () => {
  it('labels an oversize replay truncation and its omitted exchanges, while every original message stays in app history', () => {
    const db = fixture();
    admitTurn(db, 'first', { message: 'original brief' }, 'succeeded');
    for (let index = 0; index < 40; index++) {
      upsertMessage(db, 's', { id: `bulk-${index}`, role: index % 2 ? 'assistant' : 'user', content: `BULK_${index}_`.padEnd(2000, 'x'), ...(index % 2 ? { runStatus: 'succeeded', endedAt: 3 } : {}) });
    }
    const before = listMessages(db, 's');

    const next = prepare(db, 'codex', 'B');
    const replay = prepareAuthorizedReplay({ db, prepared: next, body: { message: 'next turn' }, projectRoot: dir, source: null });
    const notice = next.facts.replayNotice!;

    // The replay itself carries a visible truncation label...
    expect(notice.status).toBe('truncated');
    expect(replay.priorTranscript).toContain(TRUNCATION_LABEL);
    // ...and the notice names exactly which public exchanges were left out.
    expect(notice.omittedMessages).toBeGreaterThan(0);
    expect(notice.includedMessages + notice.omittedMessages).toBe(before.length);
    expect(notice.omittedRanges).toHaveLength(1);
    expect(notice.omittedRanges[0]!.first).toBeGreaterThanOrEqual(1);
    expect(notice.omittedRanges[0]!.last).toBeLessThanOrEqual(before.length);
    expect(notice.reason).toBe('model-switch');

    // Omission is replay-payload only: app history (the conversation message
    // route reads `listMessages`) keeps every row, byte for byte, after the
    // truncated turn is admitted.
    claimSessionAdmission(db, 'next', next);
    upsertMessage(db, 's', { id: 'next-assistant', role: 'assistant', content: '', runId: 'next', runStatus: 'queued' });
    const after = listMessages(db, 's');
    for (const original of before) {
      expect(after.find(message => message.id === original.id)?.content).toBe(original.content);
    }
    // Both an exchange older than the replay window and one cut by the
    // head/tail truncation are absent from the replay, yet present above.
    for (const marker of ['BULK_2_', 'BULK_25_']) {
      expect(replay.priorTranscript.includes(marker), `${marker} should be omitted from the replay`).toBe(false);
      expect(after.some(message => message.content.startsWith(marker))).toBe(true);
    }
    // The persisted notice that the UI renders on the new assistant row matches.
    expect(after.find(message => message.id === 'next-assistant')?.replayNotice).toEqual(notice);
  });

  it('retains a continuation source\'s attachment references when the current turn attaches nothing', () => {
    const db = fixture();
    admitTurn(db, 'first', { message: 'original brief' }, 'succeeded');
    admitTurn(db, 'second', { message: 'make the hero use this image', attachments: ['kept.png', '../outside.png'] }, 'failed');
    expect(readAdmittedPublicInput(db, 'second')?.attachmentRefs).toEqual(['kept.png']);

    const source = authorizeContinuationSource(db, 'p', 's', 'second', null, sourceRun('second', 'failed'));
    const next = prepare(db, 'claude', 'B');
    const replay = prepareAuthorizedReplay({ db, prepared: next, body: { message: 'try again', attachments: ['current.txt'] }, projectRoot: dir, source });

    expect(replay.priorTranscript).toContain('### Authorized attachment references\n');
    expect(replay.priorTranscript).toContain('kept.png');
    expect(replay.priorTranscript).toContain('current.txt');
    expect(replay.priorTranscript).not.toContain('../outside.png');
    expect(next.facts.replayNotice).toMatchObject({ reason: 'model-switch', sourceRunId: 'second', attachmentCount: 2 });
    // The current turn's own admitted input stays its own; the source refs are
    // carried by the replay, not copied into the new turn's attachment list.
    claimSessionAdmission(db, 'next', next);
    expect(readAdmittedPublicInput(db, 'next')?.attachmentRefs).toEqual(['current.txt']);
  });

  it('includes the continuation anchor request, and keeps it ahead of an oversize history', () => {
    const db = fixture();
    admitTurn(db, 'first', { message: 'BRIEF_MARKER original brief' }, 'succeeded');
    admitTurn(db, 'second', { message: 'ANCHOR_MARKER rebuild the pricing table' }, 'canceled');
    for (let index = 0; index < 40; index++) {
      upsertMessage(db, 's', { id: `bulk-${index}`, role: 'user', content: `BULK_${index}_`.padEnd(2000, 'x') });
    }

    const source = authorizeContinuationSource(db, 'p', 's', 'second', null, sourceRun('second', 'canceled'));
    expect(source?.input.prompt).toBe('ANCHOR_MARKER rebuild the pricing table');
    const next = prepare(db);
    const replay = prepareAuthorizedReplay({ db, prepared: next, body: { message: 'continue' }, projectRoot: dir, source });

    expect(replay.priorTranscript).toContain('### Original brief\nBRIEF_MARKER original brief');
    expect(replay.priorTranscript).toContain('### Authorized continuation source request\nANCHOR_MARKER rebuild the pricing table');
    expect(replay.priorTranscript.indexOf('ANCHOR_MARKER')).toBeLessThan(replay.priorTranscript.indexOf(TRUNCATION_LABEL));
    expect(next.facts.replayNotice).toMatchObject({ reason: 'fresh-continuation', sourceRunId: 'second', status: 'truncated', mandatoryTruncation: { brief: false, anchor: false, context: false } });
  });

  it('transfers no hidden reasoning, native session, tool or BYOK provider state', () => {
    const db = fixture();
    const PRIVATE = ['private-thinking', 'private-tool-input', 'private-tool-output', 'native-session-private-id', 'sk-test-private-key', 'https://private-provider.example/v1', 'private-system-prompt'];
    admitTurn(db, 'first', { message: 'original brief' }, 'succeeded');
    upsertMessage(db, 's', {
      id: 'first-assistant', role: 'assistant', content: 'visible public reply', runId: 'first', runStatus: 'succeeded', endedAt: 2,
      events: [
        { kind: 'thinking', text: 'private-thinking' },
        { kind: 'tool_use', id: 'tool-1', name: 'Write', input: { secret: 'private-tool-input' } },
        { kind: 'tool_result', toolUseId: 'tool-1', content: 'private-tool-output', isError: false },
      ],
    });
    upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'native-session-private-id', runId: 'first', model: 'A', lastMessageId: 'first-assistant' });

    // The CLI's --byok-provider-stdin carrier, parsed exactly as `od run` does.
    const carrier = parseProviderStdin(JSON.stringify({ protocol: 'openai', baseUrl: 'https://private-provider.example/v1', apiKey: 'sk-test-private-key', requiresApiKey: true }));
    const next = prepare(db, 'claude', 'B');
    next.transientCarrier = carrier;
    const replay = prepareAuthorizedReplay({
      db, prepared: next, projectRoot: dir, source: null,
      body: { message: 'next turn', byokProvider: carrier, systemPrompt: 'private-system-prompt', resumeSessionId: 'native-session-private-id', context: { workspaceItems: [{ id: 'w1', kind: 'file', label: 'notes', path: 'notes.md', secret: 'sk-test-private-key' }] } },
    });
    claimSessionAdmission(db, 'next', next);

    expect(replay.priorTranscript).toContain('visible public reply');
    expect(replay.priorTranscript).toContain('[Tools used: Write]');
    const raw = db.prepare('SELECT input_json, snapshot_json FROM session_run_admissions WHERE run_id=?').get('next') as { input_json: string; snapshot_json: string };
    const surfaces = {
      replay: replay.message,
      admittedInput: JSON.stringify(readAdmittedPublicInput(db, 'next')),
      admission: JSON.stringify(readRunAdmission(db, 'next')),
      rawRow: `${raw.input_json}\n${raw.snapshot_json}`,
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const secret of PRIVATE) expect(text, `${surface} leaked ${secret}`).not.toContain(secret);
    }
  });
});
