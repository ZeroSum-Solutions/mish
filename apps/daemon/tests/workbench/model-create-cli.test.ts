import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../../..');
let server: http.Server; let temporary: string;
afterEach(async () => { if (server) await new Promise<void>(r => server.close(() => r())); if (temporary) await rm(temporary, { recursive: true, force: true }); });
it('actual conversation/chat CLI creates once then pins choice, retaining real ids on partial failure', async () => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let refuse = false;
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') { res.end(JSON.stringify({ conversation: { id: 'actual-seed' } })); return; }
      if (refuse) { res.statusCode = 409; res.end('{}'); return; }
      res.end(JSON.stringify({ sessionId: 'actual-seed', projectId: 'p', revision: 1, choice: { agentId: 'claude', modelId: 'default' }, updatedAt: 1 }));
    });
  });
  server.listen(0); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  temporary = await mkdtemp(path.join(tmpdir(), 'model-cli-'));
  const config = path.join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: root, paths: { '@open-design/contracts': ['packages/contracts/src/index.ts'] } } }));
  const cli = (args: string[]) => exec(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', config, path.join(root, 'apps/daemon/src/cli.ts'), ...args, '--daemon-url', base, '--json'], { cwd: path.join(root, 'apps/daemon'), env: { ...process.env, OD_TOOL_TOKEN: '' } });
  const first = await cli(['conversation','new','p','--agent','claude','--model','default']);
  expect(JSON.parse(first.stdout)).toMatchObject({ conversation: { id: 'actual-seed' }, sessionModel: { revision: 1 } });
  expect(requests.map(r => r.method)).toEqual(['POST','PUT']);
  expect(requests[1]!.body).toEqual({ agentId: 'claude', modelId: 'default', expectedRevision: 0 });
  refuse = true;
  const failure = await cli(['chat','new','--project','p','--agent','claude','--model','default']).catch(error => error as { code: number; stdout: string });
  expect(failure).toMatchObject({ code: 3 });
  expect(JSON.parse(failure.stdout)).toMatchObject({ conversation: { id: 'actual-seed' }, error: { code: 'session-model-create-partial', projectId: 'p', conversationId: 'actual-seed', status: 409 } });
  expect(requests.map(r => r.method)).toEqual(['POST','PUT','POST','PUT']);
  const incomplete = await cli(['chat','new','--project','p','--agent','claude']).catch(error => error as { code: number; stdout: string });
  expect(incomplete).toMatchObject({ code: 2 }); expect(requests).toHaveLength(4);
});
