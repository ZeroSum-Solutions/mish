import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURE_DRAFT_MODEL_JSON_SCHEMA, parseCaptureDraftModelOutput } from '@open-design/contracts';
import { renderCaptureDraftPrompt } from '../../prompts/capture-draft.js';
import { stripRasterMetadata } from './image-metadata.js';
import { resolveAgentBin } from '../../runtimes/resolution.js';
import { maxLaneEnv, readRuleFor, runClaudeProcess, summarizeClaudeStream, type ClaudeProcessRunner } from '../review/reviewers/claude-visual.js';
import type { CaptureDraftGenerator } from './draft-service.js';

export interface CaptureDraftGeneratorOptions { dataDir: string; resolveBin?: () => string | null; run?: ClaudeProcessRunner; env?: NodeJS.ProcessEnv; model?: string }

/** Reuses the existing Max OAuth subprocess/vision boundary. Only staged screenshot Read is allowed. */
export function createClaudeMaxCaptureDraftGenerator(options: CaptureDraftGeneratorOptions): CaptureDraftGenerator {
  if (!path.isAbsolute(options.dataDir)) throw new Error('Draft generation needs the resolved daemon data root');
  const modelId = options.model ?? 'claude-sonnet-5-5';
  const resolveBin = options.resolveBin ?? (() => resolveAgentBin('claude'));
  const run = options.run ?? runClaudeProcess;
  return {
    modelId,
    async available() { return resolveBin() !== null; },
    async generate(input, signal) {
      const command = resolveBin(); if (!command || signal.aborted) throw new Error('Draft lane unavailable');
      const root = path.join(options.dataDir, 'workbench-capture-drafts', 'generation');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const cwd = await mkdtemp(path.join(root, 'turn-'));
      const extension = input.capture.image.mediaType === 'image/jpeg' ? 'jpg' : input.capture.image.mediaType === 'image/webp' ? 'webp' : 'png';
      const imagePath = path.join(cwd, `capture.${extension}`);
      try {
        await writeFile(imagePath, stripRasterMetadata(input.image), { flag: 'wx', mode: 0o600 });
        const prompt = renderCaptureDraftPrompt({ captureId: input.capture.id, prompt: input.prompt, ...(input.currentHtml ? { currentHtml: input.currentHtml } : {}) });
        const response = await run({ command, cwd, env: maxLaneEnv(options.env ?? process.env), signal,
          args: ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelId, '--tools', 'Read', '--allowedTools', readRuleFor(cwd), '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--add-dir', cwd, '--system-prompt', prompt.system, '--json-schema', JSON.stringify(CAPTURE_DRAFT_MODEL_JSON_SCHEMA)],
          stdin: `Read the screenshot at ${JSON.stringify(imagePath)} before answering.\n${prompt.user}`,
        });
        const observed = summarizeClaudeStream(response.stdout);
        if (response.exitCode !== 0 || !observed.result || observed.result.is_error || !observed.readPaths.has(path.resolve(imagePath))) throw new Error('The screenshot was not read by the subscription lane');
        const result = observed.result.structured_output ?? JSON.parse(typeof observed.result.result === 'string' ? observed.result.result : 'null');
        return parseCaptureDraftModelOutput(result);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    },
  };
}
