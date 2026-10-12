import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('CLI group help', () => {
  it.each(['--help', '-h'])('version %s prints usage without a daemon', async (flag) => {
    const { stdout, stderr } = await exec(process.execPath, [tsx, cli, 'version', flag], {
      env: { ...process.env, OD_DAEMON_URL: 'http://127.0.0.1:1' },
      timeout: 10000,
    });
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('od version');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('--daemon-url');
    expect(stderr).toBe('');
  });

  it.each(['library', 'artifacts', 'tools', 'tools connectors', 'tools design-systems', 'tools live-artifacts', 'tools deliverable-syntax'])('%s --help succeeds without a daemon', async (group) => {
    const { stdout, stderr } = await exec(process.execPath, [tsx, cli, ...group.split(' '), '--help'], {
      env: { ...process.env, OD_DAEMON_URL: 'http://127.0.0.1:1' },
      timeout: 10000,
    });
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain(`od ${group}`);
    expect(stderr).toBe('');
  });

  it.each([
    ['library', 2],
    ['artifacts', 1],
    ['tools', 2],
    ['library bogus', 2],
    ['artifacts bogus', 1],
    ['tools bogus', 2],
  ] as const)('%s still rejects missing or invalid commands', async (command, code) => {
    await expect(exec(process.execPath, [tsx, cli, ...command.split(' ')], {
      env: { ...process.env, OD_DAEMON_URL: 'http://127.0.0.1:1' },
      timeout: 10000,
    })).rejects.toMatchObject({ code });
  });
});


describe('CLI automation creation dispatch', () => {
  it.each([
    { label: 'without optional context', flags: [], context: undefined, skillId: undefined },
    {
      label: 'with deduplicated context',
      flags: ['--skill', ' alpha,alpha,beta ', '--plugin', 'plugin-a,plugin-a', '--mcp', 'mcp-a', '--connector', 'connector-a,connector-b'],
      context: { skillIds: ['alpha', 'beta'], pluginIds: ['plugin-a'], mcpServerIds: ['mcp-a'], connectorIds: ['connector-a', 'connector-b'] },
      skillId: 'alpha',
    },
  ])('automation create $label reaches the daemon with the selected context', async ({ flags, context, skillId }) => {
    const seen: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        seen.push({ method: request.method, path: request.url, body: parsed });
        response.writeHead(request.method === 'POST' && request.url === '/api/routines' ? 201 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ routine: { id: 'routine-cli-dispatch', ...parsed } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected mock HTTP listening address');
    const daemonUrl = `http://127.0.0.1:${address.port}`;
    const home = await mkdtemp(join(tmpdir(), 'od-automation-cli-dispatch-'));
    try {
      const { stdout, stderr } = await exec(process.execPath, [
        tsx, cli, 'automation', 'create', '--name', 'Synthetic automation',
        '--prompt', 'Synthetic fixture; never execute', '--schedule', 'weekly:sun:23:59:UTC',
        '--target', 'reuse=synthetic-project', '--disabled', ...flags, '--json', '--daemon-url', daemonUrl,
      ], { env: { PATH: process.env.PATH, HOME: home, OD_DATA_DIR: home, OD_DAEMON_URL: daemonUrl }, timeout: 10000 });
      const expectedBody = {
        name: 'Synthetic automation', prompt: 'Synthetic fixture; never execute',
        schedule: { kind: 'weekly', weekday: 0, time: '23:59', timezone: 'UTC' },
        target: { mode: 'reuse', projectId: 'synthetic-project' }, enabled: false,
        ...(context ? { context } : {}), ...(skillId ? { skillId } : {}),
      };
      expect(stderr).toBe('');
      expect(seen).toEqual([{ method: 'POST', path: '/api/routines', body: expectedBody }]);
      expect(JSON.parse(stdout)).toEqual({ routine: { id: 'routine-cli-dispatch', ...expectedBody } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
