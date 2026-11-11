// The community pet catalogs are remote JSON. A spritesheet URL inside a
// listing must never point the daemon at loopback, private or metadata
// addresses: those pets are reported as failed and nothing is written.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncCommunityPets } from '../src/community-pets-sync.js';

const HATCHERY_LIST = 'https://j20.nz/hatchery/api/pets.json';
// A minimal valid WEBP header, so only the egress guard can refuse the pet.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

describe('community pet sync egress guard', () => {
  let codexHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(tmpdir(), 'od-pets-ssrf-'));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it.each([
    'http://169.254.169.254/x.webp',
    'http://127.0.0.1:9/x.webp',
    'http://[::ffff:a9fe:a9fe]/x.webp',
  ])('never fetches a listed spritesheet at %s and writes nothing', async (spritesheetUrl) => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (url === HATCHERY_LIST) {
        return new Response(
          JSON.stringify({ pets: [{ id: 'evil', petManifestId: 'evil', displayName: 'Evil', spritesheetUrl }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch);

    const result = await syncCommunityPets({ source: 'hatchery' });

    expect(requested).toEqual([HATCHERY_LIST]);
    expect(result).toMatchObject({ wrote: 0, failed: 1, total: 1 });
    expect(existsSync(path.join(codexHome, 'pets', 'evil'))).toBe(false);
  });

  it('control: a public spritesheet is fetched and written', async () => {
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === HATCHERY_LIST) {
        return new Response(
          JSON.stringify({ pets: [{ id: 'good', petManifestId: 'good', displayName: 'Good', spritesheetUrl: 'https://cdn.example.com/good.webp' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
    }) as typeof fetch);

    const result = await syncCommunityPets({ source: 'hatchery' });

    expect(result).toMatchObject({ wrote: 1, failed: 0 });
    expect(existsSync(path.join(codexHome, 'pets', 'good', 'spritesheet.webp'))).toBe(true);
  });
});
