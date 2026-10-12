// AC-R10.2 — the gallery filters a project's media by type/provider/status/date,
// keeps saved version chains across a restart, and keeps reuse and unlink
// distinct actions that never silently erase shared bytes.
//
// Red on the batch-4 base: `GET /api/projects/:id/media/gallery` does not
// exist (Express answers 404), terminal media task rows are swept after an
// hour so no version chain could survive, and `od media gallery` is unknown.
//
// Every generation here goes to the local FAKE provider in ./r10-harness.ts,
// except the stub case, which uses the daemon's own labelled stub renderer.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db.js';
import { deleteMediaTask } from '../../src/media/tasks.js';
import {
  FAKE_PROVIDER_MARKER,
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

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('AC-R10.2 media gallery', () => {
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

  async function gallery(url: string, projectId: string, query = ''): Promise<Response> {
    return fetch(`${url}/api/projects/${encodeURIComponent(projectId)}/media/gallery${query}`);
  }

  it('AC-R10.2 gallery: lists a project\'s media newest first with stable ids and provenance', async () => {
    const { daemon, projectId } = await setup();
    const first = await generate(daemon.url, projectId, { prompt: 'a red door', output: 'door.png' });
    await waitTerminal(daemon.url, first);
    const second = await generate(daemon.url, projectId, { prompt: 'a blue window', output: 'window.png', aspect: '1:1' });
    await waitTerminal(daemon.url, second);

    const response = await gallery(daemon.url, projectId);
    expect(response.status).toBe(200);
    const body = await response.json() as { entries: Array<Record<string, any>>; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    expect(body.entries.map((entry) => entry.id)).toEqual([second, first]);
    expect(body.entries[0]).toMatchObject({
      id: second,
      projectId,
      kind: 'image',
      status: 'done',
      provenance: {
        providerId: 'custom-image',
        model: 'custom-image',
        promptDigest: sha256('a blue window'),
        stub: false,
      },
      lineage: { rootId: second, parentId: null, relation: 'original', attempt: 1 },
      output: { state: 'current' },
      file: { name: 'window.png', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      unlinked: false,
      replayable: true,
    });
    // The listing never returns the prompt itself, nor anything credential-shaped.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('a blue window');
    expect(raw).not.toContain('fake-key-for-local-fixture');
  });

  it('AC-R10.2 gallery: the original → retry version chain survives the task sweep and a daemon restart', async () => {
    const { daemon, projectId } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'flaky lighthouse', output: 'lighthouse.png' });
    await waitTerminal(daemon.url, original);
    const retried = await postJson(`${daemon.url}/api/media/tasks/${original}/retry`, {}, { 'idempotency-key': randomUUID() });
    const { taskId: retry } = await retried.json() as { taskId: string };
    await waitTerminal(daemon.url, retry);

    // The live task table sweeps terminal rows after an hour. Do it now: the
    // gallery's history must not depend on that table.
    const db = openDatabase(process.cwd(), { dataDir: daemon.dataDir });
    deleteMediaTask(db, original);
    deleteMediaTask(db, retry);
    await daemon.restart();

    const listed = await (await gallery(daemon.url, projectId)).json() as { entries: Array<Record<string, any>> };
    expect(listed.entries.map((entry) => [entry.id, entry.status, entry.lineage.relation])).toEqual([
      [retry, 'done', 'retry'],
      [original, 'failed', 'original'],
    ]);

    const detail = await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery/${retry}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as Record<string, any>;
    expect(detailBody.chain.map((entry: any) => entry.id)).toEqual([original, retry]);
    expect(detailBody.entry.lineage).toMatchObject({ rootId: original, parentId: original, attempt: 2 });
    expect(detailBody.request).toMatchObject({ surface: 'image', model: 'custom-image', prompt: 'flaky lighthouse' });
  });

  it('AC-R10.2 gallery: an explicit edit joins its parent\'s chain; a parent from another project is refused', async () => {
    const { daemon, projectId } = await setup();
    const original = await generate(daemon.url, projectId, { prompt: 'base portrait', output: 'portrait.png' });
    await waitTerminal(daemon.url, original);
    const edit = await generate(daemon.url, projectId, {
      prompt: 'same portrait, warmer light',
      image: 'portrait.png',
      output: 'portrait-warm.png',
      parentTaskId: original,
    });
    await waitTerminal(daemon.url, edit);
    const detail = await (await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery/${edit}`)).json() as Record<string, any>;
    expect(detail.entry.lineage).toEqual({ rootId: original, parentId: original, relation: 'edit', attempt: 1, parentInProject: true });
    expect(detail.chain.map((entry: any) => entry.id)).toEqual([original, edit]);

    const other = await daemon.createProject('R10 foreign parent');
    const refused = await fetch(`${daemon.url}/api/projects/${other.projectId}/media/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'image', model: 'custom-image', prompt: 'x', parentTaskId: original }),
    });
    expect(refused.status).toBe(400);
  });

  it('AC-R10.2 gallery: a task the daemon restart abandoned reads interrupted/daemon-restart, not running', async () => {
    const { provider, daemon, projectId } = await setup();
    const held = await generate(daemon.url, projectId, { prompt: 'hold across restart' });
    await until(() => provider.held.has('hold across restart'), 'held request');
    await daemon.restart();
    const { entries } = await (await gallery(daemon.url, projectId)).json() as { entries: Array<Record<string, any>> };
    expect(entries.find((entry) => entry.id === held)).toMatchObject({
      status: 'interrupted',
      interruptReason: 'daemon-restart',
      replayable: true,
    });
  });

  it('AC-R10.2 gallery: filters by kind, status, provider and date, and refuses unknown filter values', async () => {
    const { daemon, projectId } = await setup();
    const failed = await generate(daemon.url, projectId, { prompt: 'fail this one' });
    await waitTerminal(daemon.url, failed);
    const done = await generate(daemon.url, projectId, { prompt: 'keep this one' });
    await waitTerminal(daemon.url, done);

    const ids = async (query: string) => {
      const response = await gallery(daemon.url, projectId, query);
      expect(response.status).toBe(200);
      return ((await response.json()) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id);
    };
    expect(await ids('?status=failed')).toEqual([failed]);
    expect(await ids('?status=done,failed')).toEqual([done, failed]);
    expect(await ids('?kind=image&provider=custom-image')).toEqual([done, failed]);
    expect(await ids('?kind=video')).toEqual([]);
    expect(await ids('?provider=fal')).toEqual([]);
    expect(await ids(`?from=${Date.now() + 60_000}`)).toEqual([]);
    expect(await ids(`?to=${new Date(Date.now() + 60_000).toISOString()}`)).toEqual([done, failed]);

    for (const bad of ['?kind=hologram', '?status=cancelled', '?limit=0', '?from=yesterday-ish', '?cursor=not!a!cursor']) {
      const response = await gallery(daemon.url, projectId, bad);
      expect(response.status, bad).toBe(400);
    }
  });

  it('AC-R10.2 gallery: paginates with an opaque cursor, never repeats an entry, and clamps the page size', async () => {
    const { daemon, projectId } = await setup();
    const made: string[] = [];
    for (const prompt of ['one', 'two', 'three']) {
      const taskId = await generate(daemon.url, projectId, { prompt });
      await waitTerminal(daemon.url, taskId);
      made.push(taskId);
    }
    const page1 = await (await gallery(daemon.url, projectId, '?limit=2')).json() as Record<string, any>;
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await (await gallery(daemon.url, projectId, `?limit=2&cursor=${page1.nextCursor}`)).json() as Record<string, any>;
    expect(page2.nextCursor).toBeNull();
    expect([...page1.entries, ...page2.entries].map((entry: any) => entry.id)).toEqual([...made].reverse());

    const clamped = await (await gallery(daemon.url, projectId, '?limit=5000')).json() as Record<string, any>;
    expect(clamped.limit).toBe(100);
  });

  it('AC-R10.2 gallery: a replaced output reads superseded and a symlink in its place is never followed', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const replaced = await generate(daemon.url, projectId, { prompt: 'replace me', output: 'replace.png' });
    await waitTerminal(daemon.url, replaced);
    const linked = await generate(daemon.url, projectId, { prompt: 'link me', output: 'link.png' });
    await waitTerminal(daemon.url, linked);

    await writeFile(path.join(projectDir, 'replace.png'), Buffer.from('someone else wrote this'));
    // Same bytes, but behind a symlink to a file outside the project.
    const outside = await mkdtemp(path.join(tmpdir(), 'r10-outside-'));
    scratch.push(outside);
    const outsideFile = path.join(outside, 'link.png');
    await writeFile(outsideFile, await readFile(path.join(projectDir, 'link.png')));
    await rm(path.join(projectDir, 'link.png'));
    await symlink(outsideFile, path.join(projectDir, 'link.png'));

    const { entries } = await (await gallery(daemon.url, projectId)).json() as { entries: Array<Record<string, any>> };
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get(replaced)).toMatchObject({ status: 'done', output: { state: 'superseded', recordedName: 'replace.png' } });
    expect(byId.get(replaced)).not.toHaveProperty('file');
    expect(byId.get(linked)?.output.state).toBe('superseded');
    expect(byId.get(linked)).not.toHaveProperty('file');
  });

  it('AC-R10.2 gallery: a stub output is flagged as a stub, never presented as a generated asset', async () => {
    const { daemon, projectId } = await setup();
    process.env.OD_MEDIA_ALLOW_STUBS = '1';
    // midjourney-v7 has no renderer wired: with stubs allowed the daemon writes
    // its labelled placeholder and makes no network call at all.
    const stub = await generate(daemon.url, projectId, { model: 'midjourney-v7', prompt: 'placeholder only' });
    await waitTerminal(daemon.url, stub);
    const { entries } = await (await gallery(daemon.url, projectId)).json() as { entries: Array<Record<string, any>> };
    expect(entries.find((entry) => entry.id === stub)).toMatchObject({ provenance: { stub: true } });
  });

  it('AC-R10.2 reuse: copying an output into project B leaves project A intact, and unlink keeps the bytes', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const target = await daemon.createProject('R10 reuse target');
    const source = await generate(daemon.url, projectId, { prompt: 'shared hero', output: 'hero.png' });
    await waitTerminal(daemon.url, source);
    const sourceBytes = await readFile(path.join(projectDir, 'hero.png'));
    expect(sourceBytes.toString('latin1')).toContain(FAKE_PROVIDER_MARKER);

    const reused = await postJson(
      `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/reuse`,
      { targetProjectId: target.projectId },
    );
    expect(reused.status).toBe(201);
    const reuseBody = await reused.json() as Record<string, any>;
    expect(reuseBody).toMatchObject({
      sourceId: source,
      sourceProjectId: projectId,
      bytesCopied: sourceBytes.length,
      entry: {
        projectId: target.projectId,
        status: 'done',
        lineage: { parentId: source, relation: 'reuse', parentInProject: false },
        output: { state: 'current' },
      },
    });
    const copiedName = reuseBody.entry.file.name as string;
    expect(await readFile(path.join(target.projectDir, copiedName))).toEqual(sourceBytes);

    // Unlink in A hides the entry and keeps A's file; B is untouched.
    const unlinked = await postJson(`${daemon.url}/api/projects/${projectId}/media/gallery/${source}/unlink`, {});
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toEqual({ id: source, unlinked: true, bytesRetained: true });
    expect(await readFile(path.join(projectDir, 'hero.png'))).toEqual(sourceBytes);
    expect(existsSync(path.join(target.projectDir, copiedName))).toBe(true);

    const hidden = await (await gallery(daemon.url, projectId)).json() as { entries: unknown[] };
    expect(hidden.entries).toEqual([]);
    const shown = await (await gallery(daemon.url, projectId, '?includeUnlinked=1')).json() as { entries: Array<Record<string, any>> };
    expect(shown.entries).toMatchObject([{ id: source, unlinked: true, output: { state: 'current' } }]);

    // B's chain does not leak A's record: the parent is named, not embedded.
    const bDetail = await (await fetch(`${daemon.url}/api/projects/${target.projectId}/media/gallery/${reuseBody.entry.id}`)).json() as Record<string, any>;
    expect(bDetail.chain.map((entry: any) => entry.id)).toEqual([reuseBody.entry.id]);
    // A's entry is not readable through B.
    const crossRead = await fetch(`${daemon.url}/api/projects/${target.projectId}/media/gallery/${source}`);
    expect(crossRead.status).toBe(404);
  });

  it('AC-R10.2 reuse: a superseded output is refused instead of copying someone else\'s bytes', async () => {
    const { daemon, projectId, projectDir } = await setup();
    const target = await daemon.createProject('R10 refused target');
    const source = await generate(daemon.url, projectId, { prompt: 'overwritten later', output: 'later.png' });
    await waitTerminal(daemon.url, source);
    await writeFile(path.join(projectDir, 'later.png'), Buffer.from('not the generated bytes'));
    const refused = await postJson(
      `${daemon.url}/api/projects/${projectId}/media/gallery/${source}/reuse`,
      { targetProjectId: target.projectId },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'MEDIA_GALLERY_OUTPUT_UNAVAILABLE' } });
  });

  it('AC-R10.2 gallery: unknown project is 404 and a cross-origin read is refused', async () => {
    const { daemon, projectId } = await setup();
    expect((await gallery(daemon.url, `missing_${randomUUID()}`)).status).toBe(404);
    const crossOrigin = await fetch(`${daemon.url}/api/projects/${projectId}/media/gallery`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('AC-R10.2 CLI: od media gallery prints the same filtered page as the HTTP API', async () => {
    const { daemon, projectId } = await setup();
    const failed = await generate(daemon.url, projectId, { prompt: 'fail for cli' });
    await waitTerminal(daemon.url, failed);
    const done = await generate(daemon.url, projectId, { prompt: 'done for cli' });
    await waitTerminal(daemon.url, done);

    const result = await runCli([
      'media', 'gallery', '--project', projectId, '--status', 'done', '--kind', 'image', '--json', '--daemon-url', daemon.url,
    ]);
    expect(result.code, result.stderr).toBe(0);
    const page = lastJson(result.stdout);
    expect(page.entries.map((entry: any) => entry.id)).toEqual([done]);

    const detail = await runCli(['media', 'gallery', '--project', projectId, '--entry', done, '--json', '--daemon-url', daemon.url]);
    expect(detail.code, detail.stderr).toBe(0);
    expect(lastJson(detail.stdout)).toMatchObject({ entry: { id: done }, chain: [{ id: done }] });

    const bad = await runCli(['media', 'gallery', '--project', projectId, '--kind', 'hologram', '--json', '--daemon-url', daemon.url]);
    expect(bad.code).toBe(2);
  });
});
