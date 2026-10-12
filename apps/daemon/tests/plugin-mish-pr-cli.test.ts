import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

// `od plugin mish-pr` submits a community plugin to the public catalog
// repository. Outside contributors cannot push branches there, so the flow
// must go through the author's fork and open the PR from `<owner>:<branch>`.
// A stub `gh` answers the authentication probe; --dry-run records the planned
// steps without running git or gh against the network.
describe('od plugin mish-pr', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mish-pr-cli-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const gh = join(bin, 'gh');
    await writeFile(
      gh,
      [
        '#!/bin/sh',
        'if [ "$1" = "auth" ]; then echo "Logged in to github.com account alice (keyring)" >&2; exit 0; fi',
        'echo "gh version 2.0.0"',
        'exit 0',
        '',
      ].join('\n'),
    );
    await chmod(gh, 0o755);
    const plugin = join(root, 'my-plugin');
    await mkdir(plugin);
    await writeFile(
      join(plugin, 'mish.json'),
      JSON.stringify({ name: 'my-plugin', title: 'My Plugin', version: '1.0.0' }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('forks the public catalog repository and opens the PR from the fork', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      SHELL: '/bin/sh',
    };
    delete env.NODE_OPTIONS;
    const { stdout } = await execFileP(
      process.execPath,
      [TSX_CLI, CLI_SRC, 'plugin', 'mish-pr', join(root, 'my-plugin'), '--dry-run', '--json'],
      { cwd: DAEMON_ROOT, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      ok: boolean;
      owner: string;
      branch: string;
      prUrl: string;
      steps: Array<{ label: string; command: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.owner).toBe('alice');
    const commands = result.steps.map((step) => step.command);
    expect(commands).toContain('gh repo fork ZeroSum-Solutions/mish --clone=false');
    expect(commands.some((c) => c.includes('https://github.com/ZeroSum-Solutions/mish.git'))).toBe(true);
    expect(commands).toContain(`git push -u fork ${result.branch}`);
    expect(commands.some((c) => c.startsWith('git push') && c.includes(' origin '))).toBe(false);
    const prCreate = commands.find((c) => c.startsWith('gh pr create'));
    expect(prCreate).toContain('--repo ZeroSum-Solutions/mish');
    expect(prCreate).toContain(`--head alice:${result.branch}`);
    expect(result.prUrl).toBe(
      `https://github.com/ZeroSum-Solutions/mish/compare/main...alice:${result.branch}?expand=1`,
    );
    expect(stdout).not.toMatch(/Mishh-Mashh-2/);
  }, 40_000);

  async function dryRun(extra: string[]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      SHELL: '/bin/sh',
    };
    delete env.NODE_OPTIONS;
    const { stdout } = await execFileP(
      process.execPath,
      [TSX_CLI, CLI_SRC, 'plugin', 'mish-pr', join(root, 'my-plugin'), '--dry-run', '--json', ...extra],
      { cwd: DAEMON_ROOT, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as { branch: string; steps: Array<{ command: string }> };
    return { branch: result.branch, commands: result.steps.map((step) => step.command) };
  }

  it('forks into an org named by --owner, comparing logins case-insensitively', async () => {
    const asLogin = await dryRun(['--owner', 'Alice']);
    expect(asLogin.commands).toContain('gh repo fork ZeroSum-Solutions/mish --clone=false');
    const asOrg = await dryRun(['--owner', 'acme']);
    expect(asOrg.commands).toContain('gh repo fork ZeroSum-Solutions/mish --clone=false --org acme');
    expect(asOrg.commands.find((c) => c.startsWith('gh pr create'))).toContain(`--head acme:${asOrg.branch}`);
  }, 60_000);

  it('does not try to fork the catalog into its own org', async () => {
    const { commands } = await dryRun(['--owner', 'ZeroSum-Solutions']);
    expect(commands.some((c) => c.startsWith('gh repo fork'))).toBe(false);
    expect(commands).toContain('git remote add fork https://github.com/ZeroSum-Solutions/mish.git');
  }, 60_000);
});
