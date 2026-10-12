// Page-load latency (team release Track B): Home asks for `/api/design-systems`
// in the same burst as `/api/agents?stream=1`. The design-system listing alone
// answers in ~0.1 s, yet during that burst it took 5-13 s on a teammate's
// machine. CPU profiling of the daemon showed the event loop blocked in
// `spawnSync`: every agent probe resolved the macOS system proxy through a
// synchronous `scutil --proxy` shell-out, twice per agent, so detection of ~25
// agents froze the daemon for as long as those shell-outs took.
//
// This spec reproduces that with a fake `scutil` that sleeps and fake agent
// CLIs that sleep: the listing must still answer within a second while
// detection is in flight. The proxy shell-out only exists on macOS, so the
// timing half runs on macOS only; the cache halves run on every platform.

import type http from 'node:http';
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../../src/server.js';
import { createSystemProxyEnvCache } from '../../src/runtimes/env.js';

const AGENT_BINS = [
  'agy', 'aider', 'amp', 'atomcode', 'claude', 'codebuddy', 'codex', 'copilot',
  'cursor-agent', 'deepseek', 'devin', 'dsh', 'grok', 'hermes', 'kilo', 'kimi',
  'kiro-cli', 'mimo', 'opencode-cli', 'pi', 'qodercli', 'qwen', 'reasonix',
  'traecli', 'vela', 'vibe-acp',
];
const KIT_COUNT = 60;
const SCUTIL_DELAY_SECONDS = '0.15';

describe('system proxy env cache', () => {
  it('resolves the OS proxy once per TTL however many agents spawn', () => {
    let resolves = 0;
    let now = 1_000;
    const cache = createSystemProxyEnvCache({
      resolve: () => {
        resolves += 1;
        return { HTTPS_PROXY: `http://proxy-${resolves}:8080` };
      },
      ttlMs: 30_000,
      now: () => now,
    });
    for (let i = 0; i < 52; i += 1) cache.get();
    expect(resolves).toBe(1);
    expect(cache.get()).toEqual({ HTTPS_PROXY: 'http://proxy-1:8080' });
    now += 30_001;
    expect(cache.get()).toEqual({ HTTPS_PROXY: 'http://proxy-2:8080' });
    expect(resolves).toBe(2);
  });
});

describe('system proxy env cache clock', () => {
  it('measures its TTL on a monotonic clock, so a wall-clock jump back cannot pin a stale proxy', async () => {
    let resolves = 0;
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    const cache = createSystemProxyEnvCache({
      resolve: () => {
        resolves += 1;
        return {};
      },
      ttlMs: 1,
    });
    try {
      cache.get();
      // The wall clock is corrected an hour backwards after the value is cached.
      wallClock.mockReturnValue(10_000_000 - 3_600_000);
      await new Promise((settle) => setTimeout(settle, 5));
      cache.get();
      expect(resolves).toBe(2);
    } finally {
      wallClock.mockRestore();
    }
  });
});

// The regression is the synchronous macOS `scutil` shell-out. Elsewhere proxy
// discovery never runs it, so the timing would only measure the host's
// scheduling speed under dozens of probes; run it where it means something.
describe.skipIf(process.platform !== 'darwin')('page-load burst: design-system listing vs agent detection', () => {
  let server: http.Server;
  let baseUrl: string;
  let binDir: string;
  const originalPath = process.env.PATH;
  const kitDirs: string[] = [];

  beforeAll(async () => {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required');
    for (let i = 0; i < KIT_COUNT; i += 1) {
      const dir = resolve(dataDir, 'design-systems', `latency-kit-${i}`);
      kitDirs.push(dir);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        join(dir, 'DESIGN.md'),
        [
          `# Latency Kit ${i}`,
          '',
          '> Category: Product',
          '',
          'A fixture kit for the page-load latency spec.',
          '',
          '## Color Palette',
          ...Array.from({ length: 12 }, (_, n) => `- Tone ${n} #${(0x101010 * (n + 1)).toString(16).padStart(6, '0').slice(0, 6)}`),
          '',
          '## Typography',
          '- Display: Fraunces',
          '- Body: Inter',
        ].join('\n'),
        'utf8',
      );
    }
    binDir = await fsp.mkdtemp(join(tmpdir(), 'od-pageload-bin-'));
    // A slow `scutil`: macOS proxy discovery shells out to it by PATH lookup.
    await fsp.writeFile(
      join(binDir, 'scutil'),
      `#!/bin/sh\nsleep ${SCUTIL_DELAY_SECONDS}\nprintf '<dictionary> {\\n}\\n'\n`,
    );
    // Fake agent CLIs that sleep: probes stay in flight, costing no CPU.
    for (const bin of AGENT_BINS) {
      await fsp.writeFile(join(binDir, bin), '#!/bin/sh\nsleep 2\necho 1.0.0\n');
    }
    for (const name of [...AGENT_BINS, 'scutil']) await fsp.chmod(join(binDir, name), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await new Promise<void>((done) => server?.close(() => done()));
    try {
      const out = execFileSync('pgrep', ['-f', binDir], { encoding: 'utf8' });
      for (const pid of out.split('\n').map(Number).filter((n) => n > 0)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    } catch { /* none left */ }
    await fsp.rm(binDir, { recursive: true, force: true });
    for (const dir of kitDirs) await fsp.rm(dir, { recursive: true, force: true });
  });

  it('answers the design-system listing within a second while agents are being detected', async () => {
    // Warm the listing once so the measurement is about contention, not a
    // cold first read.
    const warm = await fetch(`${baseUrl}/api/design-systems`);
    expect(warm.ok).toBe(true);

    const controller = new AbortController();
    const agents = fetch(`${baseUrl}/api/agents?stream=1`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    }).then(async (response) => {
      // Drain so the stream never back-pressures the daemon.
      const reader = response.body?.getReader();
      while (reader) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).catch(() => undefined);
    // Let detection start its probes, as it does on a real page load.
    await new Promise((settle) => setTimeout(settle, 50));

    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/design-systems`);
    const body = await response.json() as { designSystems: Array<{ id: string }> };
    const elapsedMs = performance.now() - startedAt;

    controller.abort();
    await agents;

    expect(response.ok).toBe(true);
    expect(body.designSystems.filter((s) => s.id.startsWith('user:latency-kit-'))).toHaveLength(KIT_COUNT);
    expect(elapsedMs).toBeLessThan(1_000);
  }, 60_000);
});
