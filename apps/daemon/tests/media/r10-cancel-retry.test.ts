// AC-R10.1 — shared media jobs expose cancellation and retry recovery.
//
// Red on the batch-4 base: neither `POST /api/media/tasks/:id/cancel` nor
// `POST /api/media/tasks/:id/retry` exists (Express answers 404), and
// `od media cancel|retry` is an unknown subcommand.
//
// Every generation here goes to the local FAKE provider in ./r10-harness.ts.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MEDIA_TASK_CANCELLED_CODE } from '@open-design/contracts';
import { openDatabase } from '../../src/db.js';
import { insertMediaTask } from '../../src/media/tasks.js';
import {
  type FakeProvider,
  type R10Daemon,
  generate,
  lastJson,
  postJson,
  runCli,
  startFakeImageProvider,
  startR10Daemon,
  until,
  waitTerminal,
} from './r10-harness.js';

describe('AC-R10.1 media task cancel and retry', () => {
  let provider: FakeProvider | null = null;
  let daemon: R10Daemon | null = null;

  afterEach(async () => {
    provider?.releaseHeld();
    await daemon?.stop();
    await provider?.close();
    daemon = null;
    provider = null;
  });

  async function setup() {
    provider = await startFakeImageProvider();
    daemon = await startR10Daemon(provider);
    const project = await daemon.createProject();
    return { provider, daemon, ...project };
  }

  it('AC-R10.1 cancel: a running task ends interrupted/user-cancelled, its provider request is aborted, and no bytes land', async () => {
    const { provider, daemon, projectId, projectDir } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'hold this one', output: 'held.png' });
    await until(() => provider.held.has('hold this one'), 'the fake provider to receive the held request');

    const cancelled = await postJson(`${daemon.url}/api/media/tasks/${taskId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      taskId,
      projectId,
      status: 'interrupted',
      interruptReason: 'user-cancelled',
      cancellation: { mode: 'local-abort', providerCancel: 'unsupported', alreadyCancelled: false },
    });

    // Local abort reaches the wire: the daemon closed its provider request.
    await until(() => provider.aborted.has('hold this one'), 'the daemon to abort its provider request');

    const snapshot = await waitTerminal(daemon.url, taskId);
    expect(snapshot).toMatchObject({
      status: 'interrupted',
      interruptReason: 'user-cancelled',
      error: { code: MEDIA_TASK_CANCELLED_CODE },
    });
    expect(snapshot).not.toHaveProperty('file');
    expect(existsSync(path.join(projectDir, 'held.png'))).toBe(false);

    const listed = await fetch(`${daemon.url}/api/projects/${projectId}/media/tasks?includeDone=1`);
    const { tasks } = await listed.json() as { tasks: Array<Record<string, any>> };
    expect(tasks.find((task) => task.taskId === taskId)).toMatchObject({
      status: 'interrupted',
      interruptReason: 'user-cancelled',
    });
  });

  it('AC-R10.1 cancel: a repeated cancel changes nothing, a finished task refuses with 409, an unknown one is 404', async () => {
    const { provider, daemon, projectId } = await setup();
    const running = await generate(daemon.url, projectId, { prompt: 'hold twice' });
    await until(() => provider.held.has('hold twice'), 'held request');
    expect((await postJson(`${daemon.url}/api/media/tasks/${running}/cancel`, {})).status).toBe(200);
    const again = await postJson(`${daemon.url}/api/media/tasks/${running}/cancel`, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ cancellation: { alreadyCancelled: true } });

    const finished = await generate(daemon.url, projectId, { prompt: 'quick success' });
    expect(await waitTerminal(daemon.url, finished)).toMatchObject({ status: 'done' });
    const refused = await postJson(`${daemon.url}/api/media/tasks/${finished}/cancel`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_CANCELLABLE' } });

    const missing = await postJson(`${daemon.url}/api/media/tasks/${randomUUID()}/cancel`, {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_FOUND' } });
  });

  it('AC-R10.1 cancel: a cross-origin caller is refused before any task changes', async () => {
    const { provider, daemon, projectId } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'hold cross origin' });
    await until(() => provider.held.has('hold cross origin'), 'held request');
    const refused = await postJson(
      `${daemon.url}/api/media/tasks/${taskId}/cancel`,
      {},
      { origin: 'https://evil.example' },
    );
    expect(refused.status).toBe(403);
    expect(provider.aborted.has('hold cross origin')).toBe(false);
  });

  it('AC-R10.1 retry: a failed task retries as a NEW linked task, the original is untouched, and the idempotency key replays', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'flaky shot', output: 'flaky.png' });
    expect(await waitTerminal(daemon.url, original)).toMatchObject({ status: 'failed' });

    const missingKey = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {});
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    const key = `retry-${randomUUID()}`;
    const retried = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': key });
    expect(retried.status).toBe(202);
    const body = await retried.json() as Record<string, any>;
    expect(body).toMatchObject({
      projectId,
      retryOf: original,
      idempotencyKey: key,
      replayed: false,
      lineage: { rootId: original, parentId: original, relation: 'retry', attempt: 2, parentInProject: true },
    });
    expect(body.taskId).not.toBe(original);

    const retriedDone = await waitTerminal(daemon.url, body.taskId);
    expect(retriedDone).toMatchObject({ status: 'done' });
    // W4: a retry gets its own output name and never takes over the original's.
    expect(retriedDone.file.name).not.toBe('flaky.png');
    expect(existsSync(path.join(projectDir, retriedDone.file.name))).toBe(true);
    // No in-place mutation: the original is still the failure it was.
    expect(await waitTerminal(daemon.url, original)).toMatchObject({ status: 'failed' });

    const replay = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': key });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ taskId: body.taskId, replayed: true });

    const other = await generate(daemon.url, projectId, { prompt: 'fail always' });
    await waitTerminal(daemon.url, other);
    const conflict = await postJson(`${daemon.url}/api/media/tasks/${other}/retry`, {}, { 'idempotency-key': key });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
  });

  it('AC-R10.1 retry: a cancelled task retries; a retry of a retry counts the attempt', async () => {
    const { provider, daemon, projectId } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'hold then fail later' });
    await until(() => provider.held.has('hold then fail later'), 'held request');
    expect((await postJson(`${daemon.url}/api/media/tasks/${original}/cancel`, {})).status).toBe(200);

    const first = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as Record<string, any>;
    // The same prompt holds again; cancel the retry too and retry the retry.
    await until(() => provider.held.has('hold then fail later'), 'held retry');
    expect((await postJson(`${daemon.url}/api/media/tasks/${firstBody.taskId}/cancel`, {})).status).toBe(200);
    const second = await postJson(`${daemon.url}/api/media/tasks/${firstBody.taskId}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      retryOf: firstBody.taskId,
      lineage: { rootId: original, parentId: firstBody.taskId, relation: 'retry', attempt: 3 },
    });
  });

  it('AC-R10.1 retry: a done task is not retryable and a running one is not either', async () => {
    const { provider, daemon, projectId } = await setup();
    const done = await generate(daemon.url, projectId, { prompt: 'done already' });
    await waitTerminal(daemon.url, done);
    const refusedDone = await postJson(`${daemon.url}/api/media/tasks/${done}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(refusedDone.status).toBe(409);
    expect(await refusedDone.json()).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_RETRYABLE' } });

    const running = await generate(daemon.url, projectId, { prompt: 'hold running' });
    await until(() => provider.held.has('hold running'), 'held request');
    const refusedRunning = await postJson(`${daemon.url}/api/media/tasks/${running}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(refusedRunning.status).toBe(409);
  });

  it('AC-R10.1 retry: a safety rejection is never auto-retried and says why; an unrecorded request is not replayable', async () => {
    const { daemon, projectId } = await setup();
    const db = openDatabase(process.cwd(), { dataDir: daemon.dataDir });
    const now = Date.now();
    const safetyTask = `safety_${randomUUID()}`;
    insertMediaTask(db, {
      id: safetyTask,
      projectId,
      status: 'failed',
      surface: 'image',
      model: 'custom-image',
      error: {
        message: 'the provider refused the request on content-safety grounds (test fixture)',
        code: 'safety_rejection',
        category: 'safety.nsfw',
        retryable: false,
        nextStep: 'revise-request',
      },
      startedAt: now - 100,
      endedAt: now,
    });
    const refused = await postJson(`${daemon.url}/api/media/tasks/${safetyTask}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(refused.status).toBe(422);
    const refusal = await refused.json() as Record<string, any>;
    expect(refusal).toMatchObject({
      error: {
        code: 'MEDIA_RETRY_SAFETY_REJECTED',
        details: { safetyCategory: 'safety.nsfw', nextStep: 'revise-request' },
      },
    });
    expect(String(refusal.error.message)).toMatch(/content-safety/);

    const legacyTask = `legacy_${randomUUID()}`;
    insertMediaTask(db, {
      id: legacyTask,
      projectId,
      status: 'failed',
      surface: 'image',
      model: 'custom-image',
      error: { message: 'upstream 500 (test fixture)', status: 500 },
      startedAt: now - 100,
      endedAt: now,
    });
    const unavailable = await postJson(`${daemon.url}/api/media/tasks/${legacyTask}/retry`, {}, { 'idempotency-key': randomUUID() });
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'MEDIA_RETRY_REQUEST_UNAVAILABLE' } });
  });

  it('AC-R10.1 CLI: od media cancel and od media retry print the same JSON the HTTP API returns', async () => {
    const { provider, daemon, projectId } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'hold for the cli' });
    await until(() => provider.held.has('hold for the cli'), 'held request');

    const cancel = await runCli(['media', 'cancel', taskId, '--json', '--daemon-url', daemon.url]);
    expect(cancel.code, cancel.stderr).toBe(0);
    expect(lastJson(cancel.stdout)).toMatchObject({ taskId, status: 'interrupted', interruptReason: 'user-cancelled' });

    const retry = await runCli(['media', 'retry', taskId, '--json', '--idempotency-key', 'cli-key-1', '--daemon-url', daemon.url]);
    expect(retry.code, retry.stderr).toBe(0);
    const retried = lastJson(retry.stdout);
    expect(retried).toMatchObject({ retryOf: taskId, idempotencyKey: 'cli-key-1', replayed: false });

    const replay = await runCli(['media', 'retry', taskId, '--json', '--idempotency-key', 'cli-key-1', '--daemon-url', daemon.url]);
    expect(replay.code, replay.stderr).toBe(0);
    expect(lastJson(replay.stdout)).toMatchObject({ taskId: retried.taskId, replayed: true });

    const refused = await runCli(['media', 'cancel', retried.taskId, '--json', '--daemon-url', daemon.url]);
    // The retry is held by the fake as well, so this cancel succeeds; a second one on a done task is refused.
    expect(refused.code, refused.stderr).toBe(0);
    const done = await generate(daemon.url, projectId, { prompt: 'cli done' });
    await waitTerminal(daemon.url, done);
    const notCancellable = await runCli(['media', 'cancel', done, '--json', '--daemon-url', daemon.url]);
    expect(notCancellable.code).not.toBe(0);
    expect(lastJson(notCancellable.stdout)).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_CANCELLABLE' } });
  });
});
