// AC-R10.1 / AC-R10.2 — fixes from the B5-3 review (captain fix list).
//
// Each spec is red on 8512b3074c. Every generation goes to the local FAKE
// provider in ./r10-harness.ts; the "secrets" are fake fixture strings.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureWorkspaceProject, openDatabase } from '../../src/db.js';
import { recordMediaTaskLineage } from '../../src/media/lineage.js';
import { insertMediaTask } from '../../src/media/tasks.js';
import { renameProjectFile } from '../../src/projects.js';
import {
  LEAKED_SECRETS,
  LEAKY_PROVIDER_MESSAGE,
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

function expectNoSecrets(value: unknown, where: string) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of LEAKED_SECRETS) expect(text, `${where} leaked ${secret}`).not.toContain(secret);
}

const workspaceHeaders = (memberId: string) => ({
  'x-od-workspace-id': 'ws-r10',
  'x-od-workspace-member-id': memberId,
});

describe('AC-R10 review fixes', () => {
  let provider: FakeProvider | null = null;
  let daemon: R10Daemon | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    provider?.releaseHeld();
    await daemon?.stop();
    await provider?.close();
    daemon = null;
    provider = null;
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    provider = await startFakeImageProvider();
    daemon = await startR10Daemon(provider);
    const project = await daemon.createProject();
    return { provider, daemon, ...project };
  }

  const db = () => openDatabase(process.cwd(), { dataDir: daemon!.dataDir });
  const rawErrors = (table: 'media_tasks' | 'media_task_lineage', idColumn: string, id: string) =>
    (db().prepare(`SELECT error_json AS e FROM ${table} WHERE ${idColumn} = ?`).get(id) as { e: string | null } | undefined)?.e ?? '';

  it('B1 (AC-R10.1): a provider failure carrying a signed URL and tokens is stored and returned redacted', async () => {
    const { daemon, projectId } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'leak credentials please' });
    const snapshot = await waitTerminal(daemon.url, taskId);
    expect(snapshot.status).toBe('failed');
    expectNoSecrets(snapshot, 'wait snapshot');
    // The useful part survives: origin and path of the URL.
    expect(snapshot.error.message).toContain('https://cdn.fake-provider.test/out/image.png');

    const listed = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/tasks?includeDone=1`)).json();
    expectNoSecrets(listed, 'task list');
    const gallery = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery`)).json();
    expectNoSecrets(gallery, 'gallery');
    expectNoSecrets(rawErrors('media_tasks', 'id', taskId), 'media_tasks row');
    expectNoSecrets(rawErrors('media_task_lineage', 'task_id', taskId), 'lineage row');
  });

  it('B1 (AC-R10.2): rows written before redaction are redacted by the migration backfill', async () => {
    const { daemon, projectId } = await setup();
    const now = Date.now();
    const legacyTask = `legacy_${randomUUID()}`;
    insertMediaTask(db(), {
      id: legacyTask,
      projectId,
      status: 'failed',
      surface: 'image',
      model: 'custom-image',
      error: { message: LEAKY_PROVIDER_MESSAGE, status: 400 },
      startedAt: now - 10,
      endedAt: now,
    });
    const historyOnly = `history_${randomUUID()}`;
    recordMediaTaskLineage(db(), {
      taskId: historyOnly,
      projectId,
      status: 'failed',
      createdAt: now,
      surface: 'image',
      model: 'custom-image',
      request: { surface: 'image', model: 'custom-image', prompt: 'x' },
    });
    db().prepare(`UPDATE media_task_lineage SET error_json = ? WHERE task_id = ?`)
      .run(JSON.stringify({ message: LEAKY_PROVIDER_MESSAGE }), historyOnly);

    await daemon.restart();
    expectNoSecrets(rawErrors('media_tasks', 'id', legacyTask), 'legacy media_tasks row');
    expectNoSecrets(rawErrors('media_task_lineage', 'task_id', legacyTask), 'backfilled lineage row');
    expectNoSecrets(rawErrors('media_task_lineage', 'task_id', historyOnly), 'existing lineage row');
    expect(rawErrors('media_task_lineage', 'task_id', historyOnly)).toContain('cdn.fake-provider.test/out/image.png');
  });

  it('W1 (AC-R10.1): two concurrent retries with one key start exactly one task and both answer with it', async () => {
    const { daemon, projectId } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'flaky concurrent', output: 'concurrent.png' });
    await waitTerminal(daemon.url, original);
    const key = `same-${randomUUID()}`;
    const [a, b] = await Promise.all([
      postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': key }),
      postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': key }),
    ]);
    const bodies = [await a.json(), await b.json()] as Array<Record<string, any>>;
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(bodies[0]!.taskId).toBe(bodies[1]!.taskId);
    expect(bodies.map((body) => body.replayed).sort()).toEqual([false, true]);
    // Let the one retry finish before teardown closes the database under it.
    expect(await waitTerminal(daemon.url, bodies[0]!.taskId)).toMatchObject({ status: 'done' });

    const { tasks } = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/tasks?includeDone=1`)).json() as { tasks: Array<Record<string, any>> };
    // The original plus one retry: no stray failed task from the losing request.
    expect(tasks).toHaveLength(2);
    expect(tasks.filter((task) => task.status === 'failed').map((task) => task.taskId)).toEqual([original]);
  });

  it('W4 (AC-R10.1): a retry never reuses the original output name, so it can never overwrite', async () => {
    const { daemon, projectId } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'flaky naming', output: 'named.png' });
    await waitTerminal(daemon.url, original);
    const retried = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': randomUUID() });
    const { taskId } = await retried.json() as { taskId: string };
    const done = await waitTerminal(daemon.url, taskId);
    expect(done.status).toBe('done');
    expect(done.file.name).not.toBe('named.png');
  });

  it('Q4 (AC-R10.2): an output whose recorded parent directory became a symlink out of the project is not current', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'nested', output: 'pic.png' });
    await waitTerminal(daemon.url, taskId);
    // The user moves the output into a folder; the task list follows the
    // bytes and records the new name.
    await renameProjectFile(path.join(daemon.dataDir, 'projects'), projectId, 'pic.png', 'nested/pic.png');
    await fetch(`${daemon.url}/api/projects/${projectId}/media/tasks?includeDone=1`);
    const before = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery/${taskId}`)).json() as Record<string, any>;
    expect(before.entry.file.name).toBe('nested/pic.png');

    // Now the folder is swapped for a symlink to an outside copy of the same bytes.
    const outside = await mkdtemp(path.join(tmpdir(), 'r10-outside-dir-'));
    scratch.push(outside);
    await writeFile(path.join(outside, 'pic.png'), await readFile(path.join(projectDir, 'nested', 'pic.png')));
    await rm(path.join(projectDir, 'nested'), { recursive: true, force: true });
    await symlink(outside, path.join(projectDir, 'nested'));

    const { entries } = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery`)).json() as { entries: Array<Record<string, any>> };
    const entry = entries.find((candidate) => candidate.id === taskId)!;
    expect(entry.output.state).not.toBe('current');
    expect(entry).not.toHaveProperty('file');
  });

  it('W3 (AC-R10.2): a double reuse with one Idempotency-Key makes one copy and leaves no temp files', async () => {
    const { daemon, projectId } = await setup();
    const target = await daemon.createProject('R10 reuse idempotent target');
    const source = await generate(daemon.url, projectId, { prompt: 'reuse once', output: 'once.png' });
    await waitTerminal(daemon.url, source);
    const key = `reuse-${randomUUID()}`;
    const reuse = () => postJson(
      `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/reuse`,
      { targetProjectId: target.projectId },
      { 'idempotency-key': key },
    );
    const [a, b] = await Promise.all([reuse(), reuse()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const [bodyA, bodyB] = [await a.json(), await b.json()] as Array<Record<string, any>>;
    expect(bodyA!.entry.id).toBe(bodyB!.entry.id);
    expect(await readdir(target.projectDir)).toEqual(['once.png']);
  });

  it('W5 (AC-R10.2): in workspace mode a non-reader cannot reuse from the source and a non-writer cannot write the target', async () => {
    const { daemon, projectId } = await setup();
    const target = await daemon.createProject('R10 workspace target');
    const source = await generate(daemon.url, projectId, { prompt: 'workspace bytes', output: 'ws.png' });
    await waitTerminal(daemon.url, source);
    ensureWorkspaceProject(db(), { projectId, workspaceId: 'ws-r10', visibility: 'personal', createdByWorkspaceMemberId: 'member-a' });
    ensureWorkspaceProject(db(), { projectId: target.projectId, workspaceId: 'ws-r10', visibility: 'team', createdByWorkspaceMemberId: 'member-b' });
    const reuseAs = (memberId: string) => postJson(
      `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/reuse`,
      { targetProjectId: target.projectId },
      { ...workspaceHeaders(memberId), 'idempotency-key': randomUUID() },
    );

    const notReader = await reuseAs('member-b');
    expect(notReader.status).toBe(403);
    const notWriter = await reuseAs('member-a');
    expect(notWriter.status).toBe(403);
    expect(existsSync(path.join(target.projectDir, 'ws.png'))).toBe(false);

    const allowedReadOfSource = await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery`, { headers: workspaceHeaders('member-a') });
    expect(allowedReadOfSource.status).toBe(200);
  });

  it('NIT (AC-R10.1): a caller who cannot read the task\'s project gets 404, never a 403 that proves it exists', async () => {
    const { provider, daemon, projectId } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'hold private' });
    await until(() => provider.held.has('hold private'), 'held request');
    ensureWorkspaceProject(db(), { projectId, workspaceId: 'ws-r10', visibility: 'personal', createdByWorkspaceMemberId: 'member-a' });

    for (const route of ['cancel', 'retry']) {
      const stranger = await postJson(
        `${daemon.url}/api/media/tasks/${taskId}/${route}`,
        {},
        { ...workspaceHeaders('member-b'), 'idempotency-key': randomUUID() },
      );
      expect(stranger.status, route).toBe(404);
      expect(await stranger.json()).toMatchObject({ error: { code: 'MEDIA_TASK_NOT_FOUND' } });
    }
    expect(provider.aborted.has('hold private')).toBe(false);
    const owner = await postJson(`${daemon.url}/api/media/tasks/${taskId}/cancel`, {}, workspaceHeaders('member-a'));
    expect(owner.status).toBe(200);
  });

  it('NIT (AC-R10.1): od media wait exits 130 for a user-cancelled task and names the reason', async () => {
    const { provider, daemon, projectId } = await setup();
    const taskId = await generate(daemon.url, projectId, { prompt: 'hold for exit code' });
    await until(() => provider.held.has('hold for exit code'), 'held request');
    expect((await postJson(`${daemon.url}/api/media/tasks/${taskId}/cancel`, {})).status).toBe(200);
    const waited = await runCli(['media', 'wait', taskId, '--daemon-url', daemon.url]);
    expect(waited.code).toBe(130);
    expect(lastJson(waited.stdout)).toMatchObject({ taskId, status: 'interrupted', interruptReason: 'user-cancelled' });
  });

  it('W5 (AC-R10.2): od media reuse and od media unlink print the same JSON the HTTP API returns', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const target = await daemon.createProject('R10 cli reuse target');
    const source = await generate(daemon.url, projectId, { prompt: 'cli reuse', output: 'cli.png' });
    await waitTerminal(daemon.url, source);

    const reuse = await runCli([
      'media', 'reuse', source, '--project', projectId, '--target', target.projectId,
      '--idempotency-key', 'cli-reuse-1', '--json', '--daemon-url', daemon.url,
    ]);
    expect(reuse.code, reuse.stderr).toBe(0);
    const reused = lastJson(reuse.stdout);
    expect(reused).toMatchObject({ sourceId: source, sourceProjectId: projectId, entry: { projectId: target.projectId, lineage: { relation: 'reuse' } } });
    const replay = await runCli([
      'media', 'reuse', source, '--project', projectId, '--target', target.projectId,
      '--idempotency-key', 'cli-reuse-1', '--json', '--daemon-url', daemon.url,
    ]);
    expect(replay.code, replay.stderr).toBe(0);
    expect(lastJson(replay.stdout).entry.id).toBe(reused.entry.id);
    expect(await readdir(target.projectDir)).toEqual(['cli.png']);

    const unlink = await runCli(['media', 'unlink', source, '--project', projectId, '--json', '--daemon-url', daemon.url]);
    expect(unlink.code, unlink.stderr).toBe(0);
    expect(lastJson(unlink.stdout)).toEqual({ id: source, unlinked: true, bytesRetained: true });
    expect(existsSync(path.join(projectDir, 'cli.png'))).toBe(true);
  });
});
