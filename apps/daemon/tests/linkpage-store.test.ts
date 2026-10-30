import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LinkPageSpec } from '@mish/contracts';
import { createLinkPageStore } from '../src/linkpage/store.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'od-linkpage-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const font = { family: 'Inter', kind: 'sans' as const, stack: 'Arial, sans-serif', google: false };
const spec = (slug: string, name = 'Sam'): LinkPageSpec => ({
  version: 1,
  slug,
  profile: { name, headline: '', bio: '', about: '', themes: [], avatar_url: '', site_url: '' },
  theme: {
    mood: 'modern', radius: 12, background: 'mesh',
    palette: { bg: '#ffffff', surface: '#f0f0f0', text: '#111111', muted: '#555555', accent: '#2255aa', accentText: '#ffffff', dark: false },
    fonts: { heading: font, body: font },
  },
  blocks: [],
});

describe('link page store', () => {
  it('keeps pages under <data root>/linkpages and keeps createdAt across updates', async () => {
    const store = createLinkPageStore(dir);
    const first = await store.put({ spec: spec('sam'), connectedAccounts: { tiktok: 'ca_1' } });
    const second = await store.put({ spec: spec('sam', 'Sam 2') });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.connectedAccounts).toEqual({ tiktok: 'ca_1' });
    expect(await readdir(path.join(dir, 'linkpages', 'sam'))).toEqual(['page.json']);
    expect((await store.get('sam'))?.spec.profile.name).toBe('Sam 2');
  });

  it('lists newest first and skips folders that are not valid pages', async () => {
    const store = createLinkPageStore(dir);
    await store.put({ spec: spec('a') });
    await new Promise((r) => setTimeout(r, 5));
    await store.put({ spec: spec('b') });
    await mkdir(path.join(dir, 'linkpages', 'Not_A_Slug'), { recursive: true });
    await mkdir(path.join(dir, 'linkpages', 'broken'), { recursive: true });
    await writeFile(path.join(dir, 'linkpages', 'broken', 'page.json'), '{not json');
    expect((await store.list()).map((p) => p.slug)).toEqual(['b', 'a']);
  });

  it('returns an empty list before any page exists', async () => {
    expect(await createLinkPageStore(dir).list()).toEqual([]);
  });

  it('refuses any slug that is not a slug before it touches the disk', async () => {
    const store = createLinkPageStore(dir);
    for (const slug of ['..', '../x', 'a/b', 'A', '', '.hidden']) {
      await expect(store.get(slug)).rejects.toThrow(/invalid link page slug/);
      await expect(store.delete(slug)).rejects.toThrow(/invalid link page slug/);
      await expect(store.assets(slug)).rejects.toThrow(/invalid link page slug/);
    }
    await expect(store.put({ spec: spec('../evil') })).rejects.toThrow(/invalid link page slug/);
  });

  it('deletes a page and reports a missing one', async () => {
    const store = createLinkPageStore(dir);
    await store.put({ spec: spec('sam') });
    expect(await store.delete('sam')).toBe(true);
    expect(await store.delete('sam')).toBe(false);
    expect(await store.get('sam')).toBeNull();
  });

  it('reads assets with plain names only', async () => {
    const store = createLinkPageStore(dir);
    await store.put({ spec: spec('sam') });
    await mkdir(path.join(dir, 'linkpages', 'sam', 'assets', 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'linkpages', 'sam', 'assets', 'avatar.png'), 'x');
    await writeFile(path.join(dir, 'linkpages', 'sam', 'assets', 'bad name.png'), 'x');
    expect((await store.assets('sam')).map((a) => a.name)).toEqual(['avatar.png']);
  });
});
