// The packaged app installs each INTERNAL_PACKAGES entry from its own `pnpm pack` tarball, so the
// tarball's file list is exactly what a packaged build can load. The daemon's 21st.dev routes read
// `packages/21st-catalog/generated/` at run time (the saved-reference metadata, the independently
// authored alternatives, the MIT preview images and the preview artwork), so every lane must
// install the package and its tarball must carry that directory as committed.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createPackageManagerInvocation } from "@mish/platform";
import { describe, expect, it } from "vitest";

import { INTERNAL_PACKAGES as LINUX_INTERNAL_PACKAGES } from "@/linux.js";
import { INTERNAL_PACKAGES as MAC_INTERNAL_PACKAGES } from "@/mac/constants.js";
import { shouldInstallInternalPackageForMacPrebundle } from "@/mac/prebundle.js";
import { INTERNAL_PACKAGES as WIN_INTERNAL_PACKAGES } from "@/win/constants.js";
import { shouldInstallInternalPackageForWinPrebundle } from "@/win/prebundle.js";
import { WORKSPACE_BUILD_PACKAGES } from "@/workspace-build.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageDir = join(workspaceRoot, "packages", "21st-catalog");
const NAME = "@mish/21st-catalog";

async function packedFiles(): Promise<Set<string>> {
  // Drop the npm_* variables of whichever runner started vitest (npx sets npm_execpath to npm), so
  // the invocation is the workspace's pinned pnpm, the same tool `collectWorkspaceTarballs` runs.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_")));
  const invocation = createPackageManagerInvocation(["-C", packageDir, "pack", "--dry-run", "--json"], env);
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    cwd: workspaceRoot,
    env,
    maxBuffer: 16 * 1024 * 1024,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const report = JSON.parse(stdout) as { files: Array<{ path: string }> };
  return new Set(report.files.map((file) => file.path));
}

async function committedFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await committedFiles(path));
    else files.push(relative(packageDir, path).split("\\").join("/"));
  }
  return files;
}

describe("packaged 21st.dev catalog", () => {
  it("is installed by every pack lane and built by the workspace build", () => {
    const standalone = { packageName: NAME, webOutputMode: "standalone" as const };
    expect(LINUX_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(MAC_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(WIN_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(shouldInstallInternalPackageForMacPrebundle(standalone)).toBe(true);
    expect(shouldInstallInternalPackageForWinPrebundle(standalone)).toBe(true);
    expect(WORKSPACE_BUILD_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
  });

  it("is added beside @mish/cult-ui-catalog, which every lane still installs (P1-4a-AC3)", () => {
    const CULT = "@mish/cult-ui-catalog";
    for (const [lane, names] of [
      ["linux", LINUX_INTERNAL_PACKAGES.map((pkg) => pkg.name)],
      ["mac", MAC_INTERNAL_PACKAGES.map((pkg) => pkg.name)],
      ["win", WIN_INTERNAL_PACKAGES.map((pkg) => pkg.name)],
      ["workspace-build", WORKSPACE_BUILD_PACKAGES.map((pkg) => pkg.name)],
    ] as const) {
      expect(names, lane).toContain(NAME);
      expect(names, lane).toContain(CULT);
    }
  });

  it("ships every generated file the daemon reads in the package tarball", async () => {
    const files = await packedFiles();
    for (const file of ["generated/21st-items.json", "generated/21st-originals.json", "generated/21st-thumbnails.json",
      "generated/21st-live-thumbnails.json", "generated/preview-artwork/manifest.json"]) {
      expect(files.has(file), file).toBe(true);
    }
    // Nothing under generated/ is left behind: the tarball carries the directory as committed.
    for (const file of await committedFiles(join(packageDir, "generated"))) {
      expect(files.has(file), file).toBe(true);
    }
  }, 60_000);
});
