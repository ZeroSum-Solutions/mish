import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Explicit developer build; no downloads, package defaults or automatic loader. */
export async function buildDarwinPlacementOwner(input: { sourcePath: string; outputPath: string; nodeIncludeDir: string; arch: 'arm64' | 'x86_64' }) {
  if (process.platform !== 'darwin' || process.versions.node !== '24.16.0' || ![input.sourcePath, input.outputPath, input.nodeIncludeDir].every(isAbsolute) || !['arm64', 'x86_64'].includes(input.arch)) throw new Error('Explicit Darwin paths and pinned Node24.16 runtime required');
  const headers = await Promise.all(['node_api.h', 'js_native_api.h', 'js_native_api_types.h', 'node_api_types.h', 'node_version.h'].map(async name => ({ path: join(input.nodeIncludeDir, name), sha256: hash(await readFile(join(input.nodeIncludeDir, name))) })));
  const version = await readFile(join(input.nodeIncludeDir, 'node_version.h'), 'utf8');
  if (!/^#define NODE_MAJOR_VERSION 24$/m.test(version) || !/^#define NODE_MINOR_VERSION 16$/m.test(version) || !/^#define NODE_PATCH_VERSION 0$/m.test(version)) throw new Error('Pinned Node24.16 headers required');
  const args = ['clang', '-arch', input.arch, '-mmacosx-version-min=13.0', '-std=c11', '-DNAPI_VERSION=10', '-Wall', '-Wextra', '-Werror', '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-I', input.nodeIncludeDir, input.sourcePath, '-o', input.outputPath];
  const sourceSHA256 = hash(await readFile(input.sourcePath));
  const compiler = await run('/usr/bin/xcrun', ['clang', '--version']);
  const sdk = await run('/usr/bin/xcrun', ['--show-sdk-path']);
  await run('/usr/bin/xcrun', args);
  return { path: input.outputPath, sha256: hash(await readFile(input.outputPath)), sourceSHA256, headers, command: ['/usr/bin/xcrun', ...args], compiler: compiler.stdout.trim(), sdk: sdk.stdout.trim(), arch: input.arch, node: process.versions.node, napi: 10, deploymentTarget: '13.0', activation: 'inactive' as const };
}
