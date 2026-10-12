import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const run = promisify(execFile);
/** Explicit developer build only. No package/runtime loading or implicit output directory. */
export async function buildDarwinPlacementHelper(input: { sourcePath: string; outputPath: string; arch: 'arm64' | 'x86_64' }) {
  if (process.platform !== 'darwin' || !isAbsolute(input.sourcePath) || !isAbsolute(input.outputPath) || !['arm64', 'x86_64'].includes(input.arch)) throw new Error('Explicit Darwin source/output paths and supported build architecture required');
  const args = ['clang', '-arch', input.arch, '-mmacosx-version-min=13.0', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', input.sourcePath, '-o', input.outputPath];
  const sourceSHA256 = createHash('sha256').update(await readFile(input.sourcePath)).digest('hex');
  const compiler = await run('/usr/bin/xcrun', ['clang', '--version']);
  await run('/usr/bin/xcrun', args);
  return { path: input.outputPath, sha256: createHash('sha256').update(await readFile(input.outputPath)).digest('hex'), sourceSHA256, arch: input.arch, deploymentTarget: '13.0', command: ['/usr/bin/xcrun', ...args], compiler: compiler.stdout.trim(), activation: 'inactive' as const };
}
