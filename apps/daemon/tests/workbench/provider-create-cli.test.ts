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
it('actual CLI consumes provider stdin for start/resupply and rejects stdin conflict or malformed secret input before HTTP', async () => {
  const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
  server = http.createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
    requests.push({ method: req.method!, url: req.url!, body: JSON.parse(body || '{}') }); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 'source', status: 'failed', resumable: false, projectId: 'p', conversationId: 's', agentId: 'codex' } : { runId: 'new', modelAdmission: { replayNotice: { digest: 'host-digest' } } }));
  }); });
  server.listen(0); await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  temporary = await mkdtemp(path.join(tmpdir(), 'provider-cli-')); const config = path.join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: root, paths: { '@mish/contracts': ['packages/contracts/src/index.ts'] } } }));
  const cli = async (args: string[], input: string) => {
    const child = exec(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', config, path.join(root, 'apps/daemon/src/cli.ts'), ...args, '--daemon-url', base, '--json'], { cwd: path.join(root, 'apps/daemon'), env: { ...process.env, OD_TOOL_TOKEN: '' }, timeout: 20000 });
    child.child.stdin?.end(input);
    return child.then(result => ({ ...result, code: 0 })).catch(error => error as { code: number; stdout: string; stderr: string });
  };
  const binding = { protocol: 'openai', baseUrl: 'https://example.com/v1', requiresApiKey: true };
  const carrier = JSON.stringify({ ...binding, apiKey: 'synthetic-provider-secret' });
  const started = await cli(['run','start','--project','p','--conversation','s','--message','original','--agent','byok-opencode','--model','raw','--expected-model-revision','1','--byok-binding-json',JSON.stringify(binding),'--byok-provider-stdin'], carrier);
  expect(started.code ?? 0).toBe(0); expect(started.stdout).not.toContain('synthetic-provider-secret');
  expect(requests[0]!.body).toMatchObject({ message: 'original', expectedModelRevision: 1, byokBinding: binding, byokProvider: { apiKey: 'synthetic-provider-secret' } });
  const continued = await cli(['run','continue','source','--message','continue now','--byok-provider-stdin'], carrier);
  expect(continued.code ?? 0).toBe(0); expect(requests[2]!.body).toMatchObject({ continueFromRunId: 'source', resumeContinuation: true, message: 'continue now', byokProvider: { apiKey: 'synthetic-provider-secret' } });
  expect(requests[2]!.body.agentId).toBeUndefined(); expect(continued.stdout).toContain('host-digest');
  const inherited = await cli(['run','start','--project','p','--conversation','s','--message','inherit choice','--expected-model-revision','1'], '');
  expect(inherited.code).toBe(0); expect(requests.at(-1)!.body).toMatchObject({ expectedModelRevision: 1, message: 'inherit choice' });
  expect(requests.at(-1)!.body.agentId).toBeUndefined(); expect(requests.at(-1)!.body.model).toBeUndefined();
  const inheritedContinue = await cli(['run','continue','source','--message','inherit continuation','--expected-model-revision','1'], '');
  expect(inheritedContinue.code).toBe(0); expect(requests.at(-1)!.body).toMatchObject({ expectedModelRevision: 1, continueFromRunId: 'source' });
  expect(requests.at(-1)!.body.agentId).toBeUndefined();
  const count = requests.length;
  for (const [args, input] of [
    [['run','start','--project','p','--prompt-file','-','--byok-provider-stdin'], carrier],
    [['run','start','--project','p','--expected-model-revision','9007199254740992'], ''],
    [['run','start','--project','p','--expected-model-revision','-1'], ''],
    [['run','start','--project','p','--byok-provider-stdin'], '{"apiKey":"synthetic-provider-secret"'],
  ] as const) {
    const result = await cli([...args], input); expect(result.code).toBe(2); expect(result.stdout + result.stderr).not.toContain('synthetic-provider-secret'); expect(requests).toHaveLength(count);
  }
});
