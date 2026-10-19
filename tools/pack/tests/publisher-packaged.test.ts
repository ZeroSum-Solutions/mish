// The agency fast lane imports `@mish/publisher` (its render and Node loader entries) at runtime.
// The packaged app installs each INTERNAL_PACKAGES entry from its own `pnpm pack` tarball, so every
// lane must install the publisher, the workspace build must build it before the fast lane, and its
// tarball must carry the entries the fast lane loads and the notices of what it redistributes.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTERNAL_PACKAGES as LINUX_INTERNAL_PACKAGES } from "@/linux.js";
import { INTERNAL_PACKAGES as MAC_INTERNAL_PACKAGES } from "@/mac/constants.js";
import { shouldInstallInternalPackageForMacPrebundle } from "@/mac/prebundle.js";
import { INTERNAL_PACKAGES as WIN_INTERNAL_PACKAGES } from "@/win/constants.js";
import { shouldInstallInternalPackageForWinPrebundle } from "@/win/prebundle.js";
import { WORKSPACE_BUILD_PACKAGES } from "@/workspace-build.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageDir = join(workspaceRoot, "packages", "publisher");
const NAME = "@mish/publisher";
const FAST_LANE = "@mish/agency-fast-lane";

describe("packaged publisher", () => {
  it("is installed by every pack lane and built before the fast lane", () => {
    const standalone = { packageName: NAME, webOutputMode: "standalone" as const };
    for (const packages of [LINUX_INTERNAL_PACKAGES, MAC_INTERNAL_PACKAGES, WIN_INTERNAL_PACKAGES, WORKSPACE_BUILD_PACKAGES]) {
      const names = packages.map((pkg) => pkg.name as string);
      expect(names).toContain(NAME);
      expect(names.indexOf(NAME)).toBeLessThan(names.indexOf(FAST_LANE));
    }
    expect(shouldInstallInternalPackageForMacPrebundle(standalone)).toBe(true);
    expect(shouldInstallInternalPackageForWinPrebundle(standalone)).toBe(true);
  });

  it("points every export into the published dist directory", async () => {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, { default: string; types: string }>;
      files: string[];
    };
    expect(manifest.files).toContain("dist");
    for (const [entry, target] of Object.entries(manifest.exports)) {
      expect(target.default.startsWith("./dist/"), entry).toBe(true);
      expect(target.types.startsWith("./dist/"), entry).toBe(true);
    }
  });

  // The tarball ships all of `dist/` (`files`, checked above). The publisher's own consumer test
  // packs it, installs it into another project and reads LICENSE and NOTICE from the install.
  it.skipIf(!existsSync(join(packageDir, "dist", "index.js")))("builds the runtime entries and the notices into dist", () => {
    for (const file of ["dist/index.js", "dist/index.d.ts", "dist/node.js", "dist/node.d.ts", "dist/LICENSE", "dist/NOTICE"]) {
      expect(existsSync(join(packageDir, file)), file).toBe(true);
    }
  });
});
