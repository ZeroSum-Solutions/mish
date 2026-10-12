import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentBin } from '../../runtimes/resolution.js';
import { maxLaneEnv, runClaudeProcess, summarizeClaudeStream, type ClaudeProcessRunner } from '../review/reviewers/claude-visual.js';
import { DESIGN_BRIEF_MODEL_JSON_SCHEMA } from './prompt.js';

export interface BriefGeneratorInput { system: string; user: string }
/** The model's raw JSON text plus the model id the lane itself reported, or null when it reported none. */
export interface BriefGeneration {
  text: string;
  reportedModel: string | null;
  /** The model this call asked for, when a generator chooses per call; otherwise the service records `modelId`. */
  requestedModel?: string;
}
export type BriefGeneratorAvailability = { available: true } | { available: false; reason: string; recovery: string };

/** One approved model lane for the transformer. Tests inject fakes; no unit test reaches a provider. */
export interface BriefGenerator {
  id: string;
  modelId: string;
  billingLane: string;
  /** Upper bound on prompt characters this lane accepts after host/output reserve. */
  maxInputChars: number;
  available(): Promise<BriefGeneratorAvailability>;
  /** Returns the model's raw JSON text and reported model. Errors carry no provider body. */
  generate(input: BriefGeneratorInput, signal: AbortSignal, transient?: boolean): Promise<BriefGeneration>;
}

export class BriefGeneratorError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); this.name = 'BriefGeneratorError'; }
}

/**
 * Concrete Sonnet id on the Max subscription. Pinned because the bare `sonnet`
 * alias resolves to an older Sonnet on some CLI builds; the model the CLI
 * actually ran is recorded separately from its init frame.
 */
export const BRIEF_TRANSFORMER_MODEL = 'claude-sonnet-5-5';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/u;

/** A provider-reported model id fit for the stored record, or null. Never a blank, overlong or odd string. */
export function reportedModelId(value: unknown): string | null {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : null;
}

/** The `model` of the stream-json `system`/`init` frame, or null. Never inferred from the requested id. */
export function reportedInitModel(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { continue; }
    if (!frame || typeof frame !== 'object') continue;
    const { type, subtype, model } = frame as { type?: unknown; subtype?: unknown; model?: unknown };
    if (type !== 'system' || subtype !== 'init') continue;
    return typeof model === 'string' && MODEL_ID.test(model.trim()) ? model.trim() : null;
  }
  return null;
}

export interface ClaudeMaxBriefGeneratorOptions {
  /** Empty scratch directory under the daemon data root; the turn has no tools, so nothing is read from it. */
  workDir: string;
  /** The resolved daemon data root, for temporary project-less transformer turns. */
  transientWorkRoot?: string;
  resolveBin?: () => string | null;
  run?: ClaudeProcessRunner;
  env?: NodeJS.ProcessEnv;
  model?: string;
  /** The same no-tool subscription lane also serves typed evidence judgments. */
  jsonSchema?: unknown;
}

/** `claude -p` with no tools, no MCP, no session and a JSON schema: a pure text-to-JSON turn on the Max subscription. */
export function claudeBriefArgs(model: string, system: string, jsonSchema: unknown = DESIGN_BRIEF_MODEL_JSON_SCHEMA): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--tools', '', '--permission-mode', 'dontAsk',
    '--restricted', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', system,
    '--json-schema', JSON.stringify(jsonSchema),
  ];
}

/**
 * The transformer's production lane: the daemon's existing `claude` spawn on
 * the Max OAuth subscription. The child environment is an allowlist with no
 * API-key variable, so the CLI cannot fall back to a billed key and no daemon
 * secret reaches a turn that reads user and reference text.
 */
export function createClaudeMaxBriefGenerator(options: ClaudeMaxBriefGeneratorOptions): BriefGenerator {
  const model = options.model ?? BRIEF_TRANSFORMER_MODEL;
  const resolveBin = options.resolveBin ?? (() => resolveAgentBin('claude'));
  const run = options.run ?? runClaudeProcess;
  return {
    id: 'claude-max', modelId: model, billingLane: 'max-subscription', maxInputChars: 120_000,
    async available() {
      return resolveBin() ? { available: true } : { available: false, reason: 'The Claude Code CLI is not installed or not on the daemon PATH', recovery: 'Install Claude Code and sign in with the Max subscription, or use your original prompt.' };
    },
    async generate(input, signal, transient = false) {
      const command = resolveBin();
      if (!command) throw new BriefGeneratorError('The Claude Code CLI is not available', 'Install Claude Code and sign in, then try Improve prompt again.');
      let cwd = path.resolve(options.workDir);
      let temporary = false;
      let result;
      try {
        if (transient) {
          const root = options.transientWorkRoot;
          if (!root) throw new Error('No transient transformer root configured');
          cwd = await mkdtemp(path.join(path.resolve(root), 'brief-preview-'));
          temporary = true;
        } else await mkdir(cwd, { recursive: true, mode: 0o700 });
        result = await run({ command, args: claudeBriefArgs(model, input.system, options.jsonSchema), stdin: input.user, cwd, env: maxLaneEnv(options.env ?? process.env), signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new BriefGeneratorError('The Claude Code CLI could not start', 'Check the Claude Code install, then try again.');
      } finally {
        if (temporary) await rm(cwd, { recursive: true, force: true });
      }
      const { result: envelope } = summarizeClaudeStream(result.stdout);
      if (!envelope || result.exitCode !== 0 || envelope.is_error === true) {
        throw new BriefGeneratorError('The Claude Code CLI did not return a brief', 'Run `claude auth status` to confirm the Max sign-in, then try again.');
      }
      const reportedModel = reportedInitModel(result.stdout);
      if (envelope.structured_output !== undefined && envelope.structured_output !== null) return { text: JSON.stringify(envelope.structured_output), reportedModel };
      return { text: typeof envelope.result === 'string' ? envelope.result : '', reportedModel };
    },
  };
}
