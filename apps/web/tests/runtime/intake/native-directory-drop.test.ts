// AC-R01.1 renderer bridge for native folder drops: the desktop host lists the
// folder (confined, tree-relative), the renderer pairs that listing with the
// File objects of the drop gesture, and intake shows at most 20 per batch with
// explicit continuation. Synthetic entries here; the Finder drop is a native gate.
import { describe, expect, it, vi } from 'vitest';
import type { MishHostDroppedDirectoryListing } from '@mish/host';
import { expandDroppedDirectory, type DirectoryEntryLike } from '../../../src/runtime/intake/native-directory-drop';
import { IntakeStore } from '../../../src/runtime/intake/intake-store';

type Tree = { [name: string]: string | Tree };

function entryTree(name: string, tree: Tree, parent = '', reads: string[] = []): DirectoryEntryLike {
  const fullPath = `${parent}/${name}`;
  const children = Object.entries(tree).map(([child, value]) => typeof value === 'string'
    ? { isFile: true, isDirectory: false, name: child, fullPath: `${fullPath}/${child}`, file: (ok: (file: File) => void) => ok(new File([value], child)) }
    : entryTree(child, value, fullPath, reads));
  return {
    isFile: false, isDirectory: true, name, fullPath,
    createReader: () => {
      reads.push(fullPath);
      // Chromium hands entries back in pages; an empty page ends the listing.
      const pages = [children.slice(0, 2), children.slice(2), []];
      return { readEntries: (ok: (entries: DirectoryEntryLike[]) => void) => ok(pages.shift() ?? []) };
    },
  };
}

const listingOf = (files: string[], refused: MishHostDroppedDirectoryListing['refused'] = [], truncated = false): MishHostDroppedDirectoryListing => ({
  rootName: 'Brand Kit', files: files.map(relativePath => ({ relativePath, size: 1 })), refused, truncated,
});

describe('expandDroppedDirectory', () => {
  it('uploads only files the host listed, in listing order, and never reads refused folders', async () => {
    const reads: string[] = [];
    const root = entryTree('Brand Kit', {
      'b.txt': 'b', 'a.txt': 'a',
      nested: { 'c.txt': 'c' },
      // Chromium may follow a symlinked folder that points outside the tree.
      'escape-dir': { 'secret.txt': 'secret' },
      'escape-file.txt': 'secret',
    }, '', reads);
    const host = { listDroppedDirectory: vi.fn(async () => listingOf(['a.txt', 'b.txt', 'nested/c.txt'], [
      { relativePath: 'escape-dir', reason: 'symlink-outside-tree' },
      { relativePath: 'escape-file.txt', reason: 'symlink-outside-tree' },
    ])) };
    const dropped = new File([], 'Brand Kit');

    const expanded = await expandDroppedDirectory({ file: dropped, entry: root }, host);

    expect(host.listDroppedDirectory).toHaveBeenCalledExactlyOnceWith(dropped);
    expect(expanded?.files.map(file => file.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(expanded?.relativePaths).toEqual(['a.txt', 'b.txt', 'nested/c.txt']);
    expect(expanded?.refused).toEqual([
      { relativePath: 'escape-dir', reason: 'symlink-outside-tree' },
      { relativePath: 'escape-file.txt', reason: 'symlink-outside-tree' },
    ]);
    expect(reads).not.toContain('/Brand Kit/escape-dir');
    expect(await Promise.all(expanded!.files.map(file => file.text()))).not.toContain('secret');
  });

  it('reports a listed file the drop gesture did not deliver instead of hiding it', async () => {
    const root = entryTree('Brand Kit', { 'a.txt': 'a' });
    const host = { listDroppedDirectory: async () => listingOf(['a.txt', 'linked.txt'], [], true) };
    const expanded = await expandDroppedDirectory({ file: new File([], 'Brand Kit'), entry: root }, host);
    expect(expanded?.files.map(file => file.name)).toEqual(['a.txt']);
    expect(expanded?.refused).toEqual([{ relativePath: 'linked.txt', reason: 'unavailable' }]);
    expect(expanded?.truncated).toBe(true);
  });

  it('reports one unreadable listed file as unavailable and still delivers its siblings', async () => {
    const root = entryTree('Brand Kit', { 'a.txt': 'a', 'locked.txt': 'x', 'b.txt': 'b' });
    const original = root.createReader!;
    root.createReader = () => {
      const reader = original();
      return { readEntries: (ok, fail) => reader.readEntries(entries => ok(entries.map(entry => entry.name === 'locked.txt'
        ? { ...entry, file: (_ok: (file: File) => void, failure?: (error: unknown) => void) => failure?.(new Error('NotReadableError')) }
        : entry)), fail) };
    };
    const host = { listDroppedDirectory: async () => listingOf(['a.txt', 'locked.txt', 'b.txt']) };

    const expanded = await expandDroppedDirectory({ file: new File([], 'Brand Kit'), entry: root }, host);

    expect(expanded?.relativePaths).toEqual(['a.txt', 'b.txt']);
    expect(expanded?.files.map(file => file.name)).toEqual(['a.txt', 'b.txt']);
    expect(expanded?.refused).toEqual([{ relativePath: 'locked.txt', reason: 'unavailable' }]);
  });

  it('returns null without a native host listing, so the web keeps its folder notice', async () => {
    const root = entryTree('Brand Kit', { 'a.txt': 'a' });
    expect(await expandDroppedDirectory({ file: new File([], 'Brand Kit'), entry: root }, null)).toBeNull();
    expect(await expandDroppedDirectory({ file: new File([], 'Brand Kit'), entry: root }, { listDroppedDirectory: async () => null })).toBeNull();
    expect(await expandDroppedDirectory({ file: null, entry: root }, { listDroppedDirectory: async () => listingOf(['a.txt']) })).toBeNull();
  });

  it('shows at most 20 files per intake batch and keeps the rest as explicit continuation', async () => {
    const names = Array.from({ length: 25 }, (_, index) => `file-${String(index).padStart(2, '0')}.txt`);
    const root = entryTree('Brand Kit', Object.fromEntries(names.map(name => [name, name])));
    const expanded = await expandDroppedDirectory({ file: new File([], 'Brand Kit'), entry: root }, { listDroppedDirectory: async () => listingOf(names) });
    const api = { create: vi.fn(async () => { throw new Error('offline'); }), get: vi.fn(async () => { throw new Error('offline'); }), list: vi.fn(), put: vi.fn(), clear: vi.fn(), attach: vi.fn() };
    const store = new IntakeStore(api as never);

    const accepted = store.accept(expanded!.files, { destination: { kind: 'pending' }, context: null });

    expect(store.getSnapshot()[0]?.descriptors.map(file => file.filename)).toEqual(names.slice(0, 20));
    expect(accepted.remaining.map(file => file.name)).toEqual(names.slice(20));
    await accepted.settled;
  });
});
