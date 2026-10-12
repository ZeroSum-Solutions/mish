import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('D22 rejects inherited command %s', async (command) => {
  await expect(exec(process.execPath, ['--import', 'tsx', entry, command], { timeout: 10_000 })).rejects.toMatchObject({
    code: 2, stderr: expect.stringContaining(`unknown command: od ${command}`),
  });
});
