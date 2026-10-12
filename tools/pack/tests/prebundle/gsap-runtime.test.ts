import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { MAC_PREBUNDLE_POLICIES, MAC_PREBUNDLE_RUNTIME_DEPENDENCIES } from "@/mac/prebundle.js";
import { createWinPackagedAppCacheKey } from "@/win/app.js";
import { WIN_PREBUNDLE_POLICIES, WIN_PREBUNDLE_RUNTIME_DEPENDENCIES } from "@/win/prebundle.js";
import type { PackedTarballInfo } from "@/win/types.js";

// AC-R08.5: the daemon reads the pinned gsap runtime files from its own
// node_modules at run time (recipe previews and HTML exports ship those bytes;
// there is no CDN fallback). A packaged daemon therefore needs gsap as a
// declared runtime dependency of the assembled app, at the daemon's exact pin,
// or electron-builder's collector drops it and the GSAP source reports
// unavailable. It stays an esbuild external so the bundle never inlines it.
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

async function daemonGsapPin(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, "apps", "daemon", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const pin = manifest.dependencies?.gsap;
  if (!pin) throw new Error("apps/daemon/package.json does not declare gsap");
  return pin;
}

describe("packaged daemon ships the pinned gsap runtime (AC-R08.5)", () => {
  it("mac and win declare gsap as a runtime dependency at the daemon's exact pin", async () => {
    const pin = await daemonGsapPin();
    expect(pin).toBe("3.15.0");
    expect(MAC_PREBUNDLE_RUNTIME_DEPENDENCIES).toMatchObject({ gsap: pin });
    expect(WIN_PREBUNDLE_RUNTIME_DEPENDENCIES).toMatchObject({ gsap: pin });
  });

  it("keeps gsap external to both daemon bundles and forbids it as a bundle input", () => {
    for (const policies of [MAC_PREBUNDLE_POLICIES, WIN_PREBUNDLE_POLICIES]) {
      for (const policy of [policies.daemonCli, policies.daemonSidecar]) {
        expect(policy.externals).toContain("gsap");
        expect(policy.forbiddenInputs).toContain("/node_modules/gsap/");
      }
    }
  });

  it("win.packaged-app key witnesses gsap through the runtime dependency constant", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-gsap-key-"));
    try {
      const config = { webOutputMode: "standalone", electronVersion: "41.3.0" } as ToolPackConfig;
      const packed = [{ fileName: "contracts.tgz", packageName: "@open-design/contracts" }] satisfies PackedTarballInfo[];
      const withGsap = await createWinPackagedAppCacheKey(config, "tarballs-a", packed);
      const { gsap: _gsap, ...withoutGsap } = WIN_PREBUNDLE_RUNTIME_DEPENDENCIES as Record<string, string>;
      await expect(createWinPackagedAppCacheKey(config, "tarballs-a", packed, withoutGsap)).resolves.not.toBe(withGsap);
      await expect(createWinPackagedAppCacheKey(config, "tarballs-a", packed, { ...withoutGsap, gsap: "3.14.2" })).resolves.not.toBe(withGsap);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
