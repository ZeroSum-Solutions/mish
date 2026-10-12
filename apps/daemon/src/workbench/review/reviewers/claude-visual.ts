import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createCommandInvocation } from '@mish/platform';
import { resolveAgentBin } from '../../../runtimes/resolution.js';
import { buildReviewPrompt, parseVerdicts, VERDICTS_JSON_SCHEMA } from './prompt.js';
import { ReviewerCallError, type ReviewerAdapter, type ReviewerInput, type ReviewerResult } from './types.js';
import { visualFallback } from './visual-fallback.js';

export const CLAUDE_REVIEW_MODEL = 'claude-opus-5-5';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ClaudeProcessRequest { command: string; args: string[]; stdin: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }
export interface ClaudeProcessResult { exitCode: number | null; stdout: string; stderr: string }
export type ClaudeProcessRunner = (request: ClaudeProcessRequest) => Promise<ClaudeProcessResult>;

export interface ClaudeVisualReviewerOptions {
  /** Resolves the same `claude` executable the agent runtime uses; null when it is not installed. */
  resolveBin?: () => string | null;
  run?: ClaudeProcessRunner;
  env?: NodeJS.ProcessEnv;
  model?: string;
  /** Directory the critic may read (the run's screenshot folder under the daemon data root); created when missing. */
  workDir: (input: ReviewerInput) => string;
}

/** Variables the Claude CLI needs to find its install, its Max sign-in and the network; nothing else. */
const MAX_LANE_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'PATHEXT',
] as const;

/**
 * The child env is built from an allowlist, never copied from the daemon: the
 * critic reads page-derived text, so no daemon secret (provider keys, tool
 * tokens) reaches it, and with no API-key variable the CLI authenticates
 * through the signed-in Max subscription rather than a billed key.
 */
export function maxLaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const name of MAX_LANE_ENV_ALLOWLIST) if (typeof env[name] === 'string') next[name] = env[name];
  return next;
}

/** Claude Code permission rule for an absolute directory (`//` marks a filesystem-absolute path). */
export function readRuleFor(dir: string): string {
  const posix = path.resolve(dir).split(path.sep).join('/').replace(/^\/+/u, '');
  return `Read(//${posix}/**)`;
}

/**
 * One bounded `claude -p` turn. Read is the only tool and is pre-approved only
 * inside the screenshot folder; `--restricted` ignores user/project settings
 * and hooks and confines file tools to that folder; `dontAsk` with no prompt
 * handler refuses anything else. stream-json lets the adapter see which files
 * the critic actually read.
 */
export function claudeReviewArgs(model: string, workDir: string): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model,
    '--tools', 'Read', '--allowedTools', readRuleFor(workDir), '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--restricted',
    '--strict-mcp-config', '--no-session-persistence', '--add-dir', workDir, '--json-schema', JSON.stringify(VERDICTS_JSON_SCHEMA),
  ];
}

/** One bounded `claude` child process; also the R15 brief transformer's Max-lane runner. */
export const runClaudeProcess: ClaudeProcessRunner = request => new Promise((resolve, reject) => {
  // Never spawn a turn the caller already gave up on (it would spend a Max turn for nothing).
  if (request.signal.aborted) { reject(request.signal.reason ?? new Error('aborted')); return; }
  const invocation = createCommandInvocation({ command: request.command, args: request.args, env: request.env });
  const child = spawn(invocation.command, invocation.args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  let stdout = ''; let stderr = '';
  const onAbort = () => child.kill('SIGKILL');
  request.signal.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += String(chunk); });
  child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr += String(chunk); });
  child.on('error', error => { request.signal.removeEventListener('abort', onAbort); reject(error); });
  child.on('close', code => { request.signal.removeEventListener('abort', onAbort); resolve({ exitCode: code, stdout, stderr }); });
  child.stdin.end(request.stdin);
});

type ResultFrame = { is_error?: unknown; result?: unknown; structured_output?: unknown };

/** A tool error that says the read was refused by permissions (Claude Code's own wording, never page text). */
const DENIED = /permission|denied|not allowed|blocked|outside (?:the )?(?:allowed|working)|protected/iu;
const toolResultText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join(' ') : '';

/**
 * Reads a stream-json transcript: the final result frame, every file a
 * main-turn Read call returned without error, and every file whose Read failed
 * (`denied` when the error says permissions refused it).
 */
export function summarizeClaudeStream(stdout: string): { result: ResultFrame | null; readPaths: Set<string>; failedReads: Map<string, 'denied' | 'failed'> } {
  const requested = new Map<string, string>();
  const readPaths = new Set<string>();
  const failedReads = new Map<string, 'denied' | 'failed'>();
  let result: ResultFrame | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!frame || typeof frame !== 'object') continue;
    if (frame.type === 'result') { result = frame as ResultFrame; continue; }
    if (frame.parent_tool_use_id) continue;
    const message = frame.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (frame.type === 'assistant' && block.type === 'tool_use' && block.name === 'Read' && typeof block.id === 'string') {
        const file = (block.input as { file_path?: unknown } | undefined)?.file_path;
        if (typeof file === 'string') requested.set(block.id, path.resolve(file));
      }
      if (frame.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const file = requested.get(block.tool_use_id);
        if (!file) continue;
        if (block.is_error !== true) readPaths.add(file);
        else if (failedReads.get(file) !== 'denied') failedReads.set(file, DENIED.test(toolResultText(block.content)) ? 'denied' : 'failed');
      }
    }
  }
  return { result, readPaths, failedReads };
}

/** Claude Code's messages for a CLI that is not signed in (matched to a code; the text is never stored). */
const SIGNED_OUT = /not logged in|please run \/login|\/login\b|invalid api key|authentication|unauthori[sz]ed|oauth token|credentials? (?:are |were )?(?:missing|expired|invalid)|sign in/iu;
export function signedOut(...texts: unknown[]): boolean {
  return texts.some(text => typeof text === 'string' && SIGNED_OUT.test(text));
}

const SIGN_IN_RECOVERY = 'Run `claude auth status`; if it is signed out, run `claude auth login` with the Max subscription, then run the review again.';

/**
 * Claude visual critic through the daemon's existing `claude` spawn lane (Max
 * OAuth). Screenshots are passed as file paths for the CLI's Read tool. The
 * `vision` label rests on observed tool use: every screenshot must come back
 * from a successful Read call in the transcript. Otherwise the record is
 * `text-only-fallback` and its claims are judgments, never visual evidence.
 */
export function createClaudeVisualReviewer(options: ClaudeVisualReviewerOptions): ReviewerAdapter {
  const model = options.model ?? CLAUDE_REVIEW_MODEL;
  const resolveBin = options.resolveBin ?? (() => resolveAgentBin('claude'));
  const run = options.run ?? runClaudeProcess;
  return {
    role: 'claude-visual', provider: 'claude-max', modelId: model, adapterVersion: 'claude-visual/3', billingLane: 'max-subscription',
    async availability() {
      return resolveBin() ? { available: true } : { available: false, reason: 'The Claude Code CLI is not installed or not on the daemon PATH', recovery: 'Install Claude Code and sign in with the Max subscription, or deselect the Claude visual critic.', code: 'cli-missing' };
    },
    async review(input, signal): Promise<ReviewerResult> {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const command = resolveBin();
      if (!command) throw new ReviewerCallError('The Claude Code CLI is not available', 'Install Claude Code and sign in, then run the review again.', 'cli-missing');
      const prompt = buildReviewPrompt('claude-visual', input);
      const stdin = `${prompt.system}\nOpen every screenshot file with the Read tool before you answer.\n\n${prompt.user}`;
      const workDir = path.resolve(options.workDir(input));
      let result: ClaudeProcessResult;
      try {
        await mkdir(workDir, { recursive: true, mode: 0o700 });
        result = await run({ command, args: claudeReviewArgs(model, workDir), stdin, cwd: workDir, env: maxLaneEnv(options.env ?? process.env), signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ReviewerCallError('The Claude Code CLI could not start', 'Check the Claude Code install, then run the review again.', 'cli-failed');
      }
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const { result: envelope, readPaths, failedReads } = summarizeClaudeStream(result.stdout);
      if (!envelope) {
        if (/unknown option|unrecognized|invalid (?:value|choice)/iu.test(result.stderr)) throw new ReviewerCallError(`The Claude Code CLI exited ${result.exitCode ?? 'by signal'} without a result`, 'Update Claude Code (the critic needs --restricted and dontAsk support), then run the review again.', 'cli-outdated');
        if (signedOut(result.stderr, result.stdout)) throw new ReviewerCallError('The Claude Code CLI is not signed in to the Max subscription', SIGN_IN_RECOVERY, 'cli-auth-missing');
        throw new ReviewerCallError(`The Claude Code CLI exited ${result.exitCode ?? 'by signal'} without a result`, 'Run `claude auth status` to confirm the Max sign-in, then run the review again.', 'cli-failed');
      }
      if (result.exitCode !== 0 || envelope.is_error === true) {
        if (signedOut(envelope.result, result.stderr)) throw new ReviewerCallError('The Claude Code CLI is not signed in to the Max subscription', SIGN_IN_RECOVERY, 'cli-auth-missing');
        throw new ReviewerCallError('The Claude Code CLI reported an error', 'Run `claude auth status` to confirm the Max sign-in, then run the review again.', 'cli-failed');
      }
      const answer = envelope.structured_output !== undefined && envelope.structured_output !== null ? JSON.stringify(envelope.structured_output) : typeof envelope.result === 'string' ? envelope.result : '';
      const { verdicts } = parseVerdicts(answer, input);
      const viewed = input.screenshots.length > 0 && input.screenshots.every(shot => readPaths.has(path.resolve(shot.path)));
      const screenshotIds = new Set(input.screenshots.map(shot => shot.evidenceId));
      // Without observed image reads, screenshot citations are not evidence.
      const normalized = viewed ? verdicts : verdicts.map(verdict => ({ ...verdict, evidenceRefs: verdict.evidenceRefs.filter(ref => !screenshotIds.has(ref)) }));
      if (viewed) return { verdicts: normalized, rawOutput: answer, inputMode: 'vision' };
      return { verdicts: normalized, rawOutput: answer, inputMode: 'text-only-fallback', fallback: visualFallback(input.screenshots, readPaths, failedReads, workDir) };
    },
  };
}
