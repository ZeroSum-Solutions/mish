import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { resolveMacInstallIdentity } from "@/mac/identity.js";
import { resolveMacPaths } from "@/mac/paths.js";

function makeConfig(root: string, namespace: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "mac",
    portable: true,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", namespace),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dmg",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("resolveMacInstallIdentity", () => {
  it("keeps stable builds on the canonical mac identity", () => {
    expect(resolveMacInstallIdentity(makeConfig("/work", "release-stable"))).toMatchObject({
      appId: "io.mish.desktop",
      installerTitle: "Mishh Mashh",
      productName: "Mishh Mashh",
      publicAppBundleName: "Mishh Mashh.app",
      systemAppBundleName: "Mishh Mashh.app",
    });
  });

  it("uses first-class beta app identity for beta release namespaces", () => {
    const config = makeConfig("/work", "release-beta");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "io.mish.desktop.beta",
      executableName: "Mishmash Beta",
      installerTitle: "Mishmash Beta",
      productName: "Mishmash Beta",
      publicAppBundleName: "Mishmash Beta.app",
      systemAppBundleName: "Mishmash Beta.app",
      // Pinned: Electron derives Application Support from this, not the visible name.
      userDataProductName: "Mishh Mashh Beta",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/Mishmash Beta\.app$/);
  });

  it("uses first-class preview app identity for preview release namespaces", () => {
    const config = makeConfig("/work", "release-preview");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "io.mish.desktop.preview",
      executableName: "Mishh Mashh Preview",
      installerTitle: "Mishh Mashh Preview",
      productName: "Mishh Mashh Preview",
      publicAppBundleName: "Mishh Mashh Preview.app",
      systemAppBundleName: "Mishh Mashh Preview.app",
      userDataProductName: "Mishh Mashh Preview",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/Mishh Mashh Preview\.app$/);
  });

  it("uses first-class prerelease app identity for prerelease release versions and namespaces", () => {
    const prereleaseVersionConfig = {
      ...makeConfig("/work", "release-stable"),
      appVersion: "0.8.0-prerelease.2",
    };
    const prereleaseNamespaceConfig = makeConfig("/work", "release-prerelease");

    expect(resolveMacInstallIdentity(prereleaseVersionConfig)).toEqual({
      appId: "io.mish.desktop.prerelease",
      executableName: "Mishh Mashh Prerelease",
      installerTitle: "Mishh Mashh Prerelease",
      productName: "Mishh Mashh Prerelease",
      publicAppBundleName: "Mishh Mashh Prerelease.app",
      systemAppBundleName: "Mishh Mashh Prerelease.app",
      userDataProductName: "Mishh Mashh Prerelease",
    });
    expect(resolveMacPaths(prereleaseVersionConfig).appPath).toMatch(/Mishh Mashh Prerelease\.app$/);
    expect(resolveMacInstallIdentity(prereleaseNamespaceConfig)).toMatchObject({
      productName: "Mishh Mashh Prerelease",
      publicAppBundleName: "Mishh Mashh Prerelease.app",
    });
  });
});
