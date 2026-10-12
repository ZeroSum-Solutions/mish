import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
async function listener(redirect?: () => string) {
  const observed: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    observed.push(req.headers.authorization); req.resume();
    if (redirect) { res.writeHead(307, { location: redirect() }); res.end(); return; }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'SYNTHETIC_SCOPE_REFUSAL', message: 'Synthetic scope refusal' } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, observed };
}
async function invoke(args: string[], destination: string, issuer?: string) {
  const home = await mkdtemp(path.join(tmpdir(), 'od-cli-custody-')); homes.push(home);
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--daemon-url', destination], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { HOME: home, TMPDIR: home, OD_DATA_DIR: home, OD_TOOL_TOKEN: 'synthetic-entry-custody-token', ...(issuer ? { OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Synthetic CLI did not settle')); }, 10_000);
    child.stdout.resume(); child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
const commands = [
  ['export', 'index.html', '--project', 'synthetic-project', '--format', 'html'],
  ['media', 'scaffold', '--composition-dir', '.hyperframes-cache/synthetic'],
  ['media', 'wait', 'synthetic-task'],
  ['files', 'list', 'synthetic-project', '--json'],
];
for (const args of commands) {
  it(`${args.slice(0, 2).join(' ')} scopes the real CLI bearer to its issuing origin`, async () => {
    const issuer = await listener(), foreign = await listener();
    expect(await invoke(args, issuer.origin, issuer.origin)).not.toBe(0);
    expect(issuer.observed).toEqual(['Bearer synthetic-entry-custody-token']);
    expect(await invoke(args, foreign.origin, issuer.origin)).not.toBe(0);
    expect(foreign.observed).toEqual([undefined]);
    for (const missingOrInvalid of [undefined, 'not-an-origin']) {
      expect(await invoke(args, foreign.origin, missingOrInvalid)).not.toBe(0);
    }
    expect(foreign.observed).toEqual([undefined, undefined, undefined]);
  });
  it(`${args.slice(0, 2).join(' ')} rejects a real HTTP redirect before contacting its target`, async () => {
    const target = await listener(), issuer = await listener(() => target.origin);
    expect(await invoke(args, issuer.origin, issuer.origin)).not.toBe(0);
    expect(issuer.observed).toEqual(['Bearer synthetic-entry-custody-token']);
    expect(target.observed).toEqual([]);
  });
}

async function queuedMediaListener(redirect?: string) {
  const observed: { pathname: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    observed.push({ pathname: req.url!, authorization: req.headers.authorization }); req.resume();
    if (req.url === '/api/tools/media/generate') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'synthetic-followup-task', status: 'queued' })); return;
    }
    if (redirect) { res.writeHead(307, { location: redirect }); res.end(); return; }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'SYNTHETIC_SCOPE_REFUSAL', message: 'Synthetic polling refusal' } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, observed };
}
const generateArgs = ['media', 'generate', '--surface', 'image', '--model', 'synthetic-image', '--prompt', 'Synthetic fixture only', '--output', 'synthetic.png'];
it('media generate reaches actual polling after accepted synthetic dispatch without changing the run authority lane', async () => {
  const foreign = await listener();
  for (const kind of ['matching', 'foreign', 'missing', 'invalid'] as const) {
    const server = await queuedMediaListener();
    const issuer = kind === 'matching' ? server.origin : kind === 'foreign' ? foreign.origin : kind === 'invalid' ? 'not-an-origin' : undefined;
    expect(await invoke(generateArgs, server.origin, issuer)).not.toBe(0);
    expect(server.observed).toEqual([
      { pathname: '/api/tools/media/generate', authorization: kind === 'matching' ? 'Bearer synthetic-entry-custody-token' : undefined },
      { pathname: '/api/media/tasks/synthetic-followup-task/wait', authorization: kind === 'matching' ? 'Bearer synthetic-entry-custody-token' : undefined },
    ]);
  }
  expect(foreign.observed).toEqual([]);
});
it('media generate rejects an authenticated poll redirect after accepted synthetic dispatch', async () => {
  const target = await listener(), server = await queuedMediaListener(target.origin);
  expect(await invoke(generateArgs, server.origin, server.origin)).not.toBe(0);
  expect(server.observed.map(row => row.pathname)).toEqual(['/api/tools/media/generate', '/api/media/tasks/synthetic-followup-task/wait']);
  expect(server.observed.every(row => row.authorization === 'Bearer synthetic-entry-custody-token')).toBe(true);
  expect(target.observed).toEqual([]);
});
