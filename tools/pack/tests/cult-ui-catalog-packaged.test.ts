// The packaged app installs each INTERNAL_PACKAGES entry from its own `pnpm pack` tarball, so the
// tarball's file list is exactly what a packaged build can load. The Cult adapter registry
// (`packages/cult-ui-catalog/generated/`: the typed index, the contract shim, one adapter per
// insertable catalog row and one WebP preview each) must be in that list, and every lane must
// install the package, or the agency fast lane cannot resolve a `cult:<name>` selection.
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
const packageDir = join(workspaceRoot, "packages", "cult-ui-catalog");
const NAME = "@mish/cult-ui-catalog";

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

async function insertableRows(): Promise<Array<{ id: string; name: string; previewId: string | null }>> {
  const catalog = JSON.parse(await readFile(join(packageDir, "catalog.json"), "utf8")) as {
    rows: Array<{ id: string; name: string; previewId: string | null; conversion: { status: string } }>;
  };
  return catalog.rows.filter((row) => row.conversion.status === "insertable");
}

describe("packaged Cult adapter registry", () => {
  it("is installed by every pack lane and built by the workspace build", () => {
    const standalone = { packageName: NAME, webOutputMode: "standalone" as const };
    expect(LINUX_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(MAC_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(WIN_INTERNAL_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
    expect(shouldInstallInternalPackageForMacPrebundle(standalone)).toBe(true);
    expect(shouldInstallInternalPackageForWinPrebundle(standalone)).toBe(true);
    expect(WORKSPACE_BUILD_PACKAGES.map((pkg) => pkg.name)).toContain(NAME);
  });

  it("ships the index, the shim, every insertable row's adapter and every preview in the package tarball", async () => {
    const [files, rows] = await Promise.all([packedFiles(), insertableRows()]);
    // The public repository ships no licensed rows; the index and shim must still ship.
    expect(files.has("catalog.json")).toBe(true);
    expect(files.has("generated/index.ts")).toBe(true);
    expect(files.has("generated/section-adapter.ts")).toBe(true);
    for (const row of rows) {
      expect(files.has(`generated/adapters/${row.name}.ts`), `${row.id} adapter`).toBe(true);
      if (row.previewId !== null) expect(files.has(`generated/previews/${row.previewId}`), `${row.id} preview`).toBe(true);
    }
    // Nothing under generated/ is left behind: the tarball carries the directory as committed.
    for (const sub of ["adapters", "previews"]) {
      const dir = join(packageDir, "generated", sub);
      if (!existsSync(dir)) continue;
      for (const file of await readdir(dir)) {
        expect(files.has(`generated/${sub}/${file}`), `generated/${sub}/${file}`).toBe(true);
      }
    }
  }, 60_000);
});
