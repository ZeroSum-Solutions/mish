import type { ExternalFilesDrop } from './drop-coordinator';
import { expandDroppedDirectory, type DirectoryIntakeHost } from './native-directory-drop';

export interface NativeDropMessages {
  /** No native listing exists (web build, old host, File without a native path). */
  unsupported: string;
  refused(folder: string, items: string): string;
  truncated(folder: string): string;
  failed(folder: string, reason: string): string;
}

export interface CollectedDrop { files: File[]; reports: string[] }

/**
 * Turns one drop gesture into the files intake should accept, plus what the
 * user must be told (AC-R01.1). Invariant: a folder that cannot be listed or
 * read costs only itself. Loose files and folders that did expand in the same
 * gesture are still returned, and the failed folder is reported by name.
 */
export async function collectNativeDrop(drop: ExternalFilesDrop, host: DirectoryIntakeHost | null, messages: NativeDropMessages): Promise<CollectedDrop> {
  const files = [...drop.files]; const reports: string[] = [];
  for (const directory of drop.directories) {
    let expanded;
    try {
      expanded = await expandDroppedDirectory(directory, host);
    } catch (error) {
      reports.push(messages.failed(directory.entry.name, error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (!expanded) { if (!reports.includes(messages.unsupported)) reports.unshift(messages.unsupported); continue; }
    files.push(...expanded.files);
    if (expanded.refused.length) reports.push(messages.refused(expanded.rootName, expanded.refused.map(item => item.relativePath || expanded.rootName).join(', ')));
    if (expanded.truncated) reports.push(messages.truncated(expanded.rootName));
  }
  return { files, reports };
}
