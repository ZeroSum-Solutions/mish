// GET /api/agents (non-stream) re-probed every agent CLI on each call, so
// `od` and any other non-stream caller waited 4-7 s per request (audit item
// L1, 2026-10-09). The listing must reuse a recent probe instead.
//
// `registerStaticResourceRoutes` is mounted on a bare Express app with a stub
// context: only the agents route runs here, and it reads nothing but the data
// root from the context. Detection is replaced with a counting fake so the
// spec observes probes, not real CLIs.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detection = vi.hoisted(() => ({
  probes: 0,
  gate: null as Promise<void> | null,
  envs: [] as unknown[],
  options: [] as unknown[],
}));

vi.mock('../src/agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents.js')>();
  return {
    ...actual,
    detectAgents: vi.fn(async (env: unknown, options: unknown) => {
      detection.probes += 1;
      detection.envs.push(env);
      detection.options.push(options);
      const probe = detection.probes;
      if (detection.gate) await detection.gate;
      return [{ id: 'claude', name: 'Claude Code', available: true, models: [], probe }];
    }),
    detectAgentsStream: vi.fn(async function* (_env: unknown, options: unknown) {
      detection.options.push(options);
      yield { id: 'claude', name: 'Claude Code', available: true, models: [] };
    }),
  };
});

import { writeAppConfig } from '../src/app-config.js';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';
import { createAgentListCache } from '../src/runtimes/agents-list-cache.js';

let server: http.Server;
let baseUrl: string;
let dataDir: string;

function stubContext(runtimeDataDir: string): Parameters<typeof registerStaticResourceRoutes>[1] {
  return {
    upstreamCloudEnabled: true,
    db: {},
    paths: { RUNTIME_DATA_DIR: runtimeDataDir },
    resources: {},
    http: {
      isLocalSameOrigin: () => true,
      resolvedPortRef: { current: 0 },
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: code, message }),
    },
  } as unknown as Parameters<typeof registerStaticResourceRoutes>[1];
}

async function getAgents(query = ''): Promise<{ agents: Array<{ probe: number }> }> {
  const response = await fetch(`${baseUrl}/api/agents${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { agents: Array<{ probe: number }> };
}

beforeEach(async () => {
  detection.probes = 0;
  detection.gate = null;
  detection.envs = [];
  detection.options = [];
  dataDir = await mkdtemp(join(tmpdir(), 'od-agents-route-cache-'));
  const app = express();
  registerStaticResourceRoutes(app, stubContext(dataDir));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /api/agents (non-stream) probe reuse', () => {
  it('D18 forwards the cloud registry option through batch and stream routes', async () => {
    await getAgents();
    const response = await fetch(`${baseUrl}/api/agents?stream=1`);
    await response.text();
    expect(detection.options).toEqual([
      { upstreamCloudEnabled: true }, { upstreamCloudEnabled: true },
    ]);
  });

  it('probes the agent CLIs once for two back-to-back calls', async () => {
    const first = await getAgents();
    const second = await getAgents();
    expect(detection.probes).toBe(1);
    expect(second.agents).toEqual(first.agents);
  });

  it('re-probes after a live stream probe has run', async () => {
    expect((await getAgents()).agents[0]?.probe).toBe(1);
    const stream = await fetch(`${baseUrl}/api/agents?stream=1`);
    expect(await stream.text()).toContain('event: done');
    expect((await getAgents()).agents[0]?.probe).toBe(2);
  });

  it('re-probes on ?refresh=1 and serves the refreshed answer afterwards', async () => {
    await getAgents();
    const refreshed = await getAgents('?refresh=1');
    expect(detection.probes).toBe(2);
    expect(refreshed.agents[0]?.probe).toBe(2);
    const after = await getAgents();
    expect(detection.probes).toBe(2);
    expect(after.agents[0]?.probe).toBe(2);
  });

  it('re-probes when the configured agent CLI env changes', async () => {
    await getAgents();
    await writeAppConfig(dataDir, { agentCliEnv: { claude: { CLAUDE_BIN: '/opt/custom/claude' } } });
    await getAgents();
    expect(detection.probes).toBe(2);
    expect(detection.envs[1]).toEqual({ claude: { CLAUDE_BIN: '/opt/custom/claude' } });
    await getAgents();
    expect(detection.probes).toBe(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    let open!: () => void;
    detection.gate = new Promise<void>((resolve) => { open = resolve; });
    const calls = [getAgents(), getAgents(), getAgents()];
    await vi.waitFor(() => expect(detection.probes).toBe(1));
    open();
    const bodies = await Promise.all(calls);
    expect(detection.probes).toBe(1);
    for (const body of bodies) expect(body.agents[0]?.probe).toBe(1);
  });
});

describe('createAgentListCache', () => {
  it('re-probes once the TTL has elapsed', async () => {
    let now = 1_000;
    let probes = 0;
    const cache = createAgentListCache({
      detect: async () => ++probes,
      ttlMs: 30_000,
      now: () => now,
      pathEnv: () => '/usr/bin',
    });
    expect(await cache.get({})).toBe(1);
    now += 30_000;
    expect(await cache.get({})).toBe(1);
    now += 1;
    expect(await cache.get({})).toBe(2);
    expect(probes).toBe(2);
  });

  it('does not keep a failed probe as the answer', async () => {
    let probes = 0;
    const cache = createAgentListCache({
      detect: async () => {
        probes += 1;
        if (probes === 1) throw new Error('probe crashed');
        return probes;
      },
      now: () => 0,
      pathEnv: () => '/usr/bin',
    });
    await expect(cache.get({})).rejects.toThrow('probe crashed');
    expect(await cache.get({})).toBe(2);
    expect(await cache.get({})).toBe(2);
  });

  it('re-probes when PATH changes', async () => {
    let pathValue = '/usr/bin';
    let probes = 0;
    const cache = createAgentListCache({
      detect: async () => ++probes,
      now: () => 0,
      pathEnv: () => pathValue,
    });
    await cache.get({});
    pathValue = '/usr/bin:/opt/new/bin';
    expect(await cache.get({})).toBe(2);
  });

  it('never caches the stale answer of an older probe that settles after a refresh', async () => {
    const releases: Array<(value: string) => void> = [];
    const cache = createAgentListCache<string>({
      detect: () => new Promise<string>((resolve) => { releases.push(resolve); }),
      now: () => 0,
      pathEnv: () => '/usr/bin',
    });
    const stale = cache.get({});
    const fresh = cache.get({}, { refresh: true });
    releases[1]?.('fresh');
    expect(await fresh).toBe('fresh');
    expect(await cache.get({})).toBe('fresh');
    // The older probe settles last and has rewritten the remembered models,
    // so the refreshed listing no longer matches them: the next call probes.
    releases[0]?.('stale');
    expect(await stale).toBe('stale');
    const next = cache.get({});
    expect(releases).toHaveLength(3);
    releases[2]?.('reprobed');
    expect(await next).toBe('reprobed');
  });

  it('drops the listing and an in-flight probe on invalidate', async () => {
    const releases: Array<(value: string) => void> = [];
    const cache = createAgentListCache<string>({
      detect: () => new Promise<string>((resolve) => { releases.push(resolve); }),
      now: () => 0,
      pathEnv: () => '/usr/bin',
    });
    const first = cache.get({});
    releases[0]?.('one');
    expect(await first).toBe('one');
    cache.invalidate();
    const inflight = cache.get({});
    expect(releases).toHaveLength(2);
    cache.invalidate();
    const after = cache.get({});
    expect(releases).toHaveLength(3);
    releases[1]?.('detached');
    releases[2]?.('three');
    expect(await inflight).toBe('detached');
    expect(await after).toBe('three');
    expect(await cache.get({})).toBe('three');
  });
});
