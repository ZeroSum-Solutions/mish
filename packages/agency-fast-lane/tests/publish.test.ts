import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { DaemonHttpError, ensureProject, projectPublisher } from '../src/publish.ts';

type Received = { method: string; url: string; body: Record<string, unknown> };

async function stubDaemon(status = 200): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', body: raw ? JSON.parse(raw) : {} });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 200 ? '{"ok":true}' : '{"error":{"code":"AGENCY_IMAGE_INVALID"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, received };
}

test('ensureProject creates an agency-site project and the publisher posts pages and files', async () => {
  const daemon = await stubDaemon();
  try {
    const projectId = await ensureProject({ daemonUrl: daemon.url, name: 'Riverbend Dental' });
    assert.match(projectId, /^[0-9a-f-]{36}$/);
    assert.equal(daemon.received[0]!.url, '/api/projects');
    assert.deepEqual(daemon.received[0]!.body, { id: projectId, name: 'Riverbend Dental', skillId: 'agency-site' });

    const publisher = projectPublisher({ daemonUrl: daemon.url, projectId });
    await publisher.savePage('ownedsite-r1.html', '<html></html>', { entry: 'ownedsite-r1.html' }, 'stream:brand');
    await publisher.saveFile('assets/agency-site/ownedsite-r1/hero-frame.png', new Uint8Array([1, 2, 3]));
    await publisher.saveFile('AGENCY-SITE-STATE.md', '# state');

    const [page, image, note] = daemon.received.slice(1);
    assert.equal(page!.url, `/api/projects/${projectId}/files`);
    assert.deepEqual(page!.body, { name: 'ownedsite-r1.html', content: '<html></html>', encoding: 'utf8', source: 'ai', artifactManifest: { entry: 'ownedsite-r1.html' }, versionLabel: 'stream:brand' });
    assert.deepEqual(image!.body, { name: 'assets/agency-site/ownedsite-r1/hero-frame.png', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64', overwrite: true });
    assert.deepEqual(note!.body, { name: 'AGENCY-SITE-STATE.md', content: '# state', encoding: 'utf8', overwrite: true });
  } finally {
    daemon.server.close();
  }
});

test('ensureProject returns a given project id without a request', async () => {
  const daemon = await stubDaemon();
  try {
    assert.equal(await ensureProject({ daemonUrl: daemon.url, projectId: 'given', name: 'x' }), 'given');
    assert.equal(daemon.received.length, 0);
  } finally {
    daemon.server.close();
  }
});

test('ensureProject --archive marks a newly created project archived', async () => {
  const daemon = await stubDaemon();
  try {
    const projectId = await ensureProject({ daemonUrl: daemon.url, name: 'Ladder run', archive: true });
    assert.deepEqual(daemon.received[0]!.body, {
      id: projectId,
      name: 'Ladder run',
      skillId: 'agency-site',
      metadata: { archived: true },
    });
  } finally {
    daemon.server.close();
  }
});

test('ensureProject --archive leaves an existing project alone (no request, no metadata touched)', async () => {
  const daemon = await stubDaemon();
  try {
    assert.equal(
      await ensureProject({ daemonUrl: daemon.url, projectId: 'given', name: 'x', archive: true }),
      'given',
    );
    assert.equal(daemon.received.length, 0);
  } finally {
    daemon.server.close();
  }
});

test('a refused save is status-only in message, with the daemon body kept only on detail', async () => {
  const daemon = await stubDaemon(400);
  try {
    const publisher = projectPublisher({ daemonUrl: daemon.url, projectId: 'p' });
    await assert.rejects(publisher.savePage('a.html', '', {}, 'x'), (error: unknown) => {
      assert.ok(error instanceof DaemonHttpError);
      assert.equal(error.message, 'daemon 400 on /api/projects/p/files');
      assert.match(error.detail ?? '', /AGENCY_IMAGE_INVALID/);
      assert.equal(error.message.includes('AGENCY_IMAGE_INVALID'), false);
      return true;
    });
  } finally {
    daemon.server.close();
  }
});

// A watchdog, not a guess at how long this takes: without the timeout the rollback is meant to
// have, the stalled daemon below would hang this test rather than fail it.
test('deleteProject is bounded by its own timeout, so a stalled daemon cannot hold a cancellation open', { timeout: 5_000 }, async () => {
  // The rollback deliberately ignores the build's signal (it is the abort that asked for it), so
  // it needs a timeout of its own: without one, a daemon that never answers would keep a cancelled
  // build running — and its provider lock held — indefinitely.
  const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    throw new Error('unreachable');
  }) as typeof fetch;
  const publisher = projectPublisher({ daemonUrl: 'http://daemon.test', projectId: 'p', fetchImpl: stalled, deleteTimeoutMs: 20 });
  await assert.rejects(publisher.deleteProject(), (error: unknown) => (error as { name?: string }).name === 'TimeoutError');
});

test('a create runs under its own deadline, never the build signal that is cancelling it', { timeout: 5_000 }, async () => {
  // Cancelling the create itself is the one thing a build must not do: the daemon commits the
  // project well after it starts reading the request, so an aborted create can land moments after
  // the client gave up, with nothing left to order a rollback against.
  const cancelled = AbortSignal.abort();
  const seen: Array<AbortSignal | null | undefined> = [];
  const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init?.signal);
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    throw new Error('unreachable');
  }) as typeof fetch;

  await assert.rejects(
    ensureProject({ daemonUrl: 'http://daemon.test', name: 'Riverbend Dental', fetchImpl: stalled, signal: cancelled, createTimeoutMs: 20 }),
    (error: unknown) => (error as { name?: string }).name === 'TimeoutError',
  );
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], cancelled, "the build's signal never reaches the create");
});

test('the whole rollback shares one deadline: a late attempt gets only what is left of it', { timeout: 5_000 }, async () => {
  // The claim is not "the first attempt is bounded" — one timeout would give that. It is that the
  // budget is spent as the rollback goes: three 404s with a poll between them use most of it, and
  // the attempt that then stalls must give up on what remains, not start a fresh full timeout.
  const TOTAL_MS = 400;
  const POLL_MS = 100;
  const attempts: Array<{ startedAt: number; endedAt?: number }> = [];
  const started = Date.now();
  const daemon = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const attempt: { startedAt: number; endedAt?: number } = { startedAt: Date.now() };
    attempts.push(attempt);
    // The first three answer 404 at once; the fourth never answers at all.
    if (attempts.length < 4) return new Response(JSON.stringify({ error: { code: 'PROJECT_NOT_FOUND' } }), { status: 404 });
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      attempt.endedAt = Date.now();
      reject(init.signal!.reason);
    }, { once: true }));
    throw new Error('unreachable');
  }) as typeof fetch;
  const publisher = projectPublisher({ daemonUrl: 'http://daemon.test', projectId: 'p', fetchImpl: daemon, deleteTimeoutMs: TOTAL_MS, rollbackPollMs: POLL_MS });

  await assert.rejects(publisher.deleteProject(), (error: unknown) => (error as { name?: string }).name === 'TimeoutError');

  assert.equal(attempts.length, 4, 'three 404s, then the one that stalls');
  const stalled = attempts[3]!;
  const stalledFor = stalled.endedAt! - stalled.startedAt;
  const spentBefore = stalled.startedAt - started;
  assert.ok(spentBefore >= 2 * POLL_MS, `the polls before the stall should have spent the budget, spent ${spentBefore} ms`);
  assert.ok(
    stalledFor < TOTAL_MS - POLL_MS,
    `the stalled attempt took ${stalledFor} ms of a ${TOTAL_MS} ms budget that was already ${spentBefore} ms spent: it started a fresh timeout instead of using what was left`,
  );
  assert.ok(Date.now() - started < TOTAL_MS * 2, 'the rollback as a whole stayed inside one deadline');
});

test('a rollback says what it found, so an uncertain create can be told from a removed one', async () => {
  const missing = (async () => new Response(JSON.stringify({ error: { code: 'PROJECT_NOT_FOUND' } }), { status: 404 })) as typeof fetch;
  const present = (async () => new Response(null, { status: 200 })) as typeof fetch;

  assert.equal(await projectPublisher({ daemonUrl: 'http://d.test', projectId: 'p', fetchImpl: present }).deleteProject(), 'deleted');
  assert.equal(await projectPublisher({ daemonUrl: 'http://d.test', projectId: 'p', fetchImpl: missing, rollbackRetries: 1, rollbackPollMs: 1 }).deleteProject(), 'missing');
});
