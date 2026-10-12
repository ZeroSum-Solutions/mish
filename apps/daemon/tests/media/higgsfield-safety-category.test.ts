// Atlas Digest pilot (G5): a HiggsField safety rejection reached the agent as
// `{code: "safety_rejection", message: "HiggsField generation nsfw"}` and
// nothing else, so a prompt-revision loop had to grep the prose for "nsfw" to
// learn WHY the provider refused. The reason is a typed field now: `category`.
//
// The category set is what the adapter can actually observe. The HiggsField
// CLI reports a refused job as `status: "nsfw"` (recorded Atlas receipts, e.g.
// job 16eb1f98…: `HiggsField job …: nsfw`), and that is its only safety
// verdict — so it maps to `safety.nsfw`. A safety rejection whose producer
// names no category (Vela, every other adapter today) maps to
// `safety.unspecified`. Nothing else is invented.
//
// Every provider here is a fake; no real media provider is called.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase } from '../../src/db.js';
import { renderHiggsfieldImage } from '../../src/media/higgsfield.js';
import { mediaTaskErrorFromFailure } from '../../src/media/task-error.js';
import { getMediaTask, insertMediaTask, migrateMediaTasks } from '../../src/media/tasks.js';
import { startServer } from '../../src/server.js';

const assetFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/connectionTest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/connectionTest.js')>()),
  assertAndFetchExternalAsset: assetFetch,
}));

const daemonRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

const ctx = { wireModel: 'higgsfield/gpt-image-2', prompt: 'A close-up of skin texture', imageRefs: [] };

/** The job record `hf generate get <id> --json` returned for the refused Atlas jobs. */
const RECORDED_NSFW_JOB = { id: '16eb1f98-0ad9-46b6-acf1-1314335318e1', status: 'nsfw' };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('HiggsField safety rejection carries a typed category', () => {
  it('maps the recorded nsfw job status to safety.nsfw', async () => {
    vi.useFakeTimers();
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify([RECORDED_NSFW_JOB.id]))
      .mockResolvedValueOnce(JSON.stringify(RECORDED_NSFW_JOB));
    const result = renderHiggsfieldImage(ctx, undefined, run);
    const assertion = expect(result).rejects.toMatchObject({
      message: 'HiggsField generation nsfw',
      code: 'safety_rejection',
      category: 'safety.nsfw',
      retryable: false,
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('gives an ordinary failed job no safety code and no category', async () => {
    vi.useFakeTimers();
    const run = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(['job-1']))
      .mockResolvedValueOnce(JSON.stringify({ id: 'job-1', status: 'failed' }));
    const result = renderHiggsfieldImage(ctx, undefined, run);
    const settled = result.then(
      () => { throw new Error('a failed job must reject'); },
      (err: unknown) => err as Record<string, unknown>,
    );
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err.code).toBeUndefined();
    expect(err.category).toBeUndefined();
  });
});

describe('media task error keeps the safety category', () => {
  it('copies a known category and classifies the failure as revise-request', () => {
    const error = mediaTaskErrorFromFailure(
      Object.assign(new Error('HiggsField generation nsfw'), {
        code: 'safety_rejection',
        category: 'safety.nsfw',
        retryable: false,
      }),
      { model: 'higgsfield/gpt-image-2' },
    );
    expect(error).toMatchObject({
      code: 'safety_rejection',
      category: 'safety.nsfw',
      retryable: false,
      nextStep: 'revise-request',
    });
  });

  it('names an uncategorised safety rejection safety.unspecified', () => {
    expect(mediaTaskErrorFromFailure(
      Object.assign(new Error('the request was rejected by a content safety policy'), {
        code: 'safety_rejection',
        subject: 'prompt',
      }),
    ).category).toBe('safety.unspecified');
    // A category this build does not know is not trusted: still a safety
    // rejection, reason unspecified.
    expect(mediaTaskErrorFromFailure(
      Object.assign(new Error('refused'), { code: 'safety_rejection', category: 'safety.weapons' }),
    ).category).toBe('safety.unspecified');
  });

  it('never puts a safety category on a failure that is not a safety rejection', () => {
    expect(mediaTaskErrorFromFailure(
      Object.assign(new Error('upstream 500'), { status: 500, category: 'safety.nsfw' }),
    )).not.toHaveProperty('category');
  });

  it('survives a SQLite round trip; a safety rejection read back without a known category is unspecified', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects VALUES ('p1', 'p1', 0, 0);`);
    migrateMediaTasks(db);
    insertMediaTask(db, {
      id: 'kept',
      projectId: 'p1',
      status: 'failed',
      error: { message: 'HiggsField generation nsfw', code: 'safety_rejection', category: 'safety.nsfw' },
    } as never);
    insertMediaTask(db, {
      id: 'garbage',
      projectId: 'p1',
      status: 'failed',
      error: { message: 'refused', code: 'safety_rejection', category: 'not-a-category' },
    } as never);
    insertMediaTask(db, {
      id: 'older-daemon',
      projectId: 'p1',
      status: 'failed',
      error: { message: 'refused', code: 'safety_rejection' },
    } as never);
    insertMediaTask(db, {
      id: 'not-safety',
      projectId: 'p1',
      status: 'failed',
      error: { message: 'upstream 500', status: 500, category: 'safety.nsfw' },
    } as never);
    expect(getMediaTask(db, 'kept')?.error).toMatchObject({ category: 'safety.nsfw' });
    // N2: a row a newer daemon wrote with an unknown category, or an older
    // daemon wrote with none, is still a safety rejection: unspecified.
    expect(getMediaTask(db, 'garbage')?.error).toMatchObject({ category: 'safety.unspecified' });
    expect(getMediaTask(db, 'older-daemon')?.error).toMatchObject({ category: 'safety.unspecified' });
    expect(getMediaTask(db, 'not-safety')?.error).not.toHaveProperty('category');
    db.close();
  });
});

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };

describe('the category reaches HTTP and od media JSON', () => {
  const originalEnv = { ...process.env };
  let daemon: StartedServer | null = null;
  let tmp = '';

  afterEach(async () => {
    await Promise.resolve(daemon?.shutdown?.());
    if (daemon?.server.listening) await new Promise<void>((resolve) => daemon!.server.close(() => resolve()));
    daemon = null;
    closeDatabase();
    for (const key of ['OD_HIGGSFIELD_BIN', 'OD_MEDIA_ALLOW_STUBS']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('od media generate prints the failed task with category safety.nsfw, and the project task list says the same', async () => {
    // A fake `hf` binary replaying the recorded refusal: submit returns a job
    // id, the first poll returns `status: "nsfw"`.
    tmp = await mkdtemp(path.join(os.tmpdir(), 'od-hf-fake-'));
    const fakeHf = path.join(tmp, 'hf');
    await writeFile(fakeHf, [
      '#!/bin/sh',
      'cat > /dev/null',
      'case "$1 $2" in',
      `  "generate create") echo '["${RECORDED_NSFW_JOB.id}"]' ;;`,
      `  "generate get") echo '${JSON.stringify(RECORDED_NSFW_JOB)}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'));
    await chmod(fakeHf, 0o755);
    process.env.OD_HIGGSFIELD_BIN = fakeHf;
    delete process.env.OD_MEDIA_ALLOW_STUBS;

    daemon = await startServer({ port: 0, returnServer: true }) as StartedServer;
    const projectId = `media_safety_${randomUUID()}`;
    const created = await fetch(`${daemon.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Safety probe', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(created.status).toBe(200);

    const cli = await runCli([
      'media', 'generate',
      '--project', projectId,
      '--surface', 'image',
      '--model', 'higgsfield/gpt-image-2',
      '--prompt', ctx.prompt,
      '--output', 'body.png',
      '--daemon-url', daemon.url,
    ]);
    const result = lastJson(cli.stdout);
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'safety_rejection', category: 'safety.nsfw', nextStep: 'revise-request' },
    });
    expect(cli.code).not.toBe(0);

    const listed = await fetch(
      `${daemon.url}/api/projects/${encodeURIComponent(projectId)}/media/tasks?includeDone=1`,
    ).then((response) => response.json()) as { tasks: Array<Record<string, any>> };
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      status: 'failed',
      error: { code: 'safety_rejection', category: 'safety.nsfw' },
    });
  }, 90_000);
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OD_TOOL_TOKEN;
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: daemonRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJson(stdout: string): Record<string, any> {
  const line = stdout
    .trim()
    .split('\n')
    .filter((entry) => entry.trim().startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`no JSON result on stdout: ${JSON.stringify(stdout)}`);
  return JSON.parse(line);
}
