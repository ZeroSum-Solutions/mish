import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
const exec = promisify(execFile);
let server: http.Server;
let base: string;
const requests: { method: string; url: string; body: string; workspace: string | string[] | undefined }[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, body, workspace: req.headers['x-od-workspace-id'] });
    const id = new URL(req.url!, 'http://localhost').pathname.split('/').at(-1);
    res.writeHead(id === 'busy' ? 409 : id === 'missing' ? 404 : id === 'auth' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(id === 'missing' ? { error: { code: 'project-not-found', message: 'No project' } } : id === 'auth' ? { error: { code: 'capabilities-required', message: 'Grant access' } } : id === 'busy' ? { error: { code: 'PROJECT_BUSY', message: 'Project has queued or running runs.' } } : req.method === 'PATCH' ? { project: { id, metadata: { archived: JSON.parse(body).metadata.archived } } } : { ok: true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
async function command(action: string, ids: string[]) {
  const args = [fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'project', action, ...ids, '--daemon-url', base, '--workspace', 'ws', '--workspace-member', 'member', '--json'];
  try { return { ...(await exec(process.execPath, args)), code: 0 }; }
  catch (error) { return error as unknown as { stdout: string; stderr: string; code: number }; }
}
it('deletes all supplied ids, reports partial failure, and exits nonzero', async () => {
  requests.length = 0;
  const result = await command('delete', ['idle', 'busy', 'last']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ action: 'delete', results: [
    { id: 'idle', ok: true }, { id: 'busy', ok: false, error: 'Project has queued or running runs.' }, { id: 'last', ok: true },
  ] });
  expect(requests.map(r => r.url)).toEqual(['/api/projects/idle?ifIdle=1', '/api/projects/busy?ifIdle=1', '/api/projects/last?ifIdle=1']);
  expect(requests.every(r => r.method === 'DELETE' && r.workspace === 'ws')).toBe(true);
});
it.each(['archive', 'unarchive'])('supports multiple ids for %s', async action => {
  requests.length = 0;
  const result = await command(action, ['one', 'two']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).results).toEqual([{ id: 'one', ok: true }, { id: 'two', ok: true }]);
  expect(requests).toHaveLength(2);
  expect(requests.every(r => r.method === 'PATCH' && JSON.parse(r.body).metadata.archived === (action === 'archive'))).toBe(true);
});

it.each(['archive', 'unarchive', 'delete'])('preserves single-id %s JSON and uses the original route', async action => {
  requests.length = 0;
  const result = await command(action, ['one']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(action === 'delete' ? { ok: true } : { project: { id: 'one', metadata: { archived: action === 'archive' } } });
  expect(requests.map(r => r.url)).toEqual(['/api/projects/one']);
});
it.each([['missing', 68, 'project-not-found'], ['auth', 66, 'capabilities-required']])('preserves typed error exits for %s', async (id, code, errorCode) => {
  const result = await command('delete', [String(id)]);
  expect(result.code).toBe(code);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr).error).toMatchObject({ code: errorCode, data: {} });
});
it('continues a batch while preserving typed HTTP failure exits', async () => {
  const result = await command('delete', ['missing', 'last']);
  expect(result.code).toBe(68);
  expect(JSON.parse(result.stdout).results).toEqual([{ id: 'missing', ok: false, error: 'No project' }, { id: 'last', ok: true }]);
});
