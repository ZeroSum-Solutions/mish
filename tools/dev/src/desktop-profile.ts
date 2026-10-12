import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

/** An opt-in Electron profile, independent of daemon data and sidecar identity. */
export function resolveDesktopUserDataDir(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new Error("--desktop-user-data-dir must be an absolute directory path");
  }
  const directory = path.resolve(value);
  if (directory === path.parse(directory).root) {
    throw new Error("--desktop-user-data-dir must not be the filesystem root");
  }
  try {
    if (!lstatSync(directory).isDirectory()) {
      throw new Error("--desktop-user-data-dir must name a directory, not a file or symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return directory;
}

export function desktopLaunchArgs(mainEntryPath: string, userDataDir: string | null): string[] {
  const directory = resolveDesktopUserDataDir(userDataDir);
  if (directory == null) return [mainEntryPath];
  mkdirSync(directory, { recursive: true });
  // Recheck after creation; a replaced final directory must not become a profile alias.
  resolveDesktopUserDataDir(directory);
  return [mainEntryPath, `--user-data-dir=${directory}`];
}
