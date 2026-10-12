import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCommandInvocation } from '@mish/platform';
import type { ReviewerReasonCode } from '@mish/contracts';
import { resolveOnPath } from '../../../runtimes/executables.js';
import { textReviewerSplit } from './abstain.js';
import { buildReviewPrompt, parseVerdicts } from './prompt.js';
import { ReviewerCallError, type ReviewerAdapter, type ReviewerAvailability, type ReviewerResult } from './types.js';

/** Default subscription model. Override with OD_GEMINI_REVIEW_MODEL or `agyModel`. */
export const GEMINI_REVIEW_MODEL = 'gemini-3.8-flash-medium';
export const OPENROUTER_GEMINI_MODEL = 'google/gemini-3.8-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CALL_MS = 300_000;

export interface AgyProcessRequest { command: string; args: string[]; stdin: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }
export interface AgyProcessResult { exitCode: number | null; stdout: string; stderr: string }
export type AgyProcessRunner = (request: AgyProcessRequest) => Promise<AgyProcessResult>;
/** One OpenRouter chat call; returns the model's text. Injected in tests. */
export type OpenRouterCall = (request: { model: string; key: string; system: string; user: string; signal: AbortSignal }) => Promise<string>;

export interface GeminiReviewerOptions {
  /** Explicit route choice. Defaults to OD_GEMINI_REVIEW_ROUTE, then agy. */
  route?: 'agy' | 'openrouter';
  /** Resolves the agy executable; null when it is not installed. */
  resolveBin?: () => string | null;
  /** Used only for the explicitly selected OpenRouter route. Never logged. */
  openRouterKey?: () => Promise<string>;
  run?: AgyProcessRunner;
  call?: OpenRouterCall;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  agyModel?: string;
  /** Existing agy sign-in leaf, referenced without copying; null uses keyring only. */
  authFile?: string | null;
  /** Per-call config root; production derives it from RUNTIME_DATA_DIR. */
  isolatedConfigRoot?: string;
}

// Subscription authentication needs no copied auth files or API-key environment variables.
const AGY_ENV_ALLOWLIST = [
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'SYSTEMROOT', 'HOMEDRIVE', 'ComSpec', 'PATHEXT',
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
] as const;

/** Secrets and user settings stay out; every config/cache/data location is per-call. */
export function agyLaneEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const name of AGY_ENV_ALLOWLIST) if (typeof env[name] === 'string') next[name] = env[name];
  next.HOME = home; next.USERPROFILE = home;
  next.XDG_CONFIG_HOME = path.join(home, 'config'); next.XDG_DATA_HOME = path.join(home, 'data'); next.XDG_CACHE_HOME = path.join(home, 'cache');
  next.APPDATA = path.join(home, 'config'); next.LOCALAPPDATA = path.join(home, 'data');
  next.ANTIGRAVITY_APP_DATA_DIR = path.join(home, 'data');
  next.TMPDIR = home; next.TEMP = home; next.TMP = home;
  return next;
}

/** One NDJSON user event on stdin; plan/sandbox mode and no permission auto-approval. */
export function agyArgs(model: string, timeoutMs: number): string[] {
  return ['--model', model, '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', `${timeoutMs}ms`];
}

/** Starts when the production adapter is constructed, even if no Gemini review is requested. */
async function cleanupAbandonedHomes(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const cutoff = Date.now() - MAX_CALL_MS;
  let failed = false;
  for (const entry of entries) {
    if (!entry.name.startsWith('agy-config-') || !entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const info = await lstat(dir);
      if (info.isDirectory() && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true;
    }
  }
  if (failed) throw new Error('Abandoned agy config directories could not be removed');
}

const runAgyProcess: AgyProcessRunner = request => new Promise((resolve, reject) => {
  if (request.signal.aborted) { reject(request.signal.reason ?? new Error('aborted')); return; }
  const invocation = createCommandInvocation({ command: request.command, args: request.args, env: request.env });
  const child = spawn(invocation.command, invocation.args, { cwd: request.cwd, env: request.env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0);
  let settled = false;
  const killGroup = () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 1000, windowsHide: true }, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
    }
  };
  const finish = (error?: unknown, exitCode: number | null = null) => {
    if (settled) return;
    settled = true;
    request.signal.removeEventListener('abort', onAbort);
    killGroup();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (error) reject(error); else resolve({ exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
  };
  // Do not wait for `close`: a relaunched worker can hold the pipes after the wrapper exits.
  // The combined call/run signal is a hard settlement deadline as well as a process kill.
  const onAbort = () => finish(request.signal.reason ?? new Error('aborted'));
  request.signal.addEventListener('abort', onAbort, { once: true });
  // Keep the bounded tail: NDJSON progress precedes the terminal result. Decode
  // only after collection so UTF-8 characters split across pipe chunks survive.
  child.stdout.on('data', chunk => {
    const joined = Buffer.concat([stdout, Buffer.from(chunk)]);
    stdout = joined.length > MAX_OUTPUT_BYTES ? joined.subarray(joined.length - MAX_OUTPUT_BYTES) : joined;
  });
  child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, 16_384); });
  const onError = (error: Error) => finish(error);
  // Early CLI exits can break stdin before `close` carries the real auth/provider error.
  // Keep collecting that result; abort/timeout still imposes the hard deadline.
  const onInputError = (error: Error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); };
  child.stdin.on('error', onInputError);
  child.stdout.on('error', onError);
  child.stderr.on('error', onError);
  child.on('error', onError);
  child.on('close', code => finish(undefined, code));
  if (request.signal.aborted) { onAbort(); return; }
  const prompt = Buffer.from(request.stdin);
  function* chunks() { for (let offset = 0; offset < prompt.length; offset += 16_384) yield prompt.subarray(offset, offset + 16_384); }
  void pipeline(Readable.from(chunks()), child.stdin).catch(onInputError);
});

const openRouterCall = (timeoutMs: number): OpenRouterCall => async ({ model, key, system, user, signal }) => {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 4_000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!response.ok) throw Object.assign(new Error(`openrouter ${response.status}`), { status: response.status });
  const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('openrouter returned no text');
  return text;
};

// Only agy's own non-interactive sign-in prompts, never generic provider diagnostics.
const SIGNED_OUT = /^(?:Print mode: not logged in and no controlling terminal; cannot complete interactive login|Please set an Auth method(?: in your [^\r\n]+)?)\s*$/mu;
type Lane = 'agy' | 'openrouter';

/**
 * R03 second family (B062, D7/D8): agy subscription by default, OpenRouter by
 * explicit opt-in only. prepare() freezes the route before billing facts are
 * recorded. Failures never select another route. Text-only and advisory.
 */
export function createGeminiReviewer(options: GeminiReviewerOptions = {}): ReviewerAdapter {
  const env = options.env ?? process.env;
  const requestedRoute = options.route ?? ((env.OD_GEMINI_REVIEW_ROUTE || '').trim() || 'agy');
  const lane: Lane = requestedRoute === 'openrouter' ? 'openrouter' : 'agy';
  const invalidRoute = requestedRoute !== 'agy' && requestedRoute !== 'openrouter';
  const resolveBin = options.resolveBin ?? (() => resolveOnPath('agy'));
  const agyModel = options.agyModel ?? ((env.OD_GEMINI_REVIEW_MODEL || '').trim() || GEMINI_REVIEW_MODEL);
  const authFile = options.authFile === undefined ? path.join(env.HOME || homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token') : options.authFile;
  const openRouterKey = options.openRouterKey ?? (async () => (env.OD_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '').trim());
  const run = options.run ?? runAgyProcess;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? MAX_CALL_MS, MAX_CALL_MS));
  const call = options.call ?? openRouterCall(timeoutMs);
  let recoveryFailed = false;
  const recovered = options.isolatedConfigRoot ? cleanupAbandonedHomes(options.isolatedConfigRoot).catch(() => { recoveryFailed = true; }) : Promise.resolve();
  let agyBin: string | null = null;
  let keyConfigured = false;
  let selection: Promise<void> | null = null;
  const settle = (): Promise<void> => selection ??= (async () => {
    if (invalidRoute) return;
    if (lane === 'openrouter') { keyConfigured = Boolean(await openRouterKey().catch(() => '')); return; }
    await recovered;
    if (!recoveryFailed) agyBin = resolveBin();
  })();

  async function viaAgy(prompt: { system: string; user: string }, outer: AbortSignal): Promise<string> {
    const limit = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([outer, limit]);
    let home: string | null = null;
    let result: AgyProcessResult;
    try {
      if (options.isolatedConfigRoot) { await mkdir(options.isolatedConfigRoot, { recursive: true, mode: 0o700 }); await chmod(options.isolatedConfigRoot, 0o700); }
      home = await mkdtemp(path.join(options.isolatedConfigRoot ?? tmpdir(), 'agy-config-'));
      await chmod(home, 0o700);
      const cwd = path.join(home, 'work');
      await mkdir(cwd, { mode: 0o700 });
      const config = path.join(home, '.gemini', 'antigravity-cli');
      await mkdir(config, { recursive: true, mode: 0o700 });
      // The macOS installation may store sign-in in this leaf rather than the
      // keyring. Reference only that leaf; never link or copy the user's config.
      if (authFile) {
        const source = await stat(authFile).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (source?.isFile()) await symlink(path.resolve(authFile), path.join(config, 'antigravity-oauth-token'));
      }
      // This reviewer needs no tools, including reads in the temp/workspace.
      await writeFile(path.join(config, 'settings.json'), JSON.stringify({ permissions: { deny: ['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'] } }), { mode: 0o600 });
      const stdin = JSON.stringify({ event: 'user', message: { content: `${prompt.system}\n\n${prompt.user}` } }) + '\n';
      result = await run({ command: agyBin!, args: agyArgs(agyModel, timeoutMs), stdin, cwd, env: agyLaneEnv(env, home), signal });
    } catch (error) {
      if (outer.aborted) throw error;
      if (limit.aborted) throw new ReviewerCallError('agy timed out', 'Run the review again; if it repeats, check agy by hand or deselect the Gemini reviewer.', 'timeout');
      throw new ReviewerCallError('agy could not start', 'Check the agy install, then run the review again.', 'cli-failed');
    } finally {
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {
        throw new ReviewerCallError('The agy config directory could not be removed', 'Check permissions on the agy review config root and remove abandoned directories before retrying.', 'cli-failed');
      });
    }
    if (outer.aborted) throw outer.reason ?? new Error('aborted');
    if (limit.aborted) throw new ReviewerCallError('agy timed out', 'Run the review again; if it repeats, check agy by hand or deselect the Gemini reviewer.', 'timeout');
    const authFailure = () => new ReviewerCallError('agy is not signed in', 'Run `agy` once and sign in, then run the review again.', 'cli-auth-missing');
    const providerFailure = () => new ReviewerCallError('The agy provider did not return a successful answer', 'Check agy by hand, then run the review again.', 'provider-error');
    if (result.exitCode !== 0 && SIGNED_OUT.test(result.stderr)) throw authFailure();
    // Only a successful terminal result is an answer. Never score step updates,
    // partial output or error envelopes, and never expose provider diagnostics.
    for (const line of result.stdout.trim().split('\n').reverse()) {
      let event: { event?: unknown; result?: { status?: unknown; response?: unknown; error?: unknown } } | null;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.event !== 'result') continue;
      const response = event.result;
      if (result.exitCode === 0 && response?.status === 'SUCCESS' && typeof response.response === 'string' && response.response.trim()) return response.response;
      if (typeof response?.error === 'string' && SIGNED_OUT.test(response.error)) throw authFailure();
      if (result.exitCode !== 0 || response?.status === 'ERROR') throw providerFailure();
      throw new ReviewerCallError('agy did not return a successful answer', 'Check agy by hand, then run the review again.', 'cli-failed');
    }
    if (result.exitCode !== 0) throw providerFailure();
    throw new ReviewerCallError('agy returned no terminal result', 'Check the agy version, then run the review again.', 'cli-failed');
  }

  async function viaOpenRouter(prompt: { system: string; user: string }, signal: AbortSignal): Promise<string> {
    try {
      return await call({ model: OPENROUTER_GEMINI_MODEL, key: await openRouterKey(), system: prompt.system, user: prompt.user, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      const status = (error as { status?: unknown }).status;
      const code: ReviewerReasonCode = status === 401 || status === 403 ? 'provider-auth-rejected' : typeof status === 'number' ? 'provider-error' : 'provider-unreachable';
      throw new ReviewerCallError('The Gemini model on OpenRouter did not answer', 'Check the OpenRouter key and network, then run the review again.', code);
    }
  }

  async function availability(): Promise<ReviewerAvailability> {
    await settle();
    if (invalidRoute) return { available: false, code: 'cli-failed', reason: 'Unknown Gemini review route', recovery: 'Set OD_GEMINI_REVIEW_ROUTE to agy or openrouter, then start a new review.' };
    if (lane === 'openrouter') return keyConfigured ? { available: true } : { available: false, code: 'key-missing', reason: 'The selected OpenRouter route has no key', recovery: 'Configure an OpenRouter key in Settings, or select the agy route before starting a new review.' };
    if (recoveryFailed) return { available: false, code: 'cli-failed', reason: 'Abandoned agy config directories could not be removed', recovery: 'Check permissions on the agy review config root, remove abandoned directories, then start a new review.' };
    if (agyBin) return { available: true };
    return { available: false, code: 'cli-missing', reason: 'agy is not installed', recovery: 'Install agy and sign in, or explicitly set OD_GEMINI_REVIEW_ROUTE=openrouter and configure a key, then start a new review.' };
  }

  return {
    role: 'gemini-second-family',
    forRun: () => createGeminiReviewer(options),
    provider: lane === 'openrouter' ? 'openrouter' : 'gemini',
    modelId: lane === 'openrouter' ? OPENROUTER_GEMINI_MODEL : agyModel,
    adapterVersion: 'gemini-review/2',
    billingLane: lane === 'openrouter' ? 'openrouter-metered' : 'gemini-subscription',
    async prepare() { await settle(); },
    plannedCalls: input => (textReviewerSplit(input).asked.length ? 1 : 0),
    availability,
    async review(input, signal): Promise<ReviewerResult> {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const { asked, abstained } = textReviewerSplit(input);
      if (!asked.length) return { verdicts: abstained, rawOutput: '', inputMode: 'text' };
      const available = await availability();
      if (!available.available) throw new ReviewerCallError(available.reason, available.recovery, available.code);
      const askedInput = { ...input, checks: asked, screenshots: [] };
      const prompt = buildReviewPrompt('gemini-second-family', askedInput);
      const text = lane === 'agy' ? await viaAgy(prompt, signal) : await viaOpenRouter(prompt, signal);
      const { verdicts } = parseVerdicts(text, askedInput);
      return { verdicts: [...verdicts, ...abstained], rawOutput: text, inputMode: 'text' };
    },
  };
}
