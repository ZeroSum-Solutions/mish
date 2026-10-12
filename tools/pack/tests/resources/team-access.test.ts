import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { copyTeamAccessProfile } from '../../src/resources/team-access.js';

it('omits credentials by default and restricts explicit materialization to the team namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mm-pack-team-'));
  try {
    const resourceRoot = join(root, 'resources');
    await copyTeamAccessProfile({ namespace: 'default', resourceRoot, env: {} });
    await expect(readFile(join(resourceRoot, 'team-access.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const source = join(root, 'profile.json');
    const bytes = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', wrappingKey: 'test', iv: 'test', tag: 'test', ciphertext: 'test' });
    await writeFile(source, bytes);
    await expect(copyTeamAccessProfile({ namespace: 'default', resourceRoot, env: { OD_TEAM_ACCESS_PROFILE: source } })).rejects.toThrow('invalid internal team access profile or namespace');
    await copyTeamAccessProfile({ namespace: 'team-internal', resourceRoot, env: { OD_TEAM_ACCESS_PROFILE: source } });
    expect(await readFile(join(resourceRoot, 'team-access.json'), 'utf8')).toBe(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
