// The design-system catalogue is re-read on every Home load, and parsing ~130
// kits (swatch and colour regexes over every DESIGN.md) costs the daemon
// ~100 ms of CPU per call, more under load. The listing cache must skip that
// work when nothing changed and must never serve a stale kit: any write the
// listing reads (DESIGN.md, metadata.json, manifest.json, the preview, a kit
// added or removed) invalidates it.

import { chmod, mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listDesignSystems } from '../../src/design-systems/index.js';
import { createDesignSystemListingCache } from '../../src/design-systems/listing-cache.js';

let root: string;

async function writeKit(id: string, body: string, metadata?: Record<string, unknown>) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, 'DESIGN.md'), body, 'utf8');
  if (metadata) {
    await writeFile(path.join(root, id, 'metadata.json'), JSON.stringify(metadata), 'utf8');
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-ds-listing-cache-'));
  await writeKit('alpha', '# Alpha\n\n## Color Palette\n- Red #ff0000\n');
  await writeKit('beta', '# Beta\n\nBeta kit.\n', { status: 'draft' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = { idPrefix: 'user:', source: 'user' as const, isEditable: true, defaultStatus: 'draft' as const };

describe('design-system listing cache', () => {
  it('serves an unchanged catalogue without re-parsing it', async () => {
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list);
    const first = await cached(root, OPTIONS);
    const second = await cached(root, OPTIONS);
    expect(list).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // Callers get their own copies: mutating one answer cannot leak.
    second[0]!.title = 'mutated';
    expect((await cached(root, OPTIONS))[0]!.title).not.toBe('mutated');
  });

  it('keys the cache by listing options', async () => {
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list);
    await cached(root, OPTIONS);
    await cached(root, { ...OPTIONS, idPrefix: 'other:' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['DESIGN.md is edited', async () => {
      await writeFile(path.join(root, 'alpha', 'DESIGN.md'), '# Alpha Two\n', 'utf8');
    }],
    ['metadata.json changes status', async () => {
      await writeFile(path.join(root, 'beta', 'metadata.json'), JSON.stringify({ status: 'published' }), 'utf8');
    }],
    ['a manifest is added', async () => {
      await writeFile(path.join(root, 'alpha', 'manifest.json'), '{}', 'utf8');
    }],
    ['a preview image is added', async () => {
      await mkdir(path.join(root, 'alpha', 'assets'), { recursive: true });
      await writeFile(path.join(root, 'alpha', 'assets', 'preview.jpg'), 'jpg', 'utf8');
    }],
    ['a kit is installed', async () => {
      await writeKit('gamma', '# Gamma\n');
    }],
    ['a kit is removed', async () => {
      await rm(path.join(root, 'beta'), { recursive: true, force: true });
    }],
  ])('re-reads the catalogue when %s', async (_label, change) => {
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list);
    await cached(root, OPTIONS);
    await change();
    const after = await cached(root, OPTIONS);
    expect(list).toHaveBeenCalledTimes(2);
    expect(after).toEqual(await listDesignSystems(root, OPTIONS));
  });

  it('notices a same-size rewrite within the same millisecond', async () => {
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list);
    await cached(root, OPTIONS);
    const file = path.join(root, 'alpha', 'DESIGN.md');
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    await utimes(file, stamp, stamp);
    await cached(root, OPTIONS);
    await writeFile(file, '# Alphb\n\n## Color Palette\n- Red #ff0000\n', 'utf8');
    await utimes(file, stamp, stamp);
    const after = await cached(root, OPTIONS);
    expect(after.find((s) => s.id === 'user:alpha')?.title).toBe('Alphb');
  });

  it('never caches a root that does not exist', async () => {
    const list = vi.fn(async () => []);
    const cached = createDesignSystemListingCache(list);
    await cached(path.join(root, 'missing'));
    await cached(path.join(root, 'missing'));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not store a listing whose kit reads failed, so the next request retries', async () => {
    let calls = 0;
    const list = vi.fn(async (_root: string, options?: { onEntryError?: (id: string, error: unknown) => void }) => {
      calls += 1;
      if (calls === 1) {
        options?.onEntryError?.('alpha', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
        return [];
      }
      return listDesignSystems(root, OPTIONS);
    });
    const cached = createDesignSystemListingCache(list);
    expect(await cached(root, OPTIONS)).toEqual([]);
    const retried = await cached(root, OPTIONS);
    expect(list).toHaveBeenCalledTimes(2);
    expect(retried.map((s) => s.id).sort()).toEqual(['user:alpha', 'user:beta']);
  });

  it('shares one in-flight listing between concurrent callers (startup warm-up and first request)', async () => {
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list);
    const [warm, first] = await Promise.all([cached(root, OPTIONS), cached(root, OPTIONS)]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(first).toEqual(warm);
  });

  it('rebuilds after a bounded age even when the fingerprint is unchanged (coarse timestamps)', async () => {
    let now = 0;
    const list = vi.fn(listDesignSystems);
    const cached = createDesignSystemListingCache(list, { maxAgeMs: 60_000, now: () => now });
    await cached(root, OPTIONS);
    now = 59_000;
    await cached(root, OPTIONS);
    expect(list).toHaveBeenCalledTimes(1);
    now = 60_001;
    await cached(root, OPTIONS);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('listDesignSystems read-failure reporting', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a kit whose files exist but cannot be read',
    async () => {
      const file = path.join(root, 'alpha', 'DESIGN.md');
      await chmod(file, 0o000);
      const failed: string[] = [];
      try {
        const listed = await listDesignSystems(root, {
          ...OPTIONS,
          onEntryError: (id) => failed.push(id),
        });
        expect(listed.map((s) => s.id)).toEqual(['user:beta']);
        expect(failed).toEqual(['alpha']);
      } finally {
        await chmod(file, 0o644);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable metadata.json instead of treating it as empty',
    async () => {
      const file = path.join(root, 'beta', 'metadata.json');
      await chmod(file, 0o000);
      const failed: string[] = [];
      try {
        await listDesignSystems(root, { ...OPTIONS, onEntryError: (id) => failed.push(id) });
        expect(failed).toEqual(['beta']);
      } finally {
        await chmod(file, 0o644);
      }
    },
  );
});
