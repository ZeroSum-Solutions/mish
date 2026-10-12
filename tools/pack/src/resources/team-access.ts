import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Opt-in Mac internal-build materialization. Actual profiles must remain ignored. */
export async function copyTeamAccessProfile({ namespace, resourceRoot, env = process.env }: {
  namespace: string;
  resourceRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const source = env.OD_TEAM_ACCESS_PROFILE;
  if (!source) return;
  try {
    if (namespace !== 'team-internal') throw new Error();
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
    const bytes = await readFile(source);
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' ||
      !['wrappingKey', 'iv', 'tag', 'ciphertext'].every(field => typeof envelope[field] === 'string')) throw new Error();
    await mkdir(resourceRoot, { recursive: true });
    await writeFile(join(resourceRoot, 'team-access.json'), bytes, { mode: 0o600 });
  } catch {
    throw new Error('tools-pack: invalid internal team access profile or namespace');
  }
}
