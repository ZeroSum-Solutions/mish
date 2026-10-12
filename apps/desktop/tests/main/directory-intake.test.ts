// AC-R01.1: "Directory intake reports each discovered file and does not follow
// symlinks outside the selected tree." Real filesystem fixtures under the OS
// temp directory; the physical Finder drop stays a separate native gate.
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DirectoryIntakeError,
  listDroppedDirectory,
  parseDroppedDirectoryPath,
} from "../../src/main/directory-intake.js";

let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "od-directory-intake-"));
  root = join(sandbox, "Brand Kit");
  outside = join(sandbox, "outside");
  await mkdir(join(root, "nested", "deeper"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "do not read");
  await mkdir(join(outside, "dir"), { recursive: true });
  await writeFile(join(outside, "dir", "also-secret.txt"), "do not read");
});

afterEach(async () => {
  await chmod(join(root, "locked"), 0o755).catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
});

async function seedFiles(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const folder = index % 3 === 0 ? root : index % 3 === 1 ? join(root, "nested") : join(root, "nested", "deeper");
    await writeFile(join(folder, `file-${String(index).padStart(2, "0")}.txt`), `bytes ${index}`);
  }
}

describe("listDroppedDirectory", () => {
  it("reports every discovered file with a tree-relative path and size, beyond the 20 visible per batch", async () => {
    await seedFiles(25);
    await writeFile(join(root, "naïve café.png"), "png");

    const listing = await listDroppedDirectory(root);

    expect(listing.rootName).toBe("Brand Kit");
    expect(listing.truncated).toBe(false);
    expect(listing.refused).toEqual([]);
    expect(listing.files).toHaveLength(26);
    expect(listing.files).toContainEqual({ relativePath: "naïve café.png", size: 3 });
    expect(listing.files).toContainEqual({ relativePath: "nested/deeper/file-02.txt", size: 7 });
    // Deterministic order so a continuation batch is the same on every attempt.
    const again = await listDroppedDirectory(root);
    expect(again.files.map((file) => file.relativePath)).toEqual(listing.files.map((file) => file.relativePath));
    // Native absolute paths never leave the main process.
    expect(JSON.stringify(listing)).not.toContain(sandbox);
  });

  it("refuses symlinks that leave the selected tree and never lists their targets", async () => {
    await writeFile(join(root, "kept.txt"), "kept");
    await symlink(join(outside, "secret.txt"), join(root, "escape-file.txt"));
    await symlink(outside, join(root, "nested", "escape-dir"));
    await symlink(join(sandbox, "missing"), join(root, "dangling"));

    const listing = await listDroppedDirectory(root);

    expect(listing.files.map((file) => file.relativePath)).toEqual(["kept.txt"]);
    expect(listing.refused).toEqual([
      { relativePath: "dangling", reason: "unsupported" },
      { relativePath: "escape-file.txt", reason: "symlink-outside-tree" },
      { relativePath: "nested/escape-dir", reason: "symlink-outside-tree" },
    ]);
    expect(JSON.stringify(listing)).not.toContain("secret");
  });

  it("lists an in-tree file symlink but does not traverse a symlinked directory", async () => {
    await writeFile(join(root, "nested", "logo.svg"), "<svg/>");
    await symlink(join(root, "nested", "logo.svg"), join(root, "logo-link.svg"));
    await symlink(join(root, "nested"), join(root, "nested-link"));

    const listing = await listDroppedDirectory(root);

    expect(listing.files).toEqual([
      { relativePath: "logo-link.svg", size: 6 },
      { relativePath: "nested/logo.svg", size: 6 },
    ]);
    expect(listing.refused).toEqual([{ relativePath: "nested-link", reason: "symlink-directory" }]);
  });

  it("reports bundles and unreadable folders instead of silently skipping them", async () => {
    await mkdir(join(root, "Tool.app", "Contents"), { recursive: true });
    await writeFile(join(root, "Tool.app", "Contents", "Info.plist"), "plist");
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", "hidden.txt"), "hidden");
    await chmod(join(root, "locked"), 0o000);
    await writeFile(join(root, "ok.txt"), "ok");

    // A privileged process (root, CAP_DAC_OVERRIDE) can still traverse a 000
    // directory, so the expected outcome follows the OS's actual access
    // decision rather than the mode bits.
    const lockedRefused = await access(join(root, "locked"), constants.R_OK | constants.X_OK).then(
      () => false,
      () => true,
    );

    const listing = await listDroppedDirectory(root);

    expect(listing.files.map((file) => file.relativePath)).toEqual(
      lockedRefused ? ["ok.txt"] : ["locked/hidden.txt", "ok.txt"],
    );
    const reasons = Object.fromEntries(listing.refused.map((entry) => [entry.relativePath, entry.reason]));
    expect(reasons["Tool.app"]).toBe("bundle");
    expect(reasons.locked).toBe(lockedRefused ? "permission" : undefined);
  });

  it("says so explicitly when discovery stops at its bound", async () => {
    await seedFiles(12);
    const listing = await listDroppedDirectory(root, { maxEntries: 5 });
    expect(listing.files).toHaveLength(5);
    expect(listing.truncated).toBe(true);
  });

  it("refuses a dropped bundle or a non-directory as the root", async () => {
    await mkdir(join(sandbox, "Plugin.bundle"));
    await writeFile(join(sandbox, "Plugin.bundle", "x"), "x");
    const bundle = await listDroppedDirectory(join(sandbox, "Plugin.bundle"));
    expect(bundle.files).toEqual([]);
    expect(bundle.refused).toEqual([{ relativePath: "", reason: "bundle" }]);

    await expect(listDroppedDirectory(join(outside, "secret.txt"))).rejects.toBeInstanceOf(DirectoryIntakeError);
  });
});

describe("parseDroppedDirectoryPath", () => {
  it("accepts only an absolute path string resolved from a dropped file", () => {
    expect(parseDroppedDirectoryPath("/Users/me/Brand Kit")).toBe("/Users/me/Brand Kit");
    for (const raw of [undefined, null, 1, "", "relative/dir", "/tmp/a\u0000b", { path: "/tmp" }]) {
      expect(() => parseDroppedDirectoryPath(raw)).toThrow(DirectoryIntakeError);
    }
  });
});
