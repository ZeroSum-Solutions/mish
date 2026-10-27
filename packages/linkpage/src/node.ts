// The Claude command-line model client. It starts a process and writes files, so it lives apart from the
// pure engine: import it from '@mish/linkpage/node'.
//
// The same `json({ system, user, images })` as `createLlm`, answered by the `claude` command-line tool on the
// person's own Claude subscription instead of a metered API key. For building pages on a computer where
// Claude Code is signed in. Images are downloaded to a fresh folder so the model can look at them.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from './llm.ts';
import type { FetchFn, Llm, LlmRequest } from './types.ts';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Runs `claude` with these arguments in this folder and answers with what it printed. */
export type RunClaude = (args: string[], cwd: string) => Promise<string>;

const runClaude: RunClaude = (args, cwd) => new Promise((resolve, reject) => {
  const child = execFile('claude', args, { cwd, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`claude CLI failed: ${(stderr || err.message).slice(0, 300)}`)) : resolve(stdout)));
  child.stdin?.end();
});

export interface ClaudeCliOptions {
  model?: string;
  run?: RunClaude;
  fetch?: FetchFn;
}

export function createClaudeCliLlm({ model = 'sonnet', run = runClaude, fetch = globalThis.fetch }: ClaudeCliOptions = {}): Llm {
  return {
    async json({ system, user, images = [] }: LlmRequest): Promise<unknown> {
      const dir = await mkdtemp(join(tmpdir(), 'linkpage-'));
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
      const args = ['-p', '--model', model, '--allowedTools', 'Read', '--add-dir', dir, '--append-system-prompt', `${system}\nAnswer with one JSON object and nothing else.`, `${user}${look}`];
      return parse(await run(args, dir));
    },
  };
}
