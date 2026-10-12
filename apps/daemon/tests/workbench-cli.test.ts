import express from 'express';
import { sendApiError } from '../src/http/api-errors.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkbenchCli } from '../src/workbench-cli.js';
import { registerWorkbenchRoutes } from '../src/routes/workbench.js';
import { createLocalResourceSources } from '../src/workbench/resources.js';
let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = undefined; });
async function fixture(beforeRequest?: express.RequestHandler) {
  const app = express(); app.use(express.json());
  if (beforeRequest) app.use(beforeRequest);
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async (_req,res,id) => { if (id === 'forbidden') { res.status(403).json({error:'forbidden'}); return false; } return true; }, sourcesForRequest: () => createLocalResourceSources({ listPlugins: async () => [] }) });
  server = app.listen(0); await new Promise<void>(r => server!.once('listening',r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('od workbench HTTP parity', () => {
  it.each(['context', 'rubric', 'preferences'])('dispatches the saved %s command through the shared od entry', async (family) => {
    const snapshots = {
      context: { projectId: 'p1', revision: 0, context: null },
      rubric: { projectId: 'p1', revision: 0, rubric: null, linkage: null },
      preferences: { projectId: 'p1', revision: 0, preferences: null, effective: { useProjectContext: true } },
    };
    const baseUrl = await fixture((req, res, next) => {
      if (req.path !== `/api/workbench/projects/p1/${family}`) return next();
      expect(req.get('x-od-project-id')).toBe('p1');
      res.json(snapshots[family as keyof typeof snapshots]);
    });
    const output: unknown[] = [];
    expect(await runWorkbenchCli([family, 'get', '--project', 'p1', '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    expect(output).toEqual([snapshots[family as keyof typeof snapshots]]);
  });

  it('leaves context selection omitted so the daemon can use the saved preference', async () => {
    const bodies: Record<string, unknown>[] = [];
    const baseUrl = await fixture((req, _res, next) => { bodies.push(req.body); next(); });
    expect(await runWorkbenchCli(['search', '--project', 'p1', '--json'], { baseUrl, write: () => {} })).toBe(0);
    expect(bodies[0]).not.toHaveProperty('useProjectContext');
  });

  it('uses the HTTP search/inspect results and requested context without opening a browser', async () => {
    const baseUrl = await fixture(); const output: unknown[] = [];
    const options = { baseUrl, readStdin: async () => 'silk', write: (v: unknown) => output.push(v) };
    expect(await runWorkbenchCli(['search','--prompt-file','-','--context','off','--category','component','--limit','1','--json'],options)).toBe(0);
    const search = output[0] as { results: {refKey:string}[]; context: unknown };
    expect(search.context).toEqual({ requested:false, applied:false, reason:'context-disabled', projectId:null, preferenceRevision:0, observedContextRevision:0, selection:'request-override', rankingVersion:'local-context/1', resultMode:'lexical' });
    expect(await runWorkbenchCli(['inspect','--ref',search.results[0]!.refKey,'--json'],options)).toBe(0);
    expect((output[1] as {resource:unknown}).resource).toEqual(search.results[0]);
  });
  it('returns exit2 for invalid flags/files without making a request', async () => {
    const output: unknown[] = [];
    for (const args of [['search','--context','bad','--json'],['search','--prompt-file','-','--limit','101','--json'],['search','--prompt-file','-','--category','invented','--json'],['inspect','--ref','abc','--open','--json'],['search','--prompt-file','/file-does-not-exist','--json'],['inspect','--ref','--json']]) expect(await runWorkbenchCli(args,{baseUrl:'http://invalid.invalid',readStdin:async () => '',write:v => output.push(v)})).toBe(2);
    expect(output).toHaveLength(6);
  });
  it('preserves typed HTTP refusals and returns exit3 for denied/unknown/stale refs', async () => {
    const baseUrl = await fixture(); const output: unknown[] = [];
    expect(await runWorkbenchCli(['inspect','--ref','unknown','--project','forbidden','--json'],{baseUrl,write:v => output.push(v)})).toBe(3);
    expect(output[0]).toEqual({status:403,error:{code:'project-forbidden',message:'Project scope is not authorized'}});
    expect(await runWorkbenchCli(['inspect','--ref','unknown','--json'],{baseUrl,write:v => output.push(v)})).toBe(3);
    expect(output[1]).toMatchObject({status:404,error:{code:'resource-ref-unknown'}});
  });
  it('returns exit1 for transport/server failure', async () => {
    expect(await runWorkbenchCli(['inspect','--ref','unknown','--json'],{baseUrl:'http://127.0.0.1:1',write:() => {}})).toBe(1);
  });
});


it('uses the configured daemon URL and tool bearer for authenticated discovery', async () => {
  const baseUrl = await fixture((req,res,next) => {
    if (req.get('authorization') !== 'Bearer workbench-test-token') { res.status(401).json({error:{code:'UNAUTHORIZED',message:'Tool token required'}}); return; }
    next();
  });
  const output: unknown[] = [];
  expect(await runWorkbenchCli(['search','--json'],{env:{OD_DAEMON_URL:baseUrl,OD_TOOL_TOKEN_ISSUER_ORIGIN:baseUrl,OD_TOOL_TOKEN:'workbench-test-token'},write:v => output.push(v)})).toBe(0);
  expect((output[0] as {results:unknown[]}).results.length).toBeGreaterThan(0);
});

it('honors explicit daemon URL and existing workspace headers for both commands while preserving machine errors', async () => {
  const requests: Array<{method:string;url:string;headers:Record<string,string|undefined>}> = [];
  const envelope = {error:{code:'WORKSPACE_PROJECT_PERMISSION_DENIED',message:'Scope denied',details:{nextSteps:['Use an authorized scope']},retryable:false,requestId:'test-request'}};
  const baseUrl = await fixture((req,res) => {
    requests.push({method:req.method,url:req.originalUrl,headers:{authorization:req.get('authorization'),workspace:req.get('x-od-workspace-id'),member:req.get('x-od-workspace-member-id'),project:req.get('x-od-project-id')}});
    res.status(403).json(envelope);
  });
  const output: unknown[] = [];
  const common = ['--daemon-url',baseUrl,'--workspace',' ws1 ','--workspace-member',' member1 ','--project','p1','--json'];
  const options = {baseUrl:'http://127.0.0.1:1',env:{OD_DAEMON_URL:'http://127.0.0.1:1',OD_TOOL_TOKEN_ISSUER_ORIGIN:baseUrl,OD_TOOL_TOKEN:'workbench-test-token'},write:(v:unknown) => output.push(v)};
  expect(await runWorkbenchCli(['search',...common],options)).toBe(3);
  expect(await runWorkbenchCli(['inspect','--ref','current-key',...common],options)).toBe(3);
  expect(output).toEqual([{status:403,...envelope},{status:403,...envelope}]);
  expect(requests).toEqual([
    {method:'POST',url:'/api/workbench/resources/search',headers:{authorization:'Bearer workbench-test-token',workspace:'ws1',member:'member1',project:'p1'}},
    {method:'GET',url:'/api/workbench/resources/current-key?projectId=p1',headers:{authorization:'Bearer workbench-test-token',workspace:'ws1',member:'member1',project:'p1'}},
  ]);
});

it('rejects incomplete or blank workspace context before transport', async () => {
  const output: unknown[] = [];
  for (const flags of [['--workspace','ws1'],['--workspace-member','member1'],['--workspace',' ','--workspace-member','member1']]) {
    expect(await runWorkbenchCli(['search',...flags,'--json'],{baseUrl:'http://127.0.0.1:1',write:v => output.push(v)})).toBe(2);
  }
  expect(output).toEqual(Array(3).fill({error:{code:'invalid-cli-input',message:'Pass --workspace and --workspace-member together with nonempty values'}}));
});
