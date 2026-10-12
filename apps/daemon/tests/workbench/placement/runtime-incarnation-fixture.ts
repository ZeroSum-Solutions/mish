// Owned prior-incarnation process: boots the actual coordinated runtime from
// source, records one scenario, reports it, then waits to be SIGKILLed.
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { preparePlacementBootstrap } from '../../../src/workbench/placement/owner-bootstrap.js';
import { attachPlacementRuntime } from '../../../src/workbench/placement/runtime.js';
import type { ProcessTable } from '../../../src/workbench/placement/supervisor.js';

interface Config { env: NodeJS.ProcessEnv; scenario: 'escaping' | 'helper' | 'unknown-spawn' | 'scripted-spawn'; boot?: string; table?: ProcessTable }
const config = JSON.parse(process.argv[2]!) as Config;
const bootstrap = preparePlacementBootstrap({ env: config.env, projectRoot: '/x' });
if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
const db = new Database(join(bootstrap.canonicalDataRoot, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
const projectsDir = join(bootstrap.canonicalDataRoot, 'projects'); const sources = [{ id: 'p1' }];
mkdirSync(join(projectsDir, 'p1'), { recursive: true });
const runtime = attachPlacementRuntime(bootstrap, { db, projectsDir, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources,
  ...(config.table ? { inspector: { bootId: () => config.boot!, table: () => config.table! } } : {}) });
const run = await runtime.runLifetime!.admit({ projectIds: ['p1'] }); await run.start();
const report: Record<string, unknown> = { fixturePid: process.pid };
const leader = (script: string) => spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
const firstLine = (child: ReturnType<typeof leader>) => new Promise<string>(resolve => { let buf = ''; child.stdout!.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.trim()); }); });
if (config.scenario === 'escaping') {
  const handle = run.launch({ kind: 'child', command: process.execPath });
  const root = leader(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); g.unref();
process.stdout.write(String(g.pid) + '\\n'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();`);
  handle.observeSpawn(root.pid!); const descendant = Number(await firstLine(root)); handle.sample();
  const exited = new Promise<{ code: number | null; signal: string | null }>(r => root.once('exit', (code, signal) => r({ code, signal })));
  root.stdin!.end(); handle.recordExit(await exited);
  Object.assign(report, { launchId: handle.launchId, rootPid: root.pid, descendant });
} else if (config.scenario === 'helper') {
  const handle = run.launch({ kind: 'helper', command: process.execPath });
  const helper = leader(`process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
  handle.observeSpawn(helper.pid!); await firstLine(helper);
  Object.assign(report, { launchId: handle.launchId, helperPid: helper.pid });
} else if (config.scenario === 'unknown-spawn') {
  Object.assign(report, { launchId: run.launch({ kind: 'child', command: 'never-spawned' }).launchId });
} else {
  const handle = run.launch({ kind: 'child', command: 'scripted' });
  handle.observeSpawn((config.table as Extract<ProcessTable, { kind: 'table' }>).entries[0]!.pid);
  Object.assign(report, { launchId: handle.launchId });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
await new Promise(() => undefined);
