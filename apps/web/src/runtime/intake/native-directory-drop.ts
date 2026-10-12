import type { MishHostDroppedDirectoryListing, MishHostDroppedDirectoryRefusal } from '@mish/host';

/** The FileSystemEntry surface Chromium gives a drop (`webkitGetAsEntry`). */
export interface DirectoryEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: DirectoryEntryLike[]) => void, failure?: (error: unknown) => void) => void };
}

export interface DroppedDirectory { file: File | null; entry: DirectoryEntryLike }

export interface DirectoryIntakeHost {
  listDroppedDirectory(file: unknown): Promise<MishHostDroppedDirectoryListing | null>;
}

export type DirectoryRefusal = MishHostDroppedDirectoryRefusal | 'unavailable';

export interface ExpandedDirectory {
  rootName: string;
  /** Files to upload, in the host listing's order. */
  files: File[];
  relativePaths: string[];
  /** Every discovered entry that will not be uploaded, with its reason. */
  refused: Array<{ relativePath: string; reason: DirectoryRefusal }>;
  truncated: boolean;
}

const readPage = (reader: ReturnType<NonNullable<DirectoryEntryLike['createReader']>>) =>
  new Promise<DirectoryEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
const readFile = (entry: DirectoryEntryLike) =>
  new Promise<File>((resolve, reject) => entry.file ? entry.file(resolve, reject) : reject(new Error('Not a file entry')));
/** Reads one listed file; a file that cannot be read yields null so it is reported, never fatal to its siblings. */
const readFileOrNull = (entry: DirectoryEntryLike) => readFile(entry).catch(() => null);

/**
 * Pairs the native host's confined listing with the drop gesture's own File
 * objects (AC-R01.1). Invariants:
 * - Only files the host listed are returned; the host is the authority on
 *   symlink confinement, so a File Chromium reached through a link outside the
 *   tree is never uploaded, and a refused folder is never even read.
 * - Every listed file the gesture did not deliver is reported `unavailable`,
 *   including one whose read fails; one unreadable file never drops its siblings.
 * - Without a native listing (web build, old host, or a File with no native
 *   path) this returns null and the caller keeps its folder notice.
 */
export async function expandDroppedDirectory(directory: DroppedDirectory, host: DirectoryIntakeHost | null): Promise<ExpandedDirectory | null> {
  if (!host || !directory.file) return null;
  const listing = await host.listDroppedDirectory(directory.file);
  if (!listing) return null;
  const wanted = new Set(listing.files.map(file => file.relativePath));
  const refusedFolders = new Set(listing.refused.map(entry => entry.relativePath));
  const wantedFolders = new Set(listing.files.flatMap(file => {
    const parts = file.relativePath.split('/');
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }));
  const found = new Map<string, File>();
  const walk = async (entry: DirectoryEntryLike, prefix: string): Promise<void> => {
    const reader = entry.createReader?.();
    if (!reader) return;
    for (let page = await readPage(reader); page.length > 0; page = await readPage(reader)) {
      for (const child of page) {
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
        if (refusedFolders.has(relativePath)) continue;
        if (child.isDirectory && wantedFolders.has(relativePath)) await walk(child, relativePath);
        else if (child.isFile && wanted.has(relativePath)) {
          const file = await readFileOrNull(child);
          if (file) found.set(relativePath, file);
        }
      }
    }
  };
  await walk(directory.entry, '');
  const delivered = listing.files.filter(file => found.has(file.relativePath));
  return {
    rootName: listing.rootName,
    files: delivered.map(file => found.get(file.relativePath)!),
    relativePaths: delivered.map(file => file.relativePath),
    refused: [
      ...listing.refused,
      ...listing.files.filter(file => !found.has(file.relativePath)).map(file => ({ relativePath: file.relativePath, reason: 'unavailable' as const })),
    ],
    truncated: listing.truncated,
  };
}
