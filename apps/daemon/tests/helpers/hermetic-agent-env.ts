/**
 * Hermetic process environment for daemon tests.
 *
 * Invariants for every daemon test worker:
 * - `PATH` holds only the fixture bin dir (node and its package managers) and
 *   the system dirs, and `HOME` is a temporary directory, so detection cannot
 *   find the developer's installed agent CLIs or read their configs.
 * - A spawn of a known agent binary that resolves outside the allowed roots
 *   (OS temp dir, this repository, the fixture bin dir) is refused: it fails
 *   like a missing binary (ENOENT) and the test file fails in `afterAll`.
 *
 * Tests that need a fake agent write it under a temp dir or the fixture bin
 * dir (`OD_TEST_FIXTURE_BIN_DIR`) and put that dir on PATH themselves.
 */
import childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent CLI basenames the guard refuses outside the allowed roots. Kept static
 * on purpose: importing the runtime registry here would load daemon modules
 * before HOME is replaced. tests/hermetic-agent-env.test.ts checks that every
 * registry `bin` and `fallbackBins` entry is listed.
 */
export const AGENT_BIN_NAMES: readonly string[] = [
  'agy', 'aider', 'amp', 'atomcode', 'auggie', 'cbc', 'claude', 'cline', 'codebuddy', 'codewhale',
  'codex', 'copilot', 'crush', 'cursor-agent', 'deepseek', 'devin', 'droid', 'dsh', 'dsnix',
  'gemini', 'goose', 'grok', 'hermes', 'kilo', 'kimi', 'kimi-code', 'kiro-cli', 'mimo',
  'openclaude', 'opencode', 'opencode-cli', 'pi', 'qodercli', 'qwen', 'reasonix', 'traecli',
  'vela', 'vibe-acp',
];

export const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const STATE_SYMBOL = Symbol.for('mish.daemon.vitestHermeticAgentEnv');

type BlockedSpawn = { command: string; resolved: string; via: string };

type HermeticState = {
  allowedRoots: string[];
  agentBins: Set<string>;
  blocked: BlockedSpawn[];
  fixtureBinDir: string;
  homeDir: string;
  root: string;
};

const globalState = globalThis as typeof globalThis & { [STATE_SYMBOL]?: HermeticState };

function safeRealpath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function linkPackageManagers(binDir: string): void {
  const nodeDir = path.dirname(process.execPath);
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  for (const name of ['npm', 'npx', 'pnpm', 'pnpx', 'corepack']) {
    const candidate = path.join(nodeDir, name);
    if (existsSync(candidate)) symlinkSync(candidate, path.join(binDir, name));
  }
}

function createState(repoRoot: string): HermeticState {
  const root = mkdtempSync(path.join(os.tmpdir(), 'od-daemon-vitest-env-'));
  const homeDir = path.join(root, 'home');
  const fixtureBinDir = path.join(root, 'bin');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(fixtureBinDir, { recursive: true });
  if (process.platform !== 'win32') linkPackageManagers(fixtureBinDir);
  // Tests that commit to scratch repos need an identity; the real one lives in
  // the developer's home, which tests must not read.
  writeFileSync(
    path.join(homeDir, '.gitconfig'),
    '[user]\n\tname = Mish Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n',
  );
  process.once('exit', () => rmSync(root, { force: true, recursive: true }));
  return {
    allowedRoots: [safeRealpath(os.tmpdir()), safeRealpath(repoRoot), safeRealpath(fixtureBinDir), safeRealpath(root)],
    agentBins: new Set(AGENT_BIN_NAMES),
    blocked: [],
    fixtureBinDir,
    homeDir,
    root,
  };
}

function applyEnv(state: HermeticState): void {
  if (process.platform !== 'win32') {
    process.env.PATH = [state.fixtureBinDir, ...SYSTEM_PATH_DIRS].join(path.delimiter);
  }
  process.env.HOME = state.homeDir;
  process.env.USERPROFILE = state.homeDir;
  process.env.XDG_CONFIG_HOME = path.join(state.homeDir, '.config');
  process.env.XDG_DATA_HOME = path.join(state.homeDir, '.local', 'share');
  process.env.XDG_CACHE_HOME = path.join(state.homeDir, '.cache');
  process.env.XDG_STATE_HOME = path.join(state.homeDir, '.local', 'state');
  process.env.OD_TEST_FIXTURE_BIN_DIR = state.fixtureBinDir;
  // Detection also searches well-known toolchain dirs (Homebrew, /usr/local,
  // version-manager bins) beyond PATH. OD_AGENT_HOME scopes that search to the
  // temp home and drops the system dirs (src/runtimes/executables.ts).
  process.env.OD_AGENT_HOME = state.homeDir;
  // Integration homes would point probes back at the developer's real config.
  for (const key of ['CODEX_HOME', 'GEMINI_CLI_HOME', 'KIMI_HOME', 'HERMES_HOME', 'GROK_HOME']) {
    delete process.env[key];
  }
  // startServer() must not warm agent detection under test (server.ts).
  process.env.OD_SKIP_AGENT_DETECTION_WARMUP = '1';
}

function commandBaseName(command: string): string {
  return path.basename(command).replace(/\.(?:exe|cmd|bat|ps1)$/iu, '');
}

function envValue(envPairs: string[] | undefined, key: string): string | undefined {
  if (!envPairs) return process.env[key];
  const prefix = `${key}=`;
  for (let index = envPairs.length - 1; index >= 0; index -= 1) {
    const pair = envPairs[index];
    if (pair?.startsWith(prefix)) return pair.slice(prefix.length);
  }
  return undefined;
}

function resolveCommand(command: string, pathValue: string | undefined, cwd: string | undefined): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return path.resolve(cwd ?? process.cwd(), command);
  }
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep walking PATH.
    }
  }
  return null;
}

/** The program a `sh -c "<script>"` launch runs first, when it is a plain word. */
function shellScriptProgram(file: string, args: readonly string[]): string | null {
  if (!/^(?:sh|bash|zsh|dash)$/u.test(commandBaseName(file))) return null;
  const flagIndex = args.indexOf('-c');
  const script = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const first = script?.trim().split(/\s+/u)[0]?.replace(/^['"]|['"]$/gu, '');
  return first ? first : null;
}

function isAllowed(state: HermeticState, resolved: string): boolean {
  const real = safeRealpath(resolved);
  return state.allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))
    || state.allowedRoots.some((root) => resolved.startsWith(`${root}${path.sep}`));
}

/** Returns the blocked spawn when `file` is a real agent binary outside the allowed roots. */
export function classifyAgentSpawn(
  file: string,
  args: readonly string[],
  envPairs: string[] | undefined,
  cwd: string | undefined,
): BlockedSpawn | null {
  const state = globalState[STATE_SYMBOL];
  if (!state) return null;
  const candidates = [file, shellScriptProgram(file, args)].filter((value): value is string => Boolean(value));
  for (const command of candidates) {
    if (!state.agentBins.has(commandBaseName(command))) continue;
    const resolved = resolveCommand(command, envValue(envPairs, 'PATH'), cwd);
    if (resolved == null || isAllowed(state, resolved)) continue;
    return { command: [command, ...args.slice(command === file ? 1 : 0)].join(' ').slice(0, 300), resolved, via: file };
  }
  return null;
}

const BLOCKED_TARGET = '/nonexistent/od-test-blocked-agent';

type SpawnOptions = { args: string[]; cwd?: string; envPairs?: string[]; file: string };

function installSpawnGuard(state: HermeticState): void {
  const proto = childProcess.ChildProcess.prototype as ChildProcess & { spawn(options: SpawnOptions): unknown };
  const originalSpawn = proto.spawn;
  // Every async launcher (spawn, execFile, exec, fork) goes through here.
  proto.spawn = function guardedSpawn(this: ChildProcess, options: SpawnOptions) {
    const blocked = classifyAgentSpawn(options.file, options.args ?? [], options.envPairs, options.cwd);
    if (blocked) {
      state.blocked.push(blocked);
      // Fail the way a missing binary does, so code under test takes its
      // not-installed path instead of throwing synchronously.
      options = { ...options, file: BLOCKED_TARGET, args: [BLOCKED_TARGET, ...(options.args ?? []).slice(1)] };
    }
    return originalSpawn.call(this, options);
  };

  const originalSpawnSync = childProcess.spawnSync;
  const guardedSpawnSync = ((command: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
    const args = Array.isArray(argsOrOptions) ? (argsOrOptions as string[]) : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as
      | { cwd?: string; env?: NodeJS.ProcessEnv; shell?: unknown }
      | undefined;
    const envPairs = options?.env ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`) : undefined;
    const blocked = options?.shell
      ? classifyAgentSpawn('/bin/sh', ['-c', [command, ...args].join(' ')], envPairs, options?.cwd)
      : classifyAgentSpawn(command, [command, ...args], envPairs, options?.cwd);
    if (blocked) {
      state.blocked.push(blocked);
      return (originalSpawnSync as (...a: unknown[]) => unknown)(BLOCKED_TARGET, args, { ...options, shell: false });
    }
    return (originalSpawnSync as (...a: unknown[]) => unknown)(command, argsOrOptions, maybeOptions);
  }) as typeof childProcess.spawnSync;
  childProcess.spawnSync = guardedSpawnSync;
  // execFileSync / execSync call the module-private spawnSync, so a refusal
  // there is caught by wrapping them as well.
  for (const name of ['execFileSync', 'execSync'] as const) {
    const original = childProcess[name] as (...a: unknown[]) => unknown;
    (childProcess as unknown as Record<string, unknown>)[name] = (command: string, ...rest: unknown[]) => {
      const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
      const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
      const envPairs = options?.env ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`) : undefined;
      const blocked = name === 'execSync'
        ? classifyAgentSpawn('/bin/sh', ['-c', command], envPairs, options?.cwd)
        : classifyAgentSpawn(command, [command, ...args], envPairs, options?.cwd);
      if (blocked) {
        state.blocked.push(blocked);
        const error = Object.assign(new Error(`spawnSync ${command} ENOENT (blocked real agent binary under test)`), {
          code: 'ENOENT',
        });
        throw error;
      }
      return original(command, ...rest);
    };
  }
  syncBuiltinESMExports();
}

/**
 * Make this worker's environment hermetic and install the spawn guard. Safe
 * to call once per test file: state and the guard are created once per worker.
 */
export function installHermeticAgentEnv(repoRoot: string): HermeticState {
  let state = globalState[STATE_SYMBOL];
  if (!state) {
    state = createState(repoRoot);
    globalState[STATE_SYMBOL] = state;
    installSpawnGuard(state);
  }
  applyEnv(state);
  return state;
}

/** Blocked real-agent spawns recorded since the last call; clears the record. */
export function takeBlockedAgentSpawns(): BlockedSpawn[] {
  const state = globalState[STATE_SYMBOL];
  if (!state) return [];
  return state.blocked.splice(0, state.blocked.length);
}
