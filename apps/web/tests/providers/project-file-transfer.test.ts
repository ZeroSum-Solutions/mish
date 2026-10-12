import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadProjectFiles } from '../../src/providers/registry';

afterEach(() => vi.unstubAllGlobals());

describe('legacy project transfer compatibility', () => {
  it('retains independent sibling outcomes instead of associating a failure with a batch tail', async () => {
    const names: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const files = (init.body as FormData).getAll('files') as File[];
      names.push(...files.map((file) => file.name));
      const file = files[0]!;
      if (file.name === 'first.txt') return new Response(JSON.stringify({ error: { code: 'UPLOAD_DENIED', message: 'First refused' } }), { status: 403 });
      return new Response(JSON.stringify({ files: [{ name: file.name, originalName: file.name, path: `folder/${file.name}`, size: file.size }] }));
    }));
    const result = await uploadProjectFiles('project', ['first.txt', 'second.txt', 'third.txt'].map((name) => new File(['a'], name)));
    expect(names).toEqual(['first.txt', 'second.txt', 'third.txt']);
    expect(result.failed).toEqual([{ name: 'first.txt', code: 'UPLOAD_DENIED', error: 'First refused' }]);
    expect(result.uploaded.map((file) => file.name)).toEqual(['second.txt', 'third.txt']);
  });

  it('keeps dir and Agency imageArtifact fields ahead of each file and preserves per-file missing outcomes', async () => {
    const fields: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      fields.push([...form.keys()]);
      expect(form.get('dir')).toBe('picked/folder'); expect(form.get('imageArtifact')).toBe('agency-artifact');
      const file = form.get('files') as File;
      return new Response(JSON.stringify({ files: file.name === 'missing.txt' ? [] : [{ name: file.name, path: `picked/folder/${file.name}` }] }));
    }));
    const result = await uploadProjectFiles('project', ['kept.txt', 'missing.txt'].map((name) => new File(['a'], name)), ' picked/folder ', null, 'agency-artifact');
    expect(fields).toEqual([['dir', 'imageArtifact', 'files'], ['dir', 'imageArtifact', 'files']]);
    expect(result.uploaded).toHaveLength(1); expect(result.failed.map((file) => file.name)).toEqual(['missing.txt']);
  });

  it('shares the same two-slot limit across concurrent helper callers', async () => {
    let active = 0; let peak = 0;
    const release: (() => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      const file = (init.body as FormData).get('files') as File;
      return new Response(JSON.stringify({ files: [{ name: file.name, path: file.name }] }));
    }));
    const a = uploadProjectFiles('a', [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    const b = uploadProjectFiles('b', [new File(['c'], 'c.txt')]);
    await vi.waitFor(() => expect(release).toHaveLength(2)); expect(peak).toBe(2);
    release[0]!(); release[1]!();
    await vi.waitFor(() => expect(release).toHaveLength(3)); release[2]!();
    const results = await Promise.all([a, b]); expect(results.flatMap((result) => result.uploaded)).toHaveLength(3); expect(peak).toBe(2);
  });
});
