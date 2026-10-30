// The Claude command-line model client. It starts a process and writes files, so it lives apart from the
// pure engine: import it from '@mish/linkpage/node'.
//
// The same `json({ system, user, images })` as `createLlm`, answered by the `claude` command-line tool on the
// person's own Claude subscription instead of a metered API key. For building pages on a computer where
// Claude Code is signed in. Images are downloaded to a fresh folder so the model can look at them.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from './llm.ts';
import type { FetchFn, Llm, LlmRequest } from './types.ts';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Runs `claude` (the executable) with these arguments in this folder, the prompt on stdin, and answers with what it printed. */
export type RunClaude = (args: string[], cwd: string, input: string, executable: string) => Promise<string>;

const runClaude: RunClaude = (args, cwd, input, executable) => new Promise((resolve, reject) => {
  const child = execFile(executable, args, { cwd, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`claude CLI failed: ${(stderr || err.message).slice(0, 300)}`)) : resolve(stdout)));
  child.stdin?.end(input);
});

// The model reads web text it did not write, so it gets the least it can work with: one tool (Read), no MCP
// servers, none of the owner's settings, hooks, skills or CLAUDE.md, and nothing that asks for permission.
export const CLAUDE_LOCKDOWN_ARGS = [
  '--tools', 'Read', '--allowedTools', 'Read',
  '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
  '--permission-mode', 'dontAsk',
];

export interface ClaudeCliOptions {
  model?: string;
  run?: RunClaude;
  /** The resolved path of the `claude` program; defaults to `claude` on PATH. */
  executable?: string;
  fetch?: FetchFn;
}

export function createClaudeCliLlm({ model = 'sonnet', run = runClaude, executable = 'claude', fetch = globalThis.fetch }: ClaudeCliOptions = {}): Llm {
  return {
    async json({ system, user, images = [] }: LlmRequest): Promise<unknown> {
      const dir = await mkdtemp(join(tmpdir(), 'linkpage-'));
      try {
        const files: string[] = [];
        for (const [i, url] of images.entries()) {
          try {
            const res = await fetch(url);
            const ext = EXT[(res.headers.get('content-type') || '').split(';')[0] as string];
            if (!res.ok || !ext) continue;
            const path = join(dir, `image-${i + 1}.${ext}`);
            await writeFile(path, Buffer.from(await res.arrayBuffer()));
            files.push(path);
          } catch { /* an image that will not download is skipped */ }
        }
        const look = files.length ? `\n\nLook at these image files with the Read tool before answering:\n${files.join('\n')}` : '';
        const args = ['-p', '--model', model, ...CLAUDE_LOCKDOWN_ARGS, '--add-dir', dir, '--append-system-prompt', `${system}\nAnswer with one JSON object and nothing else.`];
        return parse(await run(args, dir, `${user}${look}`, executable));
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
