// The packaged daemon reads the Website Shape Atlas, the family registry and the design taxonomy
// through `@mish/agency-fast-lane/data` rather than the package's own file loaders.
//
// The reason is this file. The mac and Windows daemon prebundles inline every workspace package
// except `@mish/sidecar`, and the fast lane's loaders build their default paths from
// `import.meta.dirname`. Inlined, that directory is the prebundle's, not the package's, so the
// `atlas/` and `taxonomy/` JSON directories are simply not there and the loaders throw at daemon
// startup — in a packaged build only, while dev and the Linux lane stay green.
//
// Both halves are asserted here: the data module survives the real bundler, and the loaders do
// not. The second half is what keeps the first from quietly becoming unnecessary-looking.

import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { MAC_PREBUNDLE_ESBUILD_TARGET, MAC_PREBUNDLE_POLICIES } from "@/mac/prebundle.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
  temporaryRoot = "";
});

/** Where the packaged daemon finds the bundled plugins, and where the workspace daemon does. */
const BUNDLED_PLUGINS_ROOT = join(workspaceRoot, "plugins", "_official");

/**
 * Bundles `source` exactly as the daemon prebundle would, into a directory that has no fast-lane
 * package anywhere beneath it, then runs it. Returns stdout, or the failure the bundle produced.
 */
async function bundleAndRun(source: string): Promise<{ ok: boolean; output: string }> {
  temporaryRoot = await mkdtemp(join(tmpdir(), "mish-fast-lane-data-"));
  const outfile = join(temporaryRoot, "bundle.mjs");
  // `resolveDir` is apps/daemon, so `@mish/agency-fast-lane` resolves through the same
  // workspace link the real daemon prebundle uses. Only the OUTPUT lands elsewhere, which is the
  // whole point: a bundle does not carry its inputs' directories with it.
  await build({
    bundle: true,
    external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
    format: "esm",
    outfile,
    platform: "node",
    stdin: {
      contents: source,
      loader: "js",
      resolveDir: join(workspaceRoot, "apps", "daemon"),
      sourcefile: "fast-lane-data-entry.mjs",
    },
    target: MAC_PREBUNDLE_ESBUILD_TARGET,
  });

  try {
    const { stdout } = await execFileAsync(process.execPath, [outfile], { cwd: temporaryRoot });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("fast-lane design data inside a daemon prebundle", () => {
  it("resolves through the data module when the package's JSON is nowhere near the bundle", async () => {
    const result = await bundleAndRun(`
      import { designTaxonomy, familyRegistry, shapeAtlas } from "@mish/agency-fast-lane/data";
      process.stdout.write(JSON.stringify({
        version: designTaxonomy.version,
        spines: shapeAtlas.spines.length,
        families: familyRegistry.families.length,
        sections: designTaxonomy.sections.length,
      }));
    `);

    expect(result.ok, result.output).toBe(true);
    const parsed = JSON.parse(result.output) as {
      families: number;
      sections: number;
      spines: number;
      version: string;
    };
    expect(parsed.version).toBe("1.0");
    expect(parsed.spines).toBeGreaterThan(0);
    expect(parsed.families).toBeGreaterThan(0);
    expect(parsed.sections).toBeGreaterThan(0);
  }, 60_000);

  it("routes a brief through the build module, which loads no file of its own", async () => {
    // `buildSite`'s ROUTE step is the fast lane's other reader of this data, and it runs inside the
    // packaged daemon. `routeBuild` therefore takes the atlas and the registry rather than loading
    // them: given the data module's objects, the whole path has to survive the bundle that the
    // loaders below do not. The router is faked, so this asserts the bundling, not the network.
    const result = await bundleAndRun(`
      import { routeBuild } from "@mish/agency-fast-lane/build";
      import { familyRegistry, shapeAtlas } from "@mish/agency-fast-lane/data";
      const decision = await routeBuild(
        { brief: "A family dental practice in Boise.", atlas: shapeAtlas, registry: familyRegistry, jevKey: async () => "fake-key" },
        { createJevRouter: () => ({ route: async (input) => ({ decision: "unrouted", reason: "faked", spine: { code: "none", name: "none", confidence: 0, probabilities: {} }, spines: [], candidates: [], warnings: [], ms: 1, calls: 1, model: "fake", atlasSpines: input.atlas.spines.length, registryFamilies: input.registry.families.length }) }) },
      );
      process.stdout.write(JSON.stringify({ decision: decision.decision, spines: decision.atlasSpines, families: decision.registryFamilies }));
    `);

    expect(result.ok, result.output).toBe(true);
    const parsed = JSON.parse(result.output) as { decision: string; families: number; spines: number };
    expect(parsed.decision).toBe("unrouted");
    expect(parsed.spines).toBeGreaterThan(0);
    expect(parsed.families).toBeGreaterThan(0);
  }, 60_000);

  it("loads a family package from a COPIED resource root, the way a packaged daemon does", async () => {
    // The family packages are NOT inlined and cannot be: `loadFamilyPackage` imports each
    // family's compiler through `pathToFileURL`, which esbuild cannot follow, and it reads the
    // recipe, the schema and the approved asset bytes from disk. They are runtime files, shipped
    // by `tools/pack`'s `BUNDLED_RESOURCE_TREES` into `<resourceRoot>/plugins/_official` and found
    // again through the daemon's `BUNDLED_PLUGINS_DIR`.
    //
    // So the workspace tree is not what is loaded here. `plugins/_official/examples/agency-
    // wrenfield` is COPIED into a fresh root first — the copy `copyBundledResourceTrees` makes —
    // and the bundle loads it from there, joining the path exactly as the daemon's
    // `familyPackageDir` does. Reading the live workspace path instead would prove only that the
    // repo is on this disk, which a packaged machine's is not.
    const resourceRoot = await mkdtemp(join(tmpdir(), "mish-family-resources-"));
    try {
      await cp(
        join(BUNDLED_PLUGINS_ROOT, "examples", "agency-wrenfield"),
        join(resourceRoot, "plugins", "_official", "examples", "agency-wrenfield"),
        { recursive: true },
      );
      const bundledPluginsDir = join(resourceRoot, "plugins", "_official");
      const result = await bundleAndRun(`
        import { join } from "node:path";
        import { loadFamilyPackage } from "@mish/agency-fast-lane/family";
        // familyPackageDir(bundledPluginsRoot, family), inlined: the daemon's own composition is
        // asserted against this same layout in apps/daemon/tests/agency-build-routes.test.ts.
        const dir = join(${JSON.stringify(bundledPluginsDir)}, "examples", "agency-wrenfield");
        const pkg = await loadFamilyPackage(dir, "wrenfield");
        process.stdout.write(JSON.stringify({ family: pkg.family, render: typeof pkg.render, fromWorkspace: dir.startsWith(${JSON.stringify(BUNDLED_PLUGINS_ROOT)}) }));
      `);

      expect(result.ok, result.output).toBe(true);
      expect(JSON.parse(result.output)).toEqual({ family: "wrenfield", render: "function", fromWorkspace: false });
    } finally {
      await rm(resourceRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it("would fail through defaultPackageDir, which is why the daemon does not use it", async () => {
    // `defaultPackageDir` builds its path from `import.meta.dirname`, so inside the prebundle it
    // points at the bundle's own directory — the same failure the loaders below have. A daemon
    // wired to it answers 202 and then fails the build at `prepare` time, in packaged builds only.
    const result = await bundleAndRun(`
      import { defaultPackageDir, loadFamilyPackage } from "@mish/agency-fast-lane/family";
      await loadFamilyPackage(defaultPackageDir("wrenfield"), "wrenfield");
      process.stdout.write("loaded");
    `);

    expect(result.ok).toBe(false);
    // It looked for the package three directories above the BUNDLE, not above the package: the
    // path it names is somewhere under the temp root, and never the workspace tree that holds the
    // real family. Which file it misses first (the compiler here) is incidental.
    expect(result.output).toContain("agency-wrenfield");
    expect(result.output).not.toContain(BUNDLED_PLUGINS_ROOT);
  }, 60_000);

  it("would fail through the file loaders, which is why the daemon does not use them", async () => {
    const result = await bundleAndRun(`
      import { loadDesignTaxonomy } from "@mish/agency-fast-lane/taxonomy";
      const taxonomy = await loadDesignTaxonomy();
      process.stdout.write(taxonomy.version);
    `);

    expect(result.ok).toBe(false);
    // import.meta.dirname resolved to the bundle's own directory, so the read missed.
    expect(result.output).toContain("ENOENT");
    expect(result.output).toContain("design-taxonomy.json");
  }, 60_000);
});
