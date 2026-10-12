import { createDecipheriv, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeAppConfig } from '../app-config.js';
import { deployConfigPath, readVercelConfig, writeVercelConfig } from '../deploy.js';
import { mediaConfigDir, readMaskedConfig, writeConfig } from '../media/config.js';
import { createAgencyJevKeyStore } from '../storage/agency-config.js';

const PROFILE_FILE = 'team-access.json';
const MARKER_FILE = 'team-access-installed.json';
const PROVIDERS = ['jev', 'deepseek', 'cerebras', 'kie', 'vercel'] as const;
type TeamProfile = Record<typeof PROVIDERS[number], string>;

function decodeEnvelope(bytes: Buffer): TeamProfile {
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error();
  const binary = (field: string, size?: number) => {
    const value = envelope[field];
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
    const buffer = Buffer.from(value, 'base64');
    if (buffer.toString('base64') !== value || (size !== undefined && buffer.length !== size)) throw new Error();
    return buffer;
  };
  // The wrapping key travels with this OWNER-APPROVED internal app. Encryption
  // avoids accidental plaintext disclosure; it cannot hide keys from recipients.
  const key = binary('wrappingKey', 32);
  let clear: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, binary('iv', 12));
    decipher.setAuthTag(binary('tag', 16));
    clear = Buffer.concat([decipher.update(binary('ciphertext')), decipher.final()]);
    const profile: unknown = JSON.parse(clear.toString('utf8'));
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) throw new Error();
    const record = profile as Record<string, unknown>;
    if (Object.keys(record).length !== PROVIDERS.length || !PROVIDERS.every(id =>
      typeof record[id] === 'string' && record[id].length > 0 && record[id].length <= 8192 && !/\s/.test(record[id]),
    )) throw new Error();
    return record as TeamProfile;
  } finally {
    key.fill(0);
    clear?.fill(0);
  }
}

/** Private build resource only. No HTTP endpoint accepts a provisioning file. */
export async function provisionBundledTeamAccess({ resourceRoot, dataDir, projectRoot }: {
  resourceRoot: string | null | undefined;
  dataDir: string;
  projectRoot: string;
}): Promise<'absent' | 'installed' | 'preserved'> {
  if (!resourceRoot) return 'absent';
  const profileFile = path.join(resourceRoot, PROFILE_FILE);
  let stat;
  try { stat = await lstat(profileFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new Error('Internal team access could not be initialized.');
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
    const marker = path.join(dataDir, MARKER_FILE);
    try {
      const installed = JSON.parse(await readFile(marker, 'utf8'));
      if (installed.version !== 1 || typeof installed.profileSha256 !== 'string') throw new Error();
      // A clear/change in Settings stays cleared/changed after restarting.
      return 'preserved';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Never provision into a legacy external state-directory override.
    if (path.dirname(deployConfigPath()) !== dataDir || mediaConfigDir(projectRoot) !== dataDir) throw new Error();
    const bytes = await readFile(profileFile);
    const profile = decodeEnvelope(bytes);
    const store = createAgencyJevKeyStore({ dataDir, readVaultSecret: async () => '', readModelVaultSecret: async () => '' });
    const local = (source: string) => source === 'stored' || source === 'env';
    if (!local((await store.status()).source)) await store.save(profile.jev);
    for (const id of ['deepseek', 'cerebras'] as const) {
      if (!local((await store.modelStatus(id)).source)) await store.saveModelKey(id, profile[id]);
    }
    const media = await readMaskedConfig(projectRoot);
    if (!local(media.providers.kie?.source ?? 'unset')) {
      const providers: Record<string, { preserveApiKey?: boolean; apiKey?: string; baseUrl: string; model?: string }> = Object.fromEntries(Object.entries(media.providers).map(([id, entry]) =>
        [id, { preserveApiKey: true, baseUrl: entry.baseUrl, ...(entry.model ? { model: entry.model } : {}) }],
      ));
      providers.kie = { ...providers.kie, apiKey: profile.kie, baseUrl: 'https://api.kie.ai' };
      await writeConfig(projectRoot, { providers });
    }
    if (!(await readVercelConfig()).token) await writeVercelConfig({ token: profile.vercel });
    await writeAppConfig(dataDir, { onboardingCompleted: true });
    await mkdir(dataDir, { recursive: true });
    const temp = `${marker}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, profileSha256: createHash('sha256').update(bytes).digest('hex') })}\n`, { mode: 0o600 });
    await rename(temp, marker);
    return 'installed';
  } catch {
    // JSON and crypto errors may include credential fragments. Never expose them.
    throw new Error('Internal team access could not be initialized.');
  }
}
