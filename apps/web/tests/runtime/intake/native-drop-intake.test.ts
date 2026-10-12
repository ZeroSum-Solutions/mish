// AC-R01.1 / AC-R01.4: one folder that cannot be listed must not discard the
// rest of the same drop gesture (loose files and folders that did expand).
import { describe, expect, it, vi } from 'vitest';
import type { MishHostDroppedDirectoryListing } from '@mish/host';
import { collectNativeDrop } from '../../../src/runtime/intake/native-drop-intake';
import type { DirectoryEntryLike } from '../../../src/runtime/intake/native-directory-drop';

function folder(name: string, files: Record<string, string>): DirectoryEntryLike {
  const pages: DirectoryEntryLike[][] = [Object.entries(files).map(([child, body]) => ({ isFile: true, isDirectory: false, name: child, fullPath: `/${name}/${child}`, file: (ok: (file: File) => void) => ok(new File([body], child)) })), []];
  return { isFile: false, isDirectory: true, name, fullPath: `/${name}`, createReader: () => ({ readEntries: (ok: (entries: DirectoryEntryLike[]) => void) => ok(pages.shift() ?? []) }) };
}
const messages = {
  unsupported: 'unsupported',
  refused: (folderName: string, items: string) => `refused ${folderName}: ${items}`,
  truncated: (folderName: string) => `truncated ${folderName}`,
  failed: (folderName: string, reason: string) => `failed ${folderName}: ${reason}`,
};

describe('collectNativeDrop', () => {
  it('keeps loose files and expanded folders when another folder in the same drop cannot be listed', async () => {
    const loose = new File(['l'], 'loose.txt');
    const good = new File([], 'Good'); const gone = new File([], 'Gone');
    const listing: MishHostDroppedDirectoryListing = { rootName: 'Good', files: [{ relativePath: 'a.txt', size: 1 }], refused: [], truncated: false };
    const host = { listDroppedDirectory: vi.fn(async (file: unknown) => {
      if (file === gone) throw new Error('The dropped folder is unavailable');
      return listing;
    }) };

    const result = await collectNativeDrop({
      files: [loose], hasDirectory: true,
      directories: [{ file: gone, entry: folder('Gone', { 'x.txt': 'x' }) }, { file: good, entry: folder('Good', { 'a.txt': 'a' }) }],
    }, host, messages);

    expect(result.files.map(file => file.name)).toEqual(['loose.txt', 'a.txt']);
    expect(result.reports).toEqual(['failed Gone: The dropped folder is unavailable']);
  });

  it('passes loose-file-only drops through without consulting the host', async () => {
    const host = { listDroppedDirectory: vi.fn() };
    const loose = new File(['l'], 'loose.txt');
    const result = await collectNativeDrop({ files: [loose], hasDirectory: false, directories: [] }, host, messages);
    expect(result).toEqual({ files: [loose], reports: [] });
    expect(host.listDroppedDirectory).not.toHaveBeenCalled();
  });
});
