import { writePrivateMcpFile } from '../src/mcp-private-file.js';
import { mkdtemp, mkdir, rm, stat, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildBatchArchive, buildProjectArchive, listFiles, readProjectFile, resolveProjectFilePath, validateProjectPath } from '../src/projects.js';
import { listProjectFileVersions, readProjectFileVersion } from '../src/project-file-versions.js';
let root: string;
const canary = 'synthetic-agent-credential-canary';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-credentials-'));
  await mkdir(path.join(root, 'project'));
  await writeFile(path.join(root, 'project', '.mcp.json'), canary);
  await writeFile(path.join(root, 'project', 'index.html'), '<h1>Public</h1>');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it.each(['.mcp.json', '.mcp.json.synthetic.tmp', 'nested/.MCP.JSON', '.claude/settings.json', '.codex/config.toml', '.opencode/config.json'])('rejects reserved agent config %s', name => {
  expect(() => validateProjectPath(name)).toThrow('reserved project path');
});
it('blocks bytes and raw stream lookup for direct and symlinked config', async () => {
  await symlink('.mcp.json', path.join(root, 'project', 'public.json'));
  for (const name of ['.mcp.json', 'public.json']) {
    await expect(readProjectFile(root, 'project', name)).rejects.toThrow('reserved project path');
    await expect(resolveProjectFilePath(root, 'project', name)).rejects.toThrow('reserved project path');
  }
});
it('blocks credential file versions', async () => {
  await expect(listProjectFileVersions(root, 'project', '.mcp.json')).rejects.toThrow('reserved project path');
  await expect(readProjectFileVersion(root, 'project', '.mcp.json', '00000000-0000-4000-8000-000000000000')).rejects.toThrow('reserved project path');
});
it('omits credentials from listings and ZIP and refuses named export', async () => {
  const files = await listFiles(root, 'project');
  expect(files.map(file => file.name)).toEqual(['index.html']);
  const { buffer } = await buildProjectArchive(root, 'project', undefined);
  const zip = await JSZip.loadAsync(buffer);
  expect(Object.keys(zip.files)).not.toContain('.mcp.json');
  expect(await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(file => file.async('string')))).not.toContain(canary);
  await expect(buildBatchArchive(root, 'project', ['.mcp.json'])).rejects.toThrow();
});

it('writes credentials owner-only and replaces a symlink without modifying its target', async () => {
  const target = path.join(root, 'project', '.mcp.json');
  const victim = path.join(root, 'preserved.json');
  await writeFile(victim, 'preserved');
  await rm(target);
  await symlink(victim, target);
  await writePrivateMcpFile(target, canary);
  expect(await readFile(victim, 'utf8')).toBe('preserved');
  expect(await readFile(target, 'utf8')).toBe(canary);
  if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600);
});
