/**
 * Directory intake confinement for native folder drops (AC-R01.1).
 *
 * Invariants:
 * - Every discovered entry is reported: a regular file in `files`, anything
 *   that will not be uploaded in `refused` with a reason. Nothing is dropped
 *   silently; a discovery bound sets `truncated`.
 * - Symlinks are never followed out of the selected tree. A symlink whose real
 *   target is outside the tree is refused without reading the target. An
 *   in-tree file symlink is listed; an in-tree directory symlink is not
 *   traversed (no loops, no duplicates).
 * - Application/plug-in bundles are reported as `bundle`, never expanded.
 * - The listing carries only tree-relative paths. Absolute paths stay in the
 *   main process; file bytes are never read here. The renderer uploads only the
 *   `File` objects of the drop gesture whose relative paths appear in `files`.
 *
 * Known limit (accepted): the listing is a point-in-time decision. Main never
 * opens or reads a listed file, so an open-plus-fstat check here would not
 * cover the upload. The bytes come from Chromium's drop-time directory reader
 * in the renderer. A process that swaps an in-tree symlink's target between
 * this listing and that read can still change what is uploaded. That needs
 * concurrent write access to the exact tree the user is dragging.
 */
import { access, constants, lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { OpenDesignHostDroppedDirectoryListing, OpenDesignHostDroppedDirectoryRefusal } from "@open-design/host";

export const DIRECTORY_INTAKE_IPC_CHANNEL = "intake:list-directory";
export const DIRECTORY_INTAKE_MAX_ENTRIES = 2000;

// The listing is typed against the host bridge contract it is sent over, so the
// main process and the renderer cannot drift apart on refusal reasons.
export type DirectoryEntryRefusal = OpenDesignHostDroppedDirectoryRefusal;
export type DroppedDirectoryListing = OpenDesignHostDroppedDirectoryListing;

export class DirectoryIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryIntakeError";
  }
}

const BUNDLE_EXTENSIONS = /\.(app|bundle|framework|plugin|kext|appex|xpc|pkg|mpkg)$/i;

/** Validates the main-process input: an absolute native path resolved from a dropped File. */
export function parseDroppedDirectoryPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\u0000") || !isAbsolute(raw)) {
    throw new DirectoryIntakeError("A dropped folder path is required");
  }
  return raw;
}

function isInside(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

const byPath = (a: { relativePath: string }, b: { relativePath: string }) =>
  a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;

export async function listDroppedDirectory(
  root: string,
  options: { maxEntries?: number } = {},
): Promise<DroppedDirectoryListing> {
  const maxEntries = options.maxEntries ?? DIRECTORY_INTAKE_MAX_ENTRIES;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
    if (!(await stat(rootReal)).isDirectory()) throw new DirectoryIntakeError("The dropped item is not a folder");
  } catch (error) {
    if (error instanceof DirectoryIntakeError) throw error;
    throw new DirectoryIntakeError(isPermissionError(error) ? "The dropped folder cannot be read" : "The dropped folder is unavailable");
  }
  const listing: DroppedDirectoryListing = { rootName: basename(root), files: [], refused: [], truncated: false };
  if (BUNDLE_EXTENSIONS.test(listing.rootName)) {
    listing.refused.push({ relativePath: "", reason: "bundle" });
    return listing;
  }
  const full = () => listing.files.length + listing.refused.length >= maxEntries;
  const refuse = (relativePath: string, reason: DirectoryEntryRefusal) => {
    listing.refused.push({ relativePath, reason });
  };

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      refuse(prefix, isPermissionError(error) ? "permission" : "unsupported");
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (full()) { listing.truncated = true; return; }
      const entryPath = join(absolute, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(entryPath);
        } catch {
          refuse(relativePath, "unsupported");
          continue;
        }
        if (!isInside(rootReal, target)) { refuse(relativePath, "symlink-outside-tree"); continue; }
        const targetStat = await stat(target).catch(() => null);
        if (targetStat?.isDirectory()) refuse(relativePath, "symlink-directory");
        else if (targetStat?.isFile()) await addFile(target, relativePath, targetStat.size);
        else refuse(relativePath, "unsupported");
      } else if (entry.isDirectory()) {
        if (BUNDLE_EXTENSIONS.test(entry.name)) refuse(relativePath, "bundle");
        else await walk(entryPath, relativePath);
      } else if (entry.isFile()) {
        const fileStat = await lstat(entryPath).catch(() => null);
        if (fileStat?.isFile()) await addFile(entryPath, relativePath, fileStat.size);
        else refuse(relativePath, "unsupported");
      } else {
        refuse(relativePath, "unsupported");
      }
    }
  };
  const addFile = async (path: string, relativePath: string, size: number): Promise<void> => {
    try {
      await access(path, constants.R_OK);
      listing.files.push({ relativePath, size });
    } catch {
      refuse(relativePath, "permission");
    }
  };

  await walk(rootReal, "");
  listing.files.sort(byPath);
  listing.refused.sort(byPath);
  return listing;
}

/** The slice of Electron's `ipcMain` this handler needs. */
export interface DirectoryIntakeIpc<TEvent> {
  handle(channel: string, listener: (event: TEvent, raw: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/**
 * Installs the `intake:list-directory` handler. Order is the invariant: the
 * sender check runs first, then path validation, and only then the
 * filesystem. Returns a disposer that removes the handler.
 */
export function registerDirectoryIntakeIpc<TEvent>(
  ipc: DirectoryIntakeIpc<TEvent>,
  requireMainWindowSender: (event: TEvent) => void,
  list: (root: string) => Promise<DroppedDirectoryListing> = listDroppedDirectory,
): () => void {
  ipc.removeHandler(DIRECTORY_INTAKE_IPC_CHANNEL);
  ipc.handle(DIRECTORY_INTAKE_IPC_CHANNEL, async (event, raw) => {
    requireMainWindowSender(event);
    return list(parseDroppedDirectoryPath(raw));
  });
  return () => ipc.removeHandler(DIRECTORY_INTAKE_IPC_CHANNEL);
}
