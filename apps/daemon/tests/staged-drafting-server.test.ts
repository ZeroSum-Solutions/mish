/**
 * Staged drafting end to end against a real daemon and a fake Claude CLI (no
 * provider calls). The fake logs the `--model` it was started with, so the
 * test sees which model ran each physical Run and in what order.
 */
import type http from 'node:http';
import { detectAgents } from '../src/agents.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

vi.mock('../src/agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents.js')>();
  const { basename } = await import('node:path');
  for (const def of actual.AGENT_DEFS) {
    for (const bin of [def.bin, ...def.fallbackBins ?? []]) processGuard.agentBins.add(basename(bin));
  }
  return { ...actual, detectAgents: vi.fn(async () => [{ id: 'claude', available: true }]), detectAgentsStream: vi.fn(async function* () { yield { id: 'claude', available: true }; }) };
});

const processGuard = vi.hoisted(() => ({ commands: [] as string[], violations: [] as string[], fakeClaude: '', agentBins: new Set(['kimi-code', 'grok-subscription', 'opencode']) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const guard = (command: string) => {
    processGuard.commands.push(command);
    if (processGuard.agentBins.has(path.basename(command)) && command !== processGuard.fakeClaude) {
      const error = new Error(`Real agent CLI forbidden in staged test: ${command}`);
      processGuard.violations.push(error.stack ?? error.message);
      throw error;
    }
  };
  const { promisify } = await import('node:util');
  const nativeExecFile = promisify(actual.execFile);
  const execFile = (...args: Parameters<typeof actual.execFile>) => { guard(String(args[0])); return actual.execFile(...args); };
  Object.assign(execFile, { [promisify.custom]: (...args: Parameters<typeof nativeExecFile>) => {
    guard(String(args[0]));
    return nativeExecFile(...args);
  } });
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => { guard(String(args[0])); return actual.spawn(...args); },
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => { guard(String(args[0])); return actual.spawnSync(...args); },
    execFile,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => { guard(String(args[0])); return actual.execFileSync(...args); },
  };
});

const prepGate = vi.hoisted(() => ({ hold: null as null | ((body: Record<string, unknown>) => Promise<void>) }));
const startupWork = vi.hoisted(() => ({
  admissions: new Set<Promise<unknown>>(),
  starters: new Set<Promise<unknown>>(),
}));
vi.mock('../src/workbench/prepare-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workbench/prepare-model.js')>();
  return { ...actual, prepareModelAdmission: (input: Parameters<typeof actual.prepareModelAdmission>[0]) => {
    const pending = (async () => {
      await prepGate.hold?.(input.body);
      return actual.prepareModelAdmission(input);
    })();
    startupWork.admissions.add(pending);
    void pending.then(
      () => startupWork.admissions.delete(pending),
      () => startupWork.admissions.delete(pending),
    );
    return pending;
  } };
});
vi.mock('../src/runtimes/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/runs.js')>();
  return { ...actual, createChatRunService: (...args: Parameters<typeof actual.createChatRunService>) => {
    const service = actual.createChatRunService(...args);
    const start = service.start;
    service.start = (run, starter) => start(run, (candidate: typeof run) => {
      const pending = starter(candidate);
      startupWork.starters.add(pending);
      void pending.then(
        () => startupWork.starters.delete(pending),
        () => startupWork.starters.delete(pending),
      );
      return pending;
    });
    return service;
  } };
});

type StartedServer = { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
type StagedStatus = {
  id: string;
  status: string;
  staged?: {
    stages: Array<{ stage: string; runId: string | null; model: string | null; status: string; durationMs: number | null }>;
    fallback: { reason: string } | null;
  };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClaudeSource(logFile: string, failModel: string | null, hangFile: string, ctlDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude-code 1.0.0-staged'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: claude -p [--include-partial-messages]'); process.exit(0); }
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const at = process.argv.indexOf('--model');
const model = at >= 0 ? process.argv[at + 1] : 'default';
let prompt = '';
fs.appendFileSync(${JSON.stringify(logFile)} + '.start', model + '\\n');
process.stdin.on('data', (chunk) => { prompt += chunk; });
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ model, promptLen: prompt.length, finish: /fast first draft/i.test(prompt) }) + '\\n');
  const ctl = (name) => fs.existsSync(${JSON.stringify(ctlDir)} + '/' + name);
  if (model === 'claude-haiku-5-5' && ctl('hang-haiku')) {
    setTimeout(() => process.exit(1), 8000);
    return;
  }
  if (model === 'claude-opus-5-5' && fs.existsSync(${JSON.stringify(hangFile)})) {
    setTimeout(() => process.exit(1), 6000);
    return;
  }
  if (${JSON.stringify(failModel)} === model) {
    process.stderr.write('simulated draft crash\\n');
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-' + model, model }));
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'm-' + model, role: 'assistant', content: [{ type: 'text', text: (model === 'claude-haiku-5-5' && ctl('question')) ? '<question-form id="q">{"questions":[{"id":"style","label":"Style?"}]}</question-form>' : 'done ' + model }], stop_reason: 'end_turn' } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }));
  setTimeout(() => process.exit(0), 20);
}, (model === 'claude-haiku-5-5' && fs.existsSync(${JSON.stringify(ctlDir)} + '/slow-haiku')) ? 1800 : 150);
`;
}

describe('staged drafting through POST /api/runs', () => {
  let started: StartedServer | null = null;
  let binDir: string | null = null;

  afterEach(async () => {
    prepGate.hold = null;
    const cleanupErrors: unknown[] = [];
    const cleanupStep = async (step: () => Promise<unknown>) => {
      try { await step(); } catch (error) { cleanupErrors.push(error); }
    };
    await cleanupStep(async () => {
      if (!started?.server.listening) return;
      const listed = await fetch(`${started.url}/api/runs`);
      expect(listed.status).toBe(200);
      const { runs } = await listed.json() as { runs: Array<{ id: string }> };
      // A terminal draft can still be preparing its finish stage. Stop every
      // logical chain before joining preflight work, not just running children.
      for (const run of runs) {
        await cleanupStep(async () => {
          const canceled = await fetch(`${started!.url}/api/runs/${run.id}/cancel`, { method: 'POST' });
          expect(canceled.status).toBe(200);
          await canceled.json();
        });
      }
    });
    // Canceling a Run without a child does not join its asynchronous starter.
    // Keep the fake CLI and its environment alive until actual work settles.
    await cleanupStep(async () => {
      while (startupWork.admissions.size || startupWork.starters.size) {
        await Promise.allSettled([...startupWork.admissions, ...startupWork.starters]);
      }
    });
    await cleanupStep(async () => started?.shutdown?.());
    await cleanupStep(async () => {
      if (started?.server) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    });
    started = null;
    await cleanupStep(async () => {
      if (binDir) await rm(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    binDir = null;
    vi.unstubAllEnvs();
    expect(processGuard.violations).toEqual([]);
    expect(processGuard.commands.filter(command => processGuard.agentBins.has(path.basename(command)) && command !== processGuard.fakeClaude)).toEqual([]);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Staged-drafting teardown failed');
  });

  async function boot(opts: { staged: boolean | null; failModel?: string }) {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-staged-bin-'));
    const logFile = path.join(binDir, 'models.log');
    const bin = path.join(binDir, 'claude');
    await writeFile(bin, fakeClaudeSource(logFile, opts.failModel ?? null, path.join(binDir, 'hang'), binDir), 'utf8');
    await chmod(bin, 0o755);
    // Helpers that resolve Claude outside agentCliEnv must use the fake too.
    vi.stubEnv('CLAUDE_BIN', bin);
    processGuard.fakeClaude = bin;
    processGuard.commands.length = 0;
    processGuard.violations.length = 0;
    vi.mocked(detectAgents).mockClear();
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    const put = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'claude',
        agentCliEnv: { claude: { CLAUDE_BIN: bin } },
        // The data dir outlives each server here; null clears a previous test's value.
        stagedDrafting: opts.staged,
        telemetry: { metrics: false, content: false, artifactManifest: false },
        privacyDecisionAt: Date.now(),
      }),
    });
    expect(put.status).toBe(200);
    const projectId = `staged_${randomUUID()}`;
    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Staged', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = (await created.json()) as { conversationId: string };
    return { projectId, conversationId, logFile };
  }

  async function sendTurn(ctx: { projectId: string; conversationId: string }, endpoint: '/api/runs' | '/api/chat' = '/api/runs', prompt = 'Make a pricing page') {
    const response = await fetch(`${started!.url}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        assistantMessageId: `assistant_${randomUUID()}`,
        clientRequestId: `client_${randomUUID()}`,
        agentId: 'claude',
        model: 'claude-opus-5-5',
        message: prompt,
        currentPrompt: prompt,
      }),
    });
    if (endpoint === '/api/chat') {
      expect(response.status).toBe(200);
      const runId = response.headers.get('x-od-run-id');
      await response.text();
      return runId ?? '';
    }
    expect(response.status).toBe(202);
    return ((await response.json()) as { runId: string }).runId;
  }

  async function fetchRuns(ctx: { projectId: string; conversationId: string }): Promise<StagedStatus[]> {
    const list = await (await fetch(`${started!.url}/api/runs?projectId=${ctx.projectId}&conversationId=${ctx.conversationId}`)).json() as { runs: Array<{ id: string }> };
    const runs: StagedStatus[] = [];
    for (const { id } of list.runs) {
      runs.push(await (await fetch(`${started!.url}/api/runs/${id}`)).json() as StagedStatus);
    }
    return runs;
  }

  async function settled(ctx: { projectId: string; conversationId: string }, expectRuns: number): Promise<StagedStatus[]> {
    const deadline = Date.now() + 25_000;
    let runs: StagedStatus[] = [];
    while (Date.now() < deadline) {
      runs = await fetchRuns(ctx);
      if (runs.length >= expectRuns && runs.every((r) => ['succeeded', 'failed', 'canceled'].includes(r.status))) {
        // Stage records settle a tick after their run; read them again.
        await delay(250);
        return await fetchRuns(ctx);
      }
      await delay(100);
    }
    throw new Error(`runs did not settle: ${JSON.stringify(runs.map((r) => [r.id, r.status]))}`);
  }

  const readLog = async (file: string) =>
    (await readFile(file, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { model: string; promptLen: number; finish: boolean })
      // Detection probes start the CLI without a prompt; only turns carry one.
      .filter((entry) => entry.promptLen > 0)
      .map(({ model, finish }) => ({ model, finish }));

  it('runs the draft on Haiku, then the finish on the main model, and records both', async () => {
    const ctx = await boot({ staged: true });
    const draftRunId = await sendTurn(ctx);
    const runs = await settled(ctx, 2);

    expect(await readLog(ctx.logFile)).toEqual([
      { model: 'claude-haiku-5-5', finish: false },
      { model: 'claude-opus-5-5', finish: true },
    ]);
    const draft = runs.find((r) => r.id === draftRunId)!;
    expect(vi.mocked(detectAgents)).toHaveBeenCalled();
    expect(processGuard.commands.filter(command => path.basename(command) === 'claude').length).toBeGreaterThanOrEqual(2);
    expect(processGuard.commands.filter(command => path.basename(command) === 'claude').every(command => command === processGuard.fakeClaude)).toBe(true);
    expect(draft.staged?.fallback).toBeNull();
    expect(draft.staged?.stages.map((s) => [s.stage, s.model, s.status])).toEqual([
      ['draft', 'claude-haiku-5-5', 'succeeded'],
      ['finish', 'claude-opus-5-5', 'succeeded'],
    ]);
    expect(draft.staged?.stages.every((s) => typeof s.durationMs === 'number')).toBe(true);
    const finishRunId = draft.staged!.stages[1]!.runId;
    expect(finishRunId).toBeTruthy();
    expect(runs.find((r) => r.id === finishRunId)?.staged).toEqual(draft.staged);
  }, 60_000);

  it('reconciles every child assistant row to a terminal state (V07 WARN)', async () => {
    const ctx = await boot({ staged: true });
    await sendTurn(ctx);
    const runs = await settled(ctx, 2);
    const body = await (await fetch(`${started!.url}/api/projects/${ctx.projectId}/conversations/${ctx.conversationId}/messages`)).json() as { messages: Array<{ runId?: string; runStatus?: string; endedAt?: number }> };
    const rows = body.messages.filter(row => runs.some(run => run.id === row.runId));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.runStatus)).toEqual(['succeeded', 'succeeded']);
    expect(rows.every(row => typeof row.endedAt === 'number')).toBe(true);
  }, 60_000);

  it.each(['/api/runs', '/api/chat'] as const)('%s fences the older chain only after asynchronous validation succeeds', async (endpoint) => {
    const ctx = await boot({ staged: true });
    let releaseFinish!: () => void;
    let releaseNew!: () => void;
    let finishEntered = false;
    let newerEntered = false;
    const finishGate = new Promise<void>(resolve => { releaseFinish = resolve; });
    const newerGate = new Promise<void>(resolve => { releaseNew = resolve; });
    prepGate.hold = async body => {
      if (/fast first draft/i.test(String(body.currentPrompt))) { finishEntered = true; await finishGate; }
      if (body.currentPrompt === 'Newer gated turn') { newerEntered = true; await newerGate; }
    };
    let firstId: string;
    let newer: ReturnType<typeof sendTurn> | undefined;
    try {
      firstId = await sendTurn(ctx);
      await vi.waitFor(() => expect(finishEntered).toBe(true), { timeout: 20_000 });
      newer = sendTurn(ctx, endpoint, 'Newer gated turn');
      await vi.waitFor(() => expect(newerEntered).toBe(true), { timeout: 20_000 });
      const first = await (await fetch(`${started!.url}/api/runs/${firstId}`)).json() as { staged: { stopped?: { reason: string } } };
      expect(first.staged.stopped).toBeUndefined();
      releaseNew();
      await vi.waitFor(async () => {
        const accepted = await (await fetch(`${started!.url}/api/runs/${firstId}`)).json() as { staged: { stopped?: { reason: string } } };
        expect(accepted.staged.stopped?.reason).toBe('superseded');
      }, { timeout: 20_000 });
      releaseFinish();
      await delay(300);
      const stopped = await (await fetch(`${started!.url}/api/runs/${firstId}`)).json() as StagedStatus;
      expect(stopped.staged?.stages[1]).toMatchObject({ status: 'skipped', runId: null });
    } finally {
      releaseFinish(); releaseNew();
      await newer;
    }
    const runs = await settled(ctx, 3);
    expect(runs.filter(run => run.staged?.stages[1]?.status === 'succeeded')).toHaveLength(2);
  }, 90_000);

  it('keeps cross-endpoint admissions in arrival order while an earlier request validates', async () => {
    const ctx = await boot({ staged: true });
    let release!: () => void;
    let earlierEntered = false;
    let laterEntered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    prepGate.hold = async body => {
      if (body.currentPrompt === 'Earlier queued turn') { earlierEntered = true; await gate; }
      if (body.currentPrompt === 'Later queued turn') laterEntered = true;
    };
    const earlier = sendTurn(ctx, '/api/runs', 'Earlier queued turn');
    let later: ReturnType<typeof sendTurn> | undefined;
    try {
      await vi.waitFor(() => expect(earlierEntered).toBe(true));
      later = sendTurn(ctx, '/api/chat', 'Later queued turn');
      await delay(200);
      expect(laterEntered).toBe(false);
    } finally { release(); await earlier; await later; }
    expect(laterEntered).toBe(true);
  }, 60_000);

  it.each(['/api/runs', '/api/chat'] as const)('%s leaves the prior chain alive after late 400/409 rejection', async endpoint => {
    const ctx = await boot({ staged: true });
    await writeFile(path.join(binDir!, 'hang-haiku'), '');
    const firstId = await sendTurn(ctx);
    const messages = await (await fetch(`${started!.url}/api/projects/${ctx.projectId}/conversations/${ctx.conversationId}/messages`)).json() as { messages: Array<{ id: string; runId?: string }> };
    const assistantMessageId = messages.messages.find(row => row.runId === firstId)!.id;
    for (const [overrides, status] of [[{ agentId: 'unknown-agent' }, 400], [{ assistantMessageId }, 409]] as const) {
      const rejected = await fetch(`${started!.url}${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ ...ctx, assistantMessageId: `assistant_${randomUUID()}`, clientRequestId: `client_${randomUUID()}`, agentId: 'claude', model: 'claude-opus-5-5', message: 'Rejected turn', currentPrompt: 'Rejected turn' }, overrides)),
      });
      expect(rejected.status).toBe(status);
      const prior = await (await fetch(`${started!.url}/api/runs/${firstId}`)).json() as { staged: { stopped?: unknown } };
      expect(prior.staged.stopped).toBeUndefined();
    }
    await rm(path.join(binDir!, 'hang-haiku'));
    await fetch(`${started!.url}/api/runs/${firstId}/cancel`, { method: 'POST' });
  }, 60_000);

  it('falls back to one main-model pass and says so when the draft fails', async () => {
    const ctx = await boot({ staged: true, failModel: 'claude-haiku-5-5' });
    const draftRunId = await sendTurn(ctx);
    const runs = await settled(ctx, 2);

    expect((await readLog(ctx.logFile)).map((e) => e.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    const draft = runs.find((r) => r.id === draftRunId)!;
    expect(draft.status).toBe('failed');
    expect(draft.staged?.fallback).toMatchObject({ reason: 'draft_failed' });
    const stage = draft.staged!.stages.find((s) => s.stage === 'single')!;
    expect(stage).toMatchObject({ model: 'claude-opus-5-5', status: 'succeeded' });
  }, 60_000);

  it('does nothing different when the switch is off', async () => {
    const ctx = await boot({ staged: null });
    const runId = await sendTurn(ctx);
    const runs = await settled(ctx, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.staged).toBeUndefined();
    expect((await readLog(ctx.logFile)).map((e) => e.model)).toEqual(['claude-opus-5-5']);
  }, 60_000);

  it('stages /api/chat turns too (the path users run)', async () => {
    const ctx = await boot({ staged: true });
    await sendTurn(ctx, '/api/chat');
    const runs = await settled(ctx, 2);
    expect(await readLog(ctx.logFile)).toEqual([
      { model: 'claude-haiku-5-5', finish: false },
      { model: 'claude-opus-5-5', finish: true },
    ]);
    const draft = runs.find((r) => r.staged?.stages[0]?.runId === r.id)!;
    expect(draft.staged?.stages.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
  }, 60_000);

  it('after a restart marks the run draft-only and Finish now starts the finishing pass', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(path.join(binDir!, 'hang'), '1');
    const draftRunId = await sendTurn(ctx);
    // Wait until the finishing pass has started (and is hanging), then "crash".
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const log = await readLog(ctx.logFile).catch(() => []);
      if (log.some((e) => e.model === 'claude-opus-5-5')) break;
      await delay(100);
    }
    await Promise.resolve(started!.shutdown?.());
    await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;

    const after = await (await fetch(`${started.url}/api/runs/${draftRunId}`)).json() as StagedStatus & {
      staged?: { interrupted?: { message: string } | null };
    };
    
    expect(after.staged?.interrupted?.message).toBe('Draft only — finishing pass interrupted');
    expect(after.staged?.stages.map((s) => s.status)).toEqual(['succeeded', 'interrupted']);

    await rm(path.join(binDir!, 'hang'), { force: true });
    const finish = await fetch(`${started.url}/api/runs/${draftRunId}/staged/finish`, { method: 'POST' });
    expect(finish.status).toBe(202);
    const deadline2 = Date.now() + 20_000;
    let done: StagedStatus | null = null;
    let lastSeen = '';
    while (Date.now() < deadline2) {
      const status = await (await fetch(`${started.url}/api/runs/${draftRunId}`)).json() as StagedStatus;
      if (status.staged?.stages[1]?.status === 'succeeded') { done = status; break; }
      lastSeen = JSON.stringify(status.staged);
      await delay(150);
    }
    expect(done?.staged?.stages[1]?.status, lastSeen).toBe('succeeded');
    expect((done?.staged as { interrupted?: unknown } | undefined)?.interrupted ?? null).toBeNull();
    const again = await fetch(`${started.url}/api/runs/${draftRunId}/staged/finish`, { method: 'POST' });
    expect(again.status).toBe(409);
  }, 90_000);

  const ctlFile = (name: string) => path.join(binDir!, name);
  const cancelRun = (id: string) => fetch(`${started!.url}/api/runs/${id}/cancel`, { method: 'POST' });
  async function waitForLog(file: string, predicate: (log: Array<{ model: string }>) => boolean) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const log = await readLog(file).catch(() => []);
      if (predicate(log)) return log;
      await delay(80);
    }
    throw new Error('log never reached the expected state');
  }

  it('cancelling during the draft prevents the finishing pass', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(ctlFile('hang-haiku'), '1');
    const draftRunId = await sendTurn(ctx);
    await waitForLog(ctx.logFile, (log) => log.some((e) => e.model === 'claude-haiku-5-5'));
    expect((await cancelRun(draftRunId)).status).toBe(200);
    const runs = await settled(ctx, 1);
    await delay(500);
    expect((await readLog(ctx.logFile)).map((e) => e.model)).toEqual(['claude-haiku-5-5']);
    const draft = (await fetchRuns(ctx)).find((r) => r.id === draftRunId)!;
    expect(draft.status).toBe('canceled');
    expect(draft.staged?.stages.map((x) => x.status)).toEqual(['canceled', 'skipped']);
    expect((draft.staged as { stopped?: { reason: string } }).stopped?.reason).toBe('canceled');
    expect(runs).toHaveLength(1);
  }, 60_000);

  it('cancelling the turn while the finishing pass runs stops that pass', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(ctlFile('hang'), '1');
    const draftRunId = await sendTurn(ctx);
    await waitForLog(ctx.logFile, (log) => log.some((e) => e.model === 'claude-opus-5-5'));
    // The client only knows the draft run id; cancelling it must reach the finish.
    expect((await cancelRun(draftRunId)).status).toBe(200);
    const runs = await settled(ctx, 2);
    const draft = runs.find((r) => r.id === draftRunId)!;
    expect(draft.staged?.stages.map((x) => x.status)).toEqual(['succeeded', 'canceled']);
    expect((draft.staged as { stopped?: { reason: string } }).stopped?.reason).toBe('canceled');
    const finishId = draft.staged!.stages[1]!.runId!;
    expect(runs.find((r) => r.id === finishId)?.status).toBe('canceled');
  }, 60_000);

  it('a draft that asks a question gets no finishing pass, and the next turn starts a fresh chain', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(ctlFile('question'), '1');
    const draftRunId = await sendTurn(ctx);
    await settled(ctx, 1);
    await delay(600);
    expect((await readLog(ctx.logFile)).map((e) => e.model)).toEqual(['claude-haiku-5-5']);
    const first = (await fetchRuns(ctx)).find((r) => r.id === draftRunId)!;
    expect((first.staged as { stopped?: { reason: string } }).stopped?.reason).toBe('question_form');
    expect(first.staged?.stages[1]?.status).toBe('skipped');

    await rm(ctlFile('question'), { force: true });
    const secondId = await sendTurn(ctx);
    const runs = await settled(ctx, 3);
    const second = runs.find((r) => r.id === secondId)!;
    expect(second.staged?.stages.map((x) => x.status)).toEqual(['succeeded', 'succeeded']);
    expect(second.staged).not.toEqual(first.staged);
    expect((await readLog(ctx.logFile)).map((e) => e.model)).toEqual([
      'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-opus-5-5',
    ]);
  }, 90_000);

  it('a newer turn drops a pending finish and records it as superseded', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(ctlFile('slow-haiku'), '1');
    const firstId = await sendTurn(ctx);
    const startedAt = Date.now() + 15_000;
    while (Date.now() < startedAt && !(await readFile(ctx.logFile + '.start', 'utf8').catch(() => '')).includes('haiku')) await delay(50);
    // Newer turn arrives while turn 1's draft is still running.
    await rm(ctlFile('slow-haiku'), { force: true });
    const secondId = await sendTurn(ctx);
    const runs = await settled(ctx, 3);
    const first = runs.find((r) => r.id === firstId)!;
        expect((first.staged as { stopped?: { reason: string } }).stopped?.reason).toBe('superseded');
    expect(first.staged?.stages.map((x) => x.status)).toEqual(['succeeded', 'skipped']);
    const second = runs.find((r) => r.id === secondId)!;
    expect(second.staged?.stages.map((x) => x.status)).toEqual(['succeeded', 'succeeded']);
    // Turn 1's finish never ran: one Opus pass in total, and it was turn 2's.
    expect((await readLog(ctx.logFile)).filter((e) => e.model === 'claude-opus-5-5')).toHaveLength(1);
  }, 90_000);

  it('a newer turn stops a finishing pass that is already running, so passes never overlap', async () => {
    const ctx = await boot({ staged: true });
    await writeFile(ctlFile('hang'), '1');
    const firstId = await sendTurn(ctx);
    await waitForLog(ctx.logFile, (log) => log.some((e) => e.model === 'claude-opus-5-5'));
    await rm(ctlFile('hang'), { force: true });
    const secondId = await sendTurn(ctx);
    const runs = await settled(ctx, 4);
    const first = runs.find((r) => r.id === firstId)!;
    expect((first.staged as { stopped?: { reason: string } }).stopped?.reason).toBe('superseded');
    expect(first.staged?.stages[1]?.status).toBe('canceled');
    expect(runs.find((r) => r.id === secondId)?.staged?.stages.map((x) => x.status)).toEqual(['succeeded', 'succeeded']);
  }, 90_000);
});
