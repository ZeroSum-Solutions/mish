import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAppConfig } from '../src/app-config.js';
import { configureDeployDataDir, readVercelConfig, writeVercelConfig } from '../src/deploy.js';
import { mediaConfigDir } from '../src/media/config.js';
import { provisionBundledTeamAccess } from '../src/services/team-access.js';
import { createAgencyJevKeyStore } from '../src/storage/agency-config.js';

vi.mock('../src/media/higgsfield-runtime.js', () => ({ higgsfieldSubscriptionConfigured: async () => false }));

const profile = { jev: 'test-jev', deepseek: 'test-deepseek', cerebras: 'test-cerebras', kie: 'test-kie', vercel: 'test-vercel' };
function envelope(input: unknown = profile) {
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(input)), cipher.final()]);
  return { version: 1, algorithm: 'aes-256-gcm', wrappingKey: key.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

describe('internal team first launch', () => {
  let root: string, dataDir: string, resourceRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mm-team-access-'));
    dataDir = path.join(root, 'data'); resourceRoot = path.join(root, 'resources');
    await mkdir(resourceRoot);
    for (const key of ['OD_USER_STATE_DIR', 'OD_MEDIA_CONFIG_DIR', 'TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY', 'CEREBRAS_API_KEY', 'KIE_API_KEY', 'KIE_AI_API_KEY', 'OD_KIE_API_KEY']) vi.stubEnv(key, '');
    vi.stubEnv("OD_DATA_DIR", dataDir);
    configureDeployDataDir(dataDir);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const provision = () => provisionBundledTeamAccess({ resourceRoot, dataDir, projectRoot: path.join(root, "apps", "workspace") });
  const store = () => createAgencyJevKeyStore({ dataDir, readVaultSecret: async () => '' });
  const putProfile = (value = envelope()) => writeFile(path.join(resourceRoot, 'team-access.json'), JSON.stringify(value));

  it('leaves an ordinary build untouched', async () => {
    expect(await provision()).toBe('absent');
    await expect(readFile(path.join(dataDir, 'agency-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('installs all five keys before onboarding and does not restore cleared keys on restart', async () => {
    await putProfile(); expect(await provision()).toBe('installed');
    expect(await store().resolveKey()).toBe(profile.jev);
    expect(await store().resolveModelKey('deepseek')).toBe(profile.deepseek);
    expect(await store().resolveModelKey('cerebras')).toBe(profile.cerebras);
    expect(JSON.parse(await readFile(path.join(dataDir, 'media-config.json'), 'utf8')).providers.kie.apiKey).toBe(profile.kie);
    expect((await readVercelConfig()).token).toBe(profile.vercel);
    expect((await readAppConfig(dataDir)).onboardingCompleted).toBe(true);
    await store().clear();
    expect(await provision()).toBe('preserved');
    expect((await store().status()).configured).toBe(false);
  });
  it('keeps saved credentials and media aliases while filling missing providers', async () => {
    await store().save('existing-jev'); await writeVercelConfig({ token: 'existing-vercel' });
    await writeFile(path.join(dataDir, 'media-config.json'), JSON.stringify({ providers: { fal: { apiKey: 'existing-fal', baseUrl: '' } }, aliases: { custom: 'existing-model' } }));
    await putProfile(); expect(await provision()).toBe('installed');
    expect(await store().resolveKey()).toBe('existing-jev');
    expect((await readVercelConfig()).token).toBe('existing-vercel');
    const media = JSON.parse(await readFile(path.join(dataDir, 'media-config.json'), 'utf8'));
    expect(media.providers.fal.apiKey).toBe('existing-fal');
    expect(media.aliases.custom).toBe('existing-model');
  });
  it('resolves a relative media override against the same project root as the HTTP routes', async () => {
    vi.stubEnv('OD_MEDIA_CONFIG_DIR', '../../data');
    // The previous dataDir-as-projectRoot guard rejected this valid override.
    expect(mediaConfigDir(dataDir)).not.toBe(dataDir);
    await putProfile();
    expect(await provision()).toBe('installed');
    expect(JSON.parse(await readFile(path.join(dataDir, 'media-config.json'), 'utf8')).providers.kie.apiKey).toBe(profile.kie);
  });
  it.each(['tamper', 'extra-provider', 'bad-key'])('refuses %s before writing a credential', async (kind) => {
    const value = kind === 'extra-provider' ? envelope({ ...profile, unrelated: 'test-other' }) :
      kind === 'bad-key' ? envelope({ ...profile, vercel: 'bad key' }) : envelope();
    if (kind === 'tamper') value.tag = randomBytes(16).toString('base64');
    await putProfile(value);
    await expect(provision()).rejects.toThrow('Internal team access could not be initialized.');
    await expect(readFile(path.join(dataDir, 'agency-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
