import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import {
  MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER,
  MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES,
  MAC_PREBUNDLE_ESBUILD_TARGET,
  MAC_PREBUNDLE_POLICIES,
  MAC_PREBUNDLE_RUNTIME_DEPENDENCIES,
  MAC_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  MAC_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  MAC_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
  assertMacPrebundleMetafile,
  findForbiddenMacPrebundleInputs,
  renderMacPackagedMainEntry,
  resolveMacDaemonPrebundleAliases,
  shouldInstallInternalPackageForMacPrebundle,
  shouldUseMacStandalonePrebundle,
} from "@/mac/prebundle.js";

describe("mac standalone prebundle policy", () => {
  it("runs JSONC parse and modify after the daemon bundle is relocated", async () => {
    const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const root = await mkdtemp(join(tmpdir(), "mish-mac-jsonc-prebundle-"));
    const outputRoot = join(root, "build");
    const installedRoot = join(root, "installed");
    try {
      await mkdir(outputRoot);
      await build({
        alias: resolveMacDaemonPrebundleAliases(workspaceRoot),
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        platform: "node",
        outfile: join(outputRoot, "daemon-jsonc.mjs"),
        stdin: {
          contents: [
            'import { parse, modify, applyEdits } from "jsonc-parser";',
            'const source = \'{ // owned fixture\\n "compilerOptions": { "strict": false, }, }\';',
            'const errors = [];',
            'const before = parse(source, errors, { allowTrailingComma: true });',
            'const after = parse(applyEdits(source, modify(source, ["compilerOptions", "strict"], true, {})));',
            'console.log(JSON.stringify({ before, after, errors }));',
          ].join("\n"),
          loader: "js",
          resolveDir: join(workspaceRoot, "apps", "daemon"),
        },
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
      });
      await rename(outputRoot, installedRoot);
      const result = await promisify(execFile)(process.execPath, [join(installedRoot, "daemon-jsonc.mjs")], {
        cwd: installedRoot,
        env: {},
        timeout: 10_000,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        before: { compilerOptions: { strict: false } },
        after: { compilerOptions: { strict: true } },
        errors: [],
      });
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("is enabled only for standalone web output", () => {
    expect(shouldUseMacStandalonePrebundle("standalone")).toBe(true);
    expect(shouldUseMacStandalonePrebundle("server")).toBe(false);
  });

  it("keeps server-mode package topology unchanged", () => {
    expect(
      shouldInstallInternalPackageForMacPrebundle({
        packageName: "@mish/web",
        webOutputMode: "server",
      }),
    ).toBe(true);
    expect(
      shouldInstallInternalPackageForMacPrebundle({
        packageName: "@mish/packaged",
        webOutputMode: "server",
      }),
    ).toBe(true);
  });

  it("excludes internal packages replaced by mac standalone prebundles", () => {
    for (const packageName of [
      "@mish/daemon",
      "@mish/desktop",
      "@mish/packaged",
      "@mish/sidecar-proto",
      "@mish/web",
    ]) {
      expect(
        shouldInstallInternalPackageForMacPrebundle({
          packageName,
          webOutputMode: "standalone",
        }),
      ).toBe(false);
    }
    for (const packageName of [
      "@mish/contracts",
      "@mish/platform",
      "@mish/sidecar",
    ]) {
      expect(
        shouldInstallInternalPackageForMacPrebundle({ packageName, webOutputMode: "standalone" }),
      ).toBe(true);
    }
  });

  it("documents the explicit code-level bundle boundaries", () => {
    expect(MAC_PREBUNDLE_ESBUILD_TARGET).toBe("node24");
    expect(MAC_PREBUNDLE_POLICIES.packagedMain.externals).toEqual(["@mish/sidecar", "electron"]);
    expect(MAC_PREBUNDLE_POLICIES.daemonCli.externals).toEqual([
      "@ffmpeg-installer/ffmpeg",
      "@mish/sidecar",
      "better-sqlite3",
      "blake3-wasm",
      "fsevents",
      "gsap",
      "hyperframes",
      "node-pty",
    ]);
    expect(MAC_PREBUNDLE_POLICIES.daemonSidecar.externals).toEqual([
      "@ffmpeg-installer/ffmpeg",
      "@mish/sidecar",
      "better-sqlite3",
      "blake3-wasm",
      "fsevents",
      "gsap",
      "hyperframes",
      "node-pty",
    ]);
    expect(MAC_PREBUNDLE_POLICIES.webSidecar.externals).toEqual(["@mish/sidecar"]);
    expect(MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER).toContain("createRequire");
    // Must match apps/daemon/package.json / the pnpm lockfile, or
    // electron-builder's collector drops the module from the shipped app and
    // the daemon dies at boot with ERR_MODULE_NOT_FOUND (issue #4638).
    expect(MAC_PREBUNDLE_RUNTIME_DEPENDENCIES).toEqual({
      "@higgsfield/cli": "1.1.26",
      "@ffmpeg-installer/ffmpeg": "1.1.0",
      "better-sqlite3": "12.10.0",
      "blake3-wasm": "2.1.5",
      "gsap": "3.15.0",
      "hyperframes": "0.8.1",
      "node-pty": "1.1.0",
      "sharp": "0.35.3",
    });
    expect(MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES).toEqual({ "fsevents": "2.3.3" });
    expect(MAC_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH).toBe("app/prebundled/daemon/daemon-cli.mjs");
    expect(MAC_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH).toBe("app/prebundled/daemon/daemon-sidecar.mjs");
    expect(MAC_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH).toBe("app/prebundled/web-sidecar.mjs");
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps chokidar's native fsevents binding outside daemon bundles",
    async () => {
      const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const result = await build({
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: {
          contents: 'import "chokidar";',
          loader: "js",
          resolveDir: join(workspaceRoot, "apps", "daemon"),
        },
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
        write: false,
      });

      expect(Object.keys(result.metafile.inputs).some((input) => input.includes("/node_modules/fsevents/"))).toBe(
        false,
      );
    },
  );

  it(
    "keeps node-pty's native runtime outside daemon bundles",
    async () => {
      const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const result = await build({
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        entryPoints: [join(workspaceRoot, "apps", "daemon", "src", "terminals.ts")],
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
        write: false,
      });

      expect(
        Object.keys(result.metafile.inputs).some((input) => input.includes("/node_modules/node-pty/")),
      ).toBe(false);
    },
  );
});

describe("findForbiddenMacPrebundleInputs", () => {
  it("matches forbidden dependency roots after path normalization", () => {
    expect(
      findForbiddenMacPrebundleInputs({
        forbiddenInputs: MAC_PREBUNDLE_POLICIES.webSidecar.forbiddenInputs,
        inputs: [
          "src/index.ts",
          "C:\\repo\\node_modules\\next\\dist\\server.js",
          "/repo/node_modules/openai/index.mjs",
        ],
      }),
    ).toEqual([
      "C:/repo/node_modules/next/dist/server.js",
      "/repo/node_modules/openai/index.mjs",
    ]);
  });
});

describe("assertMacPrebundleMetafile", () => {
  it("accepts a safe web sidecar metafile", async () => {
    const root = await mkdtemp(join(tmpdir(), "mish-mac-prebundle-"));
    const metafilePath = join(root, "safe.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/apps/web/sidecar/index.ts": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "webSidecar" }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a packaged main metafile that pulled in web runtime closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "mish-mac-prebundle-"));
    const metafilePath = join(root, "unsafe.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/node_modules/@mish/web/dist/sidecar/index.js": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "packagedMain" }),
      ).rejects.toThrow(/packaged main prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a daemon metafile that bundled wasm-backed runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mish-mac-prebundle-"));
    const metafilePath = join(root, "unsafe-daemon.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/node_modules/blake3-wasm/dist/node/index.js": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "daemonSidecar" }),
      ).rejects.toThrow(/daemon sidecar prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a daemon metafile that bundled native runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mish-mac-prebundle-"));
    const metafilePath = join(root, "unsafe-native-daemon.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({
          inputs: {
            "/repo/node_modules/fsevents/fsevents.js": {},
            "/repo/node_modules/node-pty/lib/index.js": {},
          },
        }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "daemonSidecar" }),
      ).rejects.toThrow(/daemon sidecar prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("renderMacPackagedMainEntry", () => {
  it("renders the prebundled runtime entry shim", () => {
    expect(renderMacPackagedMainEntry(true)).toContain("./prebundled/packaged-main.mjs");
    expect(renderMacPackagedMainEntry(true)).not.toContain("@mish/packaged");
  });

  it("renders the package entry shim for non-prebundled mode", () => {
    expect(renderMacPackagedMainEntry(false)).toContain("@mish/packaged");
    expect(renderMacPackagedMainEntry(false)).not.toContain("./prebundled/packaged-main.mjs");
  });
});
