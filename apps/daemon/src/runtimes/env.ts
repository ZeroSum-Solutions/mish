import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeProxyAwareEnv, resolveSystemProxyEnv } from '@mish/platform';
import { readAppConfigSync } from '../app-config.js';
import { resolveProjectRelativePath } from '../home-expansion.js';
import { expandConfiguredEnv } from './paths.js';
import { resolveAmrOpenCodeExecutable } from './executables.js';
import { amrVelaProfileEnv } from '../integrations/vela-profile.js';
import { resolveProjectRootFromNestedModule } from '../project-root.js';
import {
  applySandboxRuntimeEnv,
  isSandboxModeEnabled,
  resolveSandboxRuntimeConfig,
  type SandboxRuntimeConfig,
} from '../sandbox-mode.js';
import { stripIdentityEnvInPlace } from './identity-env.js';
import { agentInheritedEnv } from './inherited-env.js';

export { IDENTITY_ENV_DENYLIST } from './identity-env.js';

type RuntimeEnvMap = NodeJS.ProcessEnv | Record<string, string>;
type SpawnEnvOptions = {
  resolvedBin?: string | null;
  adapterEnv?: Record<string, string>;
};

const RUNTIME_MODULE_PROJECT_ROOT = resolveProjectRootFromNestedModule(
  path.dirname(fileURLToPath(import.meta.url)),
);

// Build the env passed to spawn() for a given agent adapter.
//
// Auth/config precedence for Local CLI launches:
//
// 1. Provider BYOK is separate. It is used by Mishh Mashh's direct provider
//    API calls and is not automatically mapped into Local CLI launches.
// 2. The inherited launch env represents the user's local CLI setup
//    (OAuth/login files, CLI homes, or user-owned API-key env). Forward only
//    the canonical names in inherited-env.ts. Explicit adapter/profile env
//    follows that boundary, before Settings overrides.
// 3. `configuredEnv` comes from Settings -> Local CLI ->
//    "Advanced: proxy & custom paths". It is an explicit low-level CLI env
//    override, so it wins over inherited env, including API-key variables.
//    BASE_URL is optional: when omitted, the underlying CLI uses its own
//    official default endpoint.
// When the daemon launches the vela (amr) CLI, forward this installation's id
// so vela's analytics can be correlated back to it. spawnEnvForAgent is
// synchronous, so this uses readAppConfigSync — the synchronous mirror of
// readAppConfig — to resolve consent and the installationId through the exact
// same parsing/validation/defaulting the daemon and web analytics config use.
// That keeps vela's correlation in lockstep with what the web side already
// emits: telemetry defaults to on (opt-out), the id is withheld only when the
// user has explicitly opted out (metrics !== true) or no id exists, and an
// unreadable config simply omits the env (vela reports without it).
function amrAnalyticsIdentityEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const dataDir = env.OD_DATA_DIR?.trim();
  if (!dataDir) return {};
  let cfg: { telemetry?: { metrics?: boolean }; installationId?: string | null };
  try {
    cfg = readAppConfigSync(dataDir);
  } catch {
    return {};
  }
  // Matches the analytics gate in analytics.ts (`telemetry?.metrics !== true`).
  if (cfg.telemetry?.metrics !== true) return {};
  const installationId = cfg.installationId;
  if (typeof installationId !== 'string' || installationId.length === 0) {
    return {};
  }
  return { OD_INSTALLATION_ID: installationId };
}

/**
 * Claude Code must expose a plan tool, or a Claude run can never draw the Todos
 * card the rest of the product is built around.
 *
 * Claude Code >= 2.1.x retired `TodoWrite` in favour of `TaskCreate` /
 * `TaskUpdate` / `TaskList` / `TaskGet`, and gates that family behind this
 * variable for the current model generation. Measured on 2.1.247, reading the
 * `tools` array of the init frame from `claude -p --output-format stream-json
 * --verbose`:
 *
 *   --model opus   (claude-opus-5)     → Task, TaskOutput, TaskStop
 *   --model sonnet (claude-sonnet-5)   → Task, TaskOutput, TaskStop
 *   … either of those, with the flag   → + TaskCreate, TaskGet, TaskList, TaskUpdate
 *   --model haiku  (claude-haiku-4-5)  → the Task family, flag or not
 *
 * `TodoWrite` appears on no model in that build, so the `default` / `opus` /
 * `sonnet` aliases the model picker offers ship with no plan tool at all unless
 * this is set. `claude-stream.ts` reduces the Task family back into the
 * canonical `TodoWrite` snapshot, so nothing downstream has to know which
 * dialect the installed build speaks.
 *
 * Setting it is monotone — inside Claude Code the check is an early
 * `return true`, so it can only ever ADD the family, never remove `TodoWrite`
 * from a build that still has it — and builds that predate the variable ignore
 * an unknown env key. A value the user set (inherited env, or Settings → Local
 * CLI → Advanced) wins, per the precedence rules above.
 */
function applyClaudeTaskToolEnv(env: NodeJS.ProcessEnv): void {
  if (typeof env.CLAUDE_CODE_ENABLE_TODO_TOOLS === 'string') return;
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
}

/**
 * The OS proxy configuration, resolved at most once per TTL.
 *
 * `resolveSystemProxyEnv` shells out synchronously (`scutil --proxy` on macOS,
 * `reg query` on Windows). Every agent spawn and every detection probe builds
 * its env through `spawnEnvForAgent`, so on page load (~25 agents, two env
 * builds each) the uncached shell-outs froze the daemon's event loop for
 * seconds and every other request, `/api/design-systems` included, waited
 * behind them. A proxy change is still picked up within the TTL.
 */
export function createSystemProxyEnvCache(options: {
  resolve: () => NodeJS.ProcessEnv;
  ttlMs: number;
  now?: () => number;
}): { get: () => NodeJS.ProcessEnv; clear: () => void } {
  // Monotonic: a wall-clock correction must not stretch or pin the TTL.
  const now = options.now ?? (() => performance.now());
  let cached: { value: NodeJS.ProcessEnv; at: number } | null = null;
  return {
    get() {
      const at = now();
      if (!cached || at - cached.at > options.ttlMs) {
        cached = { value: options.resolve(), at };
      }
      return { ...cached.value };
    },
    clear() {
      cached = null;
    },
  };
}

const SYSTEM_PROXY_ENV_TTL_MS = 30_000;
const systemProxyEnvCache = createSystemProxyEnvCache({
  resolve: () => resolveSystemProxyEnv(),
  ttlMs: SYSTEM_PROXY_ENV_TTL_MS,
});

/** Test-only: forget the cached OS proxy env so the next spawn re-resolves it. */
export function resetSystemProxyEnvCache(): void {
  systemProxyEnvCache.clear();
}

/** Cached OS proxy env for agent spawns (see `createSystemProxyEnvCache`). */
export function cachedSystemProxyEnv(): NodeJS.ProcessEnv {
  return systemProxyEnvCache.get();
}

/**
 * Placeholder git identity used for every agent child. Never the real
 * owner's name or email — see `applyAgentGitIdentityEnv`.
 */
export const AGENT_NEUTRAL_GIT_IDENTITY = Object.freeze({
  name: 'Mishh Mashh Agent',
  email: 'agent@mishmash.invalid',
});

function neutralGitConfigContents(): string {
  return (
    `[user]\n` +
    `\tname = ${AGENT_NEUTRAL_GIT_IDENTITY.name}\n` +
    `\temail = ${AGENT_NEUTRAL_GIT_IDENTITY.email}\n`
  );
}

/**
 * Writes (idempotently) a daemon-owned neutral global git config under the
 * resolved daemon data root and returns its path. Agent children point
 * `GIT_CONFIG_GLOBAL` at this file (see `applyAgentGitIdentityEnv`) so
 * `git config user.email` / `user.name` resolve to a neutral placeholder
 * instead of silently reading the real owner's `~/.gitconfig` — which
 * `GIT_CONFIG_GLOBAL` replaces as git's own global-config lookup target.
 */
export function ensureAgentNeutralGitConfig(dataDir: string): string {
  const dir = path.join(dataDir, 'agent-runtime');
  const file = path.join(dir, 'agent-git-config');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, neutralGitConfigContents());
  } catch {
    // Best effort: a write failure here still leaves GIT_CONFIG_NOSYSTEM and
    // the identity-var denylist below protecting the owner's identity; it
    // just means a `git config user.email` in the child may come back empty
    // (unset) instead of the neutral placeholder, which is safe either way.
  }
  return file;
}

/**
 * Stops an agent child from ever learning the owner's real git identity via
 * `git config user.email` / `user.name`. `GIT_CONFIG_GLOBAL` overrides git's
 * own lookup of `$HOME/.gitconfig` (and `$XDG_CONFIG_HOME/git/config`);
 * `GIT_CONFIG_NOSYSTEM` disables `/etc/gitconfig`. A generated project's own
 * repo-local `.git/config`, if any, still takes precedence over both — that
 * is project data, not the owner's ambient machine identity, and is out of
 * scope here.
 *
 * Only applied when the child's `OD_DATA_DIR` is known (every real agent
 * spawn through `createAgentRuntimeEnv` sets it), and only when the caller
 * has not already set these explicitly — an explicit `configuredEnv` value
 * (Settings -> Local CLI -> Advanced) is a deliberate low-level override and
 * keeps the same precedence every other advanced CLI env var gets.
 */
function applyAgentGitIdentityEnv(env: NodeJS.ProcessEnv, daemonDataDir: string | undefined): void {
  // The file is daemon data, so its location comes from the daemon-provided
  // base env (the resolved RUNTIME_DATA_DIR), never from the merged env: an
  // Advanced CLI override of OD_DATA_DIR must not move daemon-owned writes.
  const dataDir = daemonDataDir?.trim();
  if (dataDir && !env.GIT_CONFIG_GLOBAL?.trim()) {
    env.GIT_CONFIG_GLOBAL = ensureAgentNeutralGitConfig(dataDir);
  }
  if (!env.GIT_CONFIG_NOSYSTEM?.trim()) {
    env.GIT_CONFIG_NOSYSTEM = '1';
  }
}

/**
 * Compose a run launch with the map issued by createAgentRuntimeEnv. Opaque
 * integration capabilities are explicit inputs, not ambient-name exceptions.
 * Profile/Settings precedence stays intact; automatic run tokens come only
 * from the issued map, never from ambient or configured stale values.
 */
export function spawnEnvForAgentRuntime(
  agentId: string,
  baseEnv: RuntimeEnvMap,
  configuredEnv: unknown,
  options: SpawnEnvOptions & { runtimeEnv: NodeJS.ProcessEnv },
  systemProxyEnv: RuntimeEnvMap = cachedSystemProxyEnv(),
): NodeJS.ProcessEnv {
  const runtimeEnv = Object.fromEntries(Object.entries(options.runtimeEnv).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ));
  const env = spawnEnvForAgent(agentId, baseEnv, configuredEnv, systemProxyEnv, {
    ...options,
    adapterEnv: { ...runtimeEnv, ...options.adapterEnv },
  });
  const token = options.runtimeEnv.OD_TOOL_TOKEN;
  const issuer = options.runtimeEnv.OD_TOOL_TOKEN_ISSUER_ORIGIN;
  if (token && issuer) {
    env.OD_TOOL_TOKEN = token;
    env.OD_TOOL_TOKEN_ISSUER_ORIGIN = issuer;
  }
  return env;
}

export function spawnEnvForAgent(
  agentId: string,
  baseEnv: RuntimeEnvMap,
  configuredEnv: unknown = {},
  systemProxyEnv: RuntimeEnvMap = cachedSystemProxyEnv(),
  options: SpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const sandboxRuntime = sandboxRuntimeConfigForBaseEnv(baseEnv);
  const expandedConfiguredEnv = expandConfiguredEnv(configuredEnv);
  const env = mergeProxyAwareEnv(
    process.platform,
    agentInheritedEnv(systemProxyEnv),
    agentInheritedEnv(baseEnv),
    options.adapterEnv ?? {},
    expandedConfiguredEnv,
  );
  // Privacy boundary: no agent child may learn the owner's real identity
  // (see IDENTITY_ENV_DENYLIST / applyAgentGitIdentityEnv docs above).
  // Applied to every agent, unconditionally, before any per-agent env is
  // layered on, so a future per-agent branch cannot accidentally reintroduce
  // an identity var.
  stripIdentityEnvInPlace(env);
  stripKeysCaseInsensitive(env, ['OD_TOOL_TOKEN', 'OD_TOOL_TOKEN_ISSUER_ORIGIN']);
  applyAgentGitIdentityEnv(env, typeof baseEnv.OD_DATA_DIR === 'string' ? baseEnv.OD_DATA_DIR : undefined);
  if (agentId === 'amr') {
    Object.assign(env, amrVelaProfileEnv(env));
    Object.assign(env, amrAnalyticsIdentityEnv(env));
    // `execAgentFile` REPLACES the child environment (execFile with `env`
    // set), so anything missing here is genuinely absent for vela. `vela model
    // list` resolves its config home up front and exits non-zero with
    // "$HOME is not defined" when HOME is unset — while `vela model preset`
    // and `vela --version` do not need it. A packaged daemon spawned with a
    // stripped env (or any caller that did not forward HOME) would therefore
    // detect AMR and seed the picker from preset, yet fail every run's remote
    // catalog probe. Backfill HOME from the OS so the authoritative catalog
    // call is never silently decapitated by a missing home dir.
    if (!env.HOME?.trim()) {
      const home = os.homedir();
      if (home) env.HOME = home;
    }
    // Identify Mishh Mashh as the host so the vela CLI tags its command +
    // model_request analytics with source=mish (revenue attribution).
    // Not PII (unlike the installation id above), so set it regardless of the
    // telemetry-consent gate that amrAnalyticsIdentityEnv applies.
    if (!env.AMR_CLIENT_SOURCE?.trim()) {
      env.AMR_CLIENT_SOURCE = 'mish';
    }
    // AMR runs through Vela's private OpenCode server. The server inherits
    // this flag, which enables OpenCode's built-in, keyless Exa websearch
    // tool for AMR without changing the standalone Vela CLI default.
    if (!env.OPENCODE_ENABLE_EXA?.trim()) {
      env.OPENCODE_ENABLE_EXA = '1';
    }
    // Vela owns the private OpenCode config and intentionally discards a
    // parent OPENCODE_CONFIG_CONTENT. Its explicit opt-in lets AMR mount the
    // keyless Parallel Search MCP (web_search + web_fetch) alongside Exa.
    if (!env.VELA_ENABLE_PARALLEL_MCP?.trim()) {
      env.VELA_ENABLE_PARALLEL_MCP = '1';
    }
    if (!env.OPENCODE_TEST_HOME?.trim() && env.OD_DATA_DIR?.trim()) {
      env.OPENCODE_TEST_HOME = path.join(
        env.OD_DATA_DIR.trim(),
        'amr',
        'opencode-home',
      );
    }
    if (!env.VELA_OPENCODE_BIN?.trim()) {
      const opencodeBin = resolveAmrOpenCodeExecutable(env);
      if (opencodeBin) env.VELA_OPENCODE_BIN = opencodeBin;
    }
    return finalizeRuntimeEnv(env, sandboxRuntime);
  }
  if (agentId === 'claude') {
    applyClaudeTaskToolEnv(env);
    return finalizeRuntimeEnv(env, sandboxRuntime);
  }
  if (agentId === 'codex') {
    // Name the rollout root the codex CLI is about to write into. Child
    // evidence is read back from `<CODEX_HOME>/sessions/.../rollout-*.jsonl`,
    // and `collectCodexChildEvidence` deliberately refuses a homedir fallback
    // so it can never attribute one install's sessions to another. That leaves
    // the caller owing it an explicit root — which nothing supplied, so the
    // collector's `CODEX_HOME` guard was false on every default install and a
    // complex Run's native Children went unobserved. The plan still locked
    // complex, then failed certification for evidence the daemon simply never
    // looked for.
    if (!env.CODEX_HOME?.trim()) {
      const home = os.homedir();
      if (home) env.CODEX_HOME = path.join(home, '.codex');
    }
    return finalizeRuntimeEnv(env, sandboxRuntime);
  }
  if (agentId === 'opencode' || agentId === 'byok-opencode') {
    stripKeysCaseInsensitive(env, [
      'OPENCODE',
      'OPENCODE_PID',
      'OPENCODE_RUN_ID',
      'OPENCODE_SERVER_PASSWORD',
    ]);
    // OpenCode is bun-based and, left to its defaults, walks up from its cwd to
    // the nearest project root and runs `bun install` there at startup to set up
    // local plugins. When that root is a pnpm workspace (the daemon's own repo,
    // or a project nested inside it), the install replaces the pnpm `.pnpm` store
    // with a bun `node_modules/.bun` + `bun.lock` and breaks the workspace.
    // Disable project-config discovery (and its install) so OpenCode only honors
    // the config the daemon injects via OPENCODE_CONFIG_CONTENT — this is exactly
    // what the AMR path already does for its private OpenCode server.
    if (!env.OPENCODE_DISABLE_PROJECT_CONFIG?.trim()) {
      env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    }
    return finalizeRuntimeEnv(env, sandboxRuntime);
  }
  if (agentId === 'mimo') {
    stripKeysCaseInsensitive(env, [
      'MIMOCODE',
      'MIMOCODE_PID',
      'MIMOCODE_RUN_ID',
      'MIMOCODE_SERVER_PASSWORD',
    ]);
    // MiMo builds on the same toolchain as OpenCode and has the same
    // workspace-corruption risk when project-config discovery walks up from
    // cwd to a pnpm workspace root and runs its own install. Disable it so
    // MiMo only honors the config injected through MIMOCODE_CONFIG_CONTENT.
    if (!env.MIMOCODE_DISABLE_PROJECT_CONFIG?.trim()) {
      env.MIMOCODE_DISABLE_PROJECT_CONFIG = 'true';
    }
    return finalizeRuntimeEnv(env, sandboxRuntime);
  }
  return finalizeRuntimeEnv(env, sandboxRuntime);
}

export function mishAmrRunAttempt(input: {
  cumulativeRetryAttemptCount?: number | null;
  retryAttemptCount?: number | null;
  manualResumeAttemptCount?: number | null;
}): number {
  const normalizedCount = (value: number | null | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  return (
    normalizedCount(input.cumulativeRetryAttemptCount) +
    normalizedCount(input.retryAttemptCount) +
    normalizedCount(input.manualResumeAttemptCount)
  );
}

export function mishAmrTraceEnv(input: {
  agentId: string;
  runId: string;
  conversationId?: string | null;
  runAttempt: number;
  // The exact persisted Workspace binding for this run's project, whether
  // Team or Personal. Never derive it from an account-level current/active
  // selection. Omission means the historical project is genuinely unbound;
  // Vela/AMR owns the resulting wallet and membership decision.
  workspaceId?: string | null;
  externalPluginAnalytics?: Record<string, unknown> | null;
}): NodeJS.ProcessEnv {
  if (input.agentId !== 'amr') return {};

  const runId = input.runId.trim();
  if (!runId) {
    throw new Error('MISH_RUN_ID requires a non-empty run id for AMR runs');
  }
  if (!Number.isFinite(input.runAttempt) || input.runAttempt < 0) {
    throw new Error('MISH_RUN_ATTEMPT requires a non-negative finite attempt index');
  }

  const conversationId = input.conversationId?.trim();
  const workspaceId = input.workspaceId?.trim();
  const plugin = input.externalPluginAnalytics;
  const bounded = (key: string, max = 128): string | null => {
    const value = plugin?.[key];
    return typeof value === 'string'
      && value.length > 0
      && value.length <= max
      && /^[A-Za-z0-9._:@/-]+$/u.test(value)
      ? value
      : null;
  };
  const digest = bounded('logicalRequestDigest', 64);
  const digestVersion =
    plugin?.logicalRequestDigestVersion === 1 ? '1' : null;
  return {
    MISH_RUN_ID: runId,
    MISH_RUN_ATTEMPT: String(Math.floor(input.runAttempt)),
    ...(conversationId ? { MISH_SESSION_ID: conversationId } : {}),
    ...(workspaceId ? { MISH_WORKSPACE_ID: workspaceId } : {}),
    ...(bounded('pluginWorkflowId')
      ? { MISH_PLUGIN_WORKFLOW_ID: bounded('pluginWorkflowId')! }
      : {}),
    ...(digest
      ? { MISH_LOGICAL_REQUEST_DIGEST: digest }
      : {}),
    ...(digestVersion
      ? { MISH_LOGICAL_REQUEST_DIGEST_VERSION: digestVersion }
      : {}),
    ...(bounded('externalPluginId')
      ? { MISH_EXTERNAL_PLUGIN_ID: bounded('externalPluginId')! }
      : {}),
    ...(bounded('externalPluginVersion', 64)
      ? {
          MISH_EXTERNAL_PLUGIN_VERSION:
            bounded('externalPluginVersion', 64)!,
        }
      : {}),
    ...(bounded('distributionMechanism', 64)
      ? {
          MISH_DISTRIBUTION_MECHANISM:
            bounded('distributionMechanism', 64)!,
        }
      : {}),
    ...(bounded('publisherClass', 32)
      ? {
          MISH_PUBLISHER_CLASS: bounded('publisherClass', 32)!,
        }
      : {}),
  };
}

function sandboxRuntimeConfigForBaseEnv(
  baseEnv: RuntimeEnvMap,
): SandboxRuntimeConfig | null {
  if (!isSandboxModeEnabled(baseEnv)) return null;
  const dataDir = baseEnv.OD_DATA_DIR?.trim();
  if (!dataDir) return null;
  const resolvedDataDir = resolveProjectRelativePath(
    dataDir,
    RUNTIME_MODULE_PROJECT_ROOT,
  );
  return resolveSandboxRuntimeConfig(true, resolvedDataDir);
}

function reapplySandboxRuntimeEnv(
  env: NodeJS.ProcessEnv,
  sandboxRuntime: SandboxRuntimeConfig | null,
): NodeJS.ProcessEnv {
  if (!sandboxRuntime) return env;
  return applySandboxRuntimeEnv(env, sandboxRuntime);
}

function finalizeRuntimeEnv(
  env: NodeJS.ProcessEnv,
  sandboxRuntime: SandboxRuntimeConfig | null,
): NodeJS.ProcessEnv {
  const finalizedEnv = reapplySandboxRuntimeEnv(env, sandboxRuntime);
  applyWindowsUserCacheEnv(finalizedEnv);
  return finalizedEnv;
}

function stripKeysCaseInsensitive(
  env: NodeJS.ProcessEnv,
  keysToStrip: readonly string[],
): void {
  const keysUpper = new Set(keysToStrip.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (keysUpper.has(key.toUpperCase())) delete env[key];
  }
}

function applyWindowsUserCacheEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'win32') return;

  // GUI-launched Windows daemons can inherit enough PATH to resolve a CLI
  // while still missing the profile/cache variables CLIs use at startup.
  const userProfile =
    envValue(env, 'USERPROFILE') ||
    envValue(env, 'HOME') ||
    os.homedir();
  if (!userProfile) return;

  setEnvIfMissing(env, 'USERPROFILE', userProfile);
  const localAppData =
    envValue(env, 'LOCALAPPDATA') ||
    path.win32.join(userProfile, 'AppData', 'Local');
  setEnvIfMissing(env, 'LOCALAPPDATA', localAppData);
  setEnvIfMissing(
    env,
    'APPDATA',
    path.win32.join(userProfile, 'AppData', 'Roaming'),
  );
  const tempDir = path.win32.join(localAppData, 'Temp');
  setEnvIfMissing(env, 'TEMP', tempDir);
  setEnvIfMissing(env, 'TMP', tempDir);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const existingKey = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  const value = existingKey ? env[existingKey] : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? (value as string) : null;
}

function setEnvIfMissing(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  if (envValue(env, key)) return;
  const existingKey = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  env[existingKey ?? key] = value;
}
