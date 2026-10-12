import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  LICENSED_PACK_BLOB_LIST_MIN_IDS,
  LICENSED_PACK_BLOB_LIST_PATH,
  MOTIONSITES_AUTHOR_NAMES,
  checkLicensedPackContent,
  findLicensedPackContentViolations,
  gitBlobId,
  reportLicensedPackViolations,
  resolveLicensedPackGuardMode,
  type LicensedPackViolation,
  type TrackedFile,
} from "../../../scripts/check-licensed-pack-content.ts";
import {
  generateLicensedPackBlobList,
  selectLicensedPackBlobs,
} from "../../../scripts/generate-licensed-pack-blobs.ts";

// Every fixture below is synthetic: made-up slugs, made-up hashes and
// placeholder text. No licensed bytes are needed to prove the rules, and the
// guard's blob rule would flag a real licensed blob anywhere in the tree.

const FAKE_SHA256 = "0".repeat(63) + "1";

// Signature literals are assembled at run time so this test file does not
// itself match the shape rules when `pnpm guard` scans the tree.
const CULT_PRO = ["Cult", "Pro"].join(" ");
const DERIVED_HEADER = ["// Derived at author time from the licensed", "Cult UI Pro", "block `example`"].join(" ");
// The converter's scoped root rule and root element, split so the source never holds them whole.
const CONVERTED_CSS = [".cult-synthetic-block{--radius:.5rem;line-height:1.5;", "font-family:var(--role-font-body,sans-serif)}"].join("");
const CONVERTED_HTML = ['<div class="cult-synthetic-block" data-od-role="hero">', "<div class=", '"c0 c5 cx"></div></div>'].join("");
// The author signature keys on the real author list, so the test reads it
// from the module instead of spelling it; other manifests use made-up names.
const MOTIONSITES_AUTHOR = MOTIONSITES_AUTHOR_NAMES[0]!;

const ADAPTER_SHAPED_SOURCE = [
  "export const ADAPTER = {",
  '  id: "cult:example-block",',
  '  sourceBlockId: "cult:example-block",',
  `  sourceSha256: "${FAKE_SHA256}",`,
  "};",
].join("\n");

const ORIGINALS_SHAPED_SOURCE = [
  "// Reference-only community component, not Cult UI Pro.",
  "export const meta = { id: \"twentyfirst:example-card\", sourceSha256: \"" + FAKE_SHA256 + "\" };",
].join("\n");

function oidFor(text: string): string {
  return gitBlobId(Buffer.from(text, "utf8"));
}

type SyntheticFile = { path: string; text: string };

async function violationsFor(
  files: readonly SyntheticFile[],
  options: {
    deniedBlobs?: readonly string[];
    sectionCatalogCultProRule?: boolean;
  } = {},
): Promise<LicensedPackViolation[]> {
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const tracked: TrackedFile[] = files.map((file) => ({ path: file.path, oid: oidFor(file.text) }));
  return findLicensedPackContentViolations({
    files: tracked,
    readText: async (repositoryPath) => byPath.get(repositoryPath),
    deniedBlobs: new Set(options.deniedBlobs ?? []),
    rules: {
      sectionCatalogCultProRule: options.sectionCatalogCultProRule ?? false,
    },
  });
}

function flaggedPaths(violations: readonly LicensedPackViolation[]): string[] {
  return violations.map((violation) => violation.path).sort();
}

function reasonsFor(violations: readonly LicensedPackViolation[], repositoryPath: string): string[] {
  return violations.find((violation) => violation.path === repositoryPath)?.reasons ?? [];
}

describe("licensed pack content matcher", () => {
  test("flags a file under data/component-kits/cult-ui-pro/ by path alone", async () => {
    const violations = await violationsFor([
      { path: "data/component-kits/cult-ui-pro/registry/foo.json", text: "" },
      { path: "data/component-kits/cult-ui-pro/converted/foo/template.html", text: "<div></div>" },
      { path: "data/component-kits/README.md", text: "Component kits live here." },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "data/component-kits/cult-ui-pro/converted/foo/template.html",
      "data/component-kits/cult-ui-pro/registry/foo.json",
    ]);
    expect(reasonsFor(violations, "data/component-kits/cult-ui-pro/registry/foo.json").join(" ")).toMatch(/^path:/);
  });

  test("flags the Cult-keyed cult-ui-catalog data by path, but not its 21st.dev files, preview artwork or originals", async () => {
    const violations = await violationsFor([
      { path: "packages/cult-ui-catalog/catalog.json", text: "{}" },
      { path: "packages/cult-ui-catalog/catalog-curation.json", text: "{}" },
      { path: "packages/cult-ui-catalog/catalog-copy-refinements.json", text: "{}" },
      { path: "packages/cult-ui-catalog/reviewed-overrides.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/index.ts", text: "export {};" },
      { path: "packages/cult-ui-catalog/generated/section-adapter.ts", text: "export {};" },
      { path: "packages/cult-ui-catalog/generated/slugs.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/public-names.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/thumbnails.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/thumbnail-capture-report.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/thumbnails/example.webp", text: "x" },
      { path: "packages/cult-ui-catalog/generated/previews/example.html", text: "x" },
      { path: "packages/cult-ui-catalog/generated/21st-items.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/21st-thumbnails/example.webp", text: "x" },
      { path: "packages/cult-ui-catalog/generated/21st-thumbnails.json", text: "{}" },
      { path: "packages/cult-ui-catalog/generated/preview-artwork/example.webp", text: "x" },
      { path: "packages/cult-ui-catalog/originals/example-card/index.tsx", text: "export {};" },
      { path: "packages/cult-ui-catalog/src/build.ts", text: "export {};" },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "packages/cult-ui-catalog/catalog-copy-refinements.json",
      "packages/cult-ui-catalog/catalog-curation.json",
      "packages/cult-ui-catalog/catalog.json",
      "packages/cult-ui-catalog/generated/index.ts",
      "packages/cult-ui-catalog/generated/previews/example.html",
      "packages/cult-ui-catalog/generated/public-names.json",
      "packages/cult-ui-catalog/generated/section-adapter.ts",
      "packages/cult-ui-catalog/generated/slugs.json",
      "packages/cult-ui-catalog/generated/thumbnail-capture-report.json",
      "packages/cult-ui-catalog/generated/thumbnails.json",
      "packages/cult-ui-catalog/generated/thumbnails/example.webp",
      "packages/cult-ui-catalog/reviewed-overrides.json",
    ]);
  });

  test("flags a packages/cult-ui-catalog/generated/adapters/*.ts file by its sourceSha256 + cult: id signature, without false-positiving on packages/cult-ui-catalog/originals/**", async () => {
    const violations = await violationsFor([
      { path: "packages/cult-ui-catalog/generated/adapters/example-block.ts", text: ADAPTER_SHAPED_SOURCE },
      // The same signature pasted somewhere no path rule covers.
      { path: "apps/web/src/pasted-adapter.ts", text: ADAPTER_SHAPED_SOURCE },
      { path: "packages/cult-ui-catalog/originals/example-card/index.tsx", text: ORIGINALS_SHAPED_SOURCE },
      // The package name contains "cult"; a substring matcher would flag these.
      { path: "packages/cult-ui-catalog/src/kit.ts", text: "export const kit = 'cult-ui-catalog';" },
      { path: "apps/daemon/src/routes/twenty1st.ts", text: `const record = { sourceSha256: "${FAKE_SHA256}" };` },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "apps/web/src/pasted-adapter.ts",
      "packages/cult-ui-catalog/generated/adapters/example-block.ts",
    ]);
    const adapterReasons = reasonsFor(violations, "packages/cult-ui-catalog/generated/adapters/example-block.ts");
    expect(adapterReasons.some((reason) => reason.startsWith("path:"))).toBe(true);
    expect(reasonsFor(violations, "apps/web/src/pasted-adapter.ts")).toEqual(["shape:cult-adapter-signature"]);
  });

  test("flags the derived-adapter header comment even without the fields", async () => {
    const violations = await violationsFor([
      {
        path: "apps/web/src/derived.ts",
        text: `${DERIVED_HEADER}\nexport {};`,
      },
    ]);
    expect(reasonsFor(violations, "apps/web/src/derived.ts")).toEqual(["shape:cult-adapter-signature"]);
  });

  test("flags a Cult registry item by its author field at any path", async () => {
    const violations = await violationsFor([
      { path: "apps/web/public/registry/item.json", text: `{"name":"example","author":"${CULT_PRO}","files":[]}` },
      { path: "apps/web/public/registry/other.json", text: '{"name":"example","author":"Someone Else"}' },
    ]);
    expect(flaggedPaths(violations)).toEqual(["apps/web/public/registry/item.json"]);
    expect(reasonsFor(violations, "apps/web/public/registry/item.json")).toEqual(["shape:cult-registry-author"]);
  });

  test("flags a MotionSites example manifest by homepage + author, independent of the per-example SKILL.md/example.html content", async () => {
    const motionSitesManifest = JSON.stringify({
      name: "example-synthetic-landing",
      homepage: "https://motionsites.ai/sections",
      author: { name: "Synthetic Author" },
      license: "MIT",
    });
    const otherManifest = JSON.stringify({
      name: "example-house-landing",
      homepage: "https://example.test/house",
      author: { name: "House Team" },
    });
    const violations = await violationsFor([
      { path: "plugins/_official/examples/synthetic-landing/mish.json", text: motionSitesManifest },
      { path: "plugins/_official/examples/synthetic-landing/SKILL.md", text: "# Unrelated text" },
      { path: "plugins/_official/examples/synthetic-landing/example.html", text: "<p>unrelated</p>" },
      { path: "plugins/_official/examples/house-landing/mish.json", text: otherManifest },
      { path: "plugins/_official/examples/house-landing/SKILL.md", text: "# House" },
      // A copy dropped outside the examples folder is still a manifest.
      { path: "plugins/community/moved/mish.json", text: motionSitesManifest },
      { path: "plugins/community/moved/assets/hero.html", text: "<p>unrelated</p>" },
      // Outside plugins/ no folder rule applies, but the manifest shape still does.
      { path: "docs/stray/mish.json", text: motionSitesManifest },
      { path: "docs/stray/notes.md", text: "unrelated" },
      // Owner-kept examples carry no MotionSites homepage, so this check never sees them.
      {
        path: "plugins/_official/examples/velar-luxury-real-estate/mish.json",
        text: JSON.stringify({ name: "example-velar-luxury-real-estate", author: { name: "House Team" } }),
      },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "docs/stray/mish.json",
      "plugins/_official/examples/synthetic-landing/SKILL.md",
      "plugins/_official/examples/synthetic-landing/example.html",
      "plugins/_official/examples/synthetic-landing/mish.json",
      "plugins/community/moved/assets/hero.html",
      "plugins/community/moved/mish.json",
    ]);
    expect(reasonsFor(violations, "plugins/_official/examples/synthetic-landing/SKILL.md")).toEqual([
      "path:motionsites-plugin-folder",
    ]);
    expect(reasonsFor(violations, "docs/stray/mish.json")).toEqual(["shape:motionsites-manifest"]);
  });

  test("MotionSites manifests match a homepage in any letter case, or a MotionSites author under CC-BY-4.0 without one", async () => {
    const upperHomepage = JSON.stringify({ homepage: "HTTPS://MotionSites.AI/Sections", author: { name: "Synthetic Author" } });
    const authorAndLicence = JSON.stringify({ author: { name: MOTIONSITES_AUTHOR }, license: "cc-by-4.0" });
    const authorOtherLicence = JSON.stringify({ author: { name: MOTIONSITES_AUTHOR }, license: "MIT" });
    const licenceOtherAuthor = JSON.stringify({ author: { name: "Synthetic Author" }, license: "CC-BY-4.0" });
    const violations = await violationsFor([
      { path: "plugins/_official/examples/upper/mish.json", text: upperHomepage },
      { path: "plugins/_official/examples/upper/example.html", text: "<p>unrelated</p>" },
      { path: "plugins/_official/examples/stripped/mish.json", text: authorAndLicence },
      { path: "plugins/_official/examples/stripped/SKILL.md", text: "# unrelated" },
      { path: "plugins/_official/examples/house-one/mish.json", text: authorOtherLicence },
      { path: "plugins/_official/examples/house-two/mish.json", text: licenceOtherAuthor },
      { path: "docs/stray/manifest.json", text: authorAndLicence },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "docs/stray/manifest.json",
      "plugins/_official/examples/stripped/SKILL.md",
      "plugins/_official/examples/stripped/mish.json",
      "plugins/_official/examples/upper/example.html",
      "plugins/_official/examples/upper/mish.json",
    ]);
    expect(reasonsFor(violations, "docs/stray/manifest.json")).toEqual(["shape:motionsites-manifest"]);
  });

  test("the author and adapter signature rules run on every text file, not only JSON and code", async () => {
    const violations = await violationsFor([
      { path: "docs/notes/item.md", text: `Pasted: {"name":"example","author":"${CULT_PRO}"}` },
      { path: "docs/notes/header.txt", text: DERIVED_HEADER },
      { path: "apps/web/public/registry/item.yaml", text: `author: x\n"author": "${CULT_PRO}"` },
      // Binary formats are never read, whatever bytes they hold.
      { path: "apps/web/public/image.webp", text: `"author":"${CULT_PRO}"` },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "apps/web/public/registry/item.yaml",
      "docs/notes/header.txt",
      "docs/notes/item.md",
    ]);
  });

  test("flags converted kit markup in CSS and HTML at any path, but not ordinary cult- class names", async () => {
    const violations = await violationsFor([
      { path: "apps/web/public/blocks/hero.css", text: `${CONVERTED_CSS}.cult-synthetic-block .c0{display:flex}` },
      { path: "apps/web/public/blocks/hero.html", text: CONVERTED_HTML },
      { path: "apps/web/src/embedded.ts", text: `export const html = \`${CONVERTED_HTML}\`;` },
      // Synthetic adapter-test shapes and plain class names are not converter output.
      { path: "packages/demo/tests/adapter.test.ts", text: '<div class="cult-demo" data-od-role="cta-band"><h2>Hi</h2></div>' },
      { path: "apps/web/src/panel.css", text: ".cult-catalog-panel{display:grid}:where(.cult-x) h1{margin:0}" },
      { path: "docs/links.md", text: "See https://pro.cult-ui.com for the product." },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "apps/web/public/blocks/hero.css",
      "apps/web/public/blocks/hero.html",
      "apps/web/src/embedded.ts",
    ]);
    expect(reasonsFor(violations, "apps/web/public/blocks/hero.css")).toEqual(["shape:cult-converted-markup"]);
  });

  test("flags genui catalog rows recorded as licensed Cult UI Pro, but not a schema enum or clean-room rows", async () => {
    const catalog = JSON.stringify({
      components: [
        { id: "clean-one", source: { name: "react-bits" }, licenceDecision: "clean-room" },
        { id: "synthetic-port", source: { name: "cult-ui-pro" }, licenceDecision: "licensed" },
      ],
    });
    const cleanCatalog = JSON.stringify({
      components: [{ id: "clean-one", source: { name: "react-bits" }, licenceDecision: "clean-room" }],
    });
    const schema = JSON.stringify({
      properties: {
        source: { properties: { name: { enum: ["react-bits", "cult-ui-pro"] } } },
        licenceDecision: { enum: ["clean-room", "licensed", "cut"] },
      },
    });
    const violations = await violationsFor([
      { path: "packages/genui-catalog/catalog.json", text: catalog },
      { path: "packages/other-catalog/catalog.json", text: cleanCatalog },
      { path: "packages/genui-catalog/schema/catalog.schema.json", text: schema },
      {
        path: "packages/genui-catalog/data/some-seed.json",
        text: JSON.stringify({ components: [{ source: { Source: "Cult UI Pro" } }] }),
      },
      { path: "packages/genui-catalog/data/cult-ui-pro-seed.json", text: "{}" },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "packages/genui-catalog/catalog.json",
      "packages/genui-catalog/data/cult-ui-pro-seed.json",
      "packages/genui-catalog/data/some-seed.json",
    ]);
    expect(reasonsFor(violations, "packages/genui-catalog/catalog.json")).toEqual(["shape:genui-cult-licensed-row"]);
    expect(reasonsFor(violations, "packages/genui-catalog/data/some-seed.json")).toEqual(["shape:genui-cult-seed-row"]);
  });

  test("the six genui port directories and the seed are flagged by path, and other genui components are not", async () => {
    const violations = await violationsFor([
      { path: "packages/genui-catalog/components/organic-button/meta.json", text: "{}" },
      { path: "packages/genui-catalog/components/organic-card-small/index.js", text: "export {};" },
      { path: "packages/genui-catalog/components/texture-card/index.js", text: "export {};" },
      { path: "packages/genui-catalog/components/silk/meta.json", text: "{}" },
      { path: "packages/genui-catalog/data/cult-ui-pro-seed.json", text: "{}" },
      { path: "packages/genui-catalog/data/catalog-seed.json", text: "{}" },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "packages/genui-catalog/components/organic-button/meta.json",
      "packages/genui-catalog/components/organic-card-small/index.js",
      "packages/genui-catalog/components/texture-card/index.js",
      "packages/genui-catalog/data/cult-ui-pro-seed.json",
    ]);
    expect(reasonsFor(violations, "packages/genui-catalog/components/organic-button/meta.json")).toEqual([
      "path:genui-cult-port",
    ]);
  });

  test('the section-catalog sourceKind "cult-pro" sub-rule stays off until P1-8 activates it', async () => {
    const files = [
      {
        path: "packages/section-catalog/catalog.json",
        text: JSON.stringify({ sections: [{ id: "synthetic", sourceKind: "cult-pro" }] }),
      },
    ];
    expect(await violationsFor(files)).toEqual([]);
    expect(reasonsFor(await violationsFor(files, { sectionCatalogCultProRule: true }), files[0]!.path)).toEqual([
      "shape:section-catalog-cult-pro",
    ]);
  });

  test("a file's git blob id matching the committed denylist is flagged even outside the licensed paths", async () => {
    // An adapter .ts moved to apps/web/src/x.ts with its signature lines
    // stripped: no path or shape rule fires, only the blob id gives it away.
    const strippedAdapterBytes = "export const css = `.synthetic-block { color: red; }`;\n".repeat(4);
    const violations = await violationsFor(
      [
        { path: "apps/web/src/x.ts", text: strippedAdapterBytes },
        { path: "apps/web/src/y.ts", text: "export const unrelated = true;\n" },
      ],
      { deniedBlobs: [oidFor(strippedAdapterBytes)] },
    );
    expect(flaggedPaths(violations)).toEqual(["apps/web/src/x.ts"]);
    expect(reasonsFor(violations, "apps/web/src/x.ts")).toEqual(["blob"]);
  });

  test('a pack.json with "format": "mishh-pack@1" is flagged at any path outside the fixture roots (apps/daemon/tests/fixtures/licensed-pack/), and inside them is not flagged by shape but still by blob', async () => {
    const packManifest = JSON.stringify({ format: "mishh-pack@1", id: "synthetic-pack", version: "1.0.0" });
    const deniedFixture = '{"format":"mishh-pack@1","id":"denied-synthetic-pack","version":"1.0.0","files":[]}';
    const violations = await violationsFor(
      [
        { path: "pack.json", text: packManifest },
        { path: "tools/scratch/build/pack.json", text: packManifest },
        // The exemption is anchored at the known roots, not any depth.
        { path: "packages/other/tests/fixtures/licensed-pack/pack.json", text: packManifest },
        { path: "apps/daemon/tests/fixtures/licensed-pack/basic/pack.json", text: packManifest },
        { path: "apps/daemon/tests/fixtures/licensed-pack/denied/pack.json", text: deniedFixture },
        // Path rules are also exempt inside the fixture folder.
        {
          path: "apps/daemon/tests/fixtures/licensed-pack/data/component-kits/cult-ui-pro/registry/a.json",
          text: `{"author":"${CULT_PRO}"}`,
        },
        { path: "tools/scratch/build/other.json", text: JSON.stringify({ format: "something-else@1" }) },
      ],
      { deniedBlobs: [oidFor(deniedFixture)] },
    );
    expect(flaggedPaths(violations)).toEqual([
      "apps/daemon/tests/fixtures/licensed-pack/denied/pack.json",
      "pack.json",
      "packages/other/tests/fixtures/licensed-pack/pack.json",
      "tools/scratch/build/pack.json",
    ]);
    expect(reasonsFor(violations, "pack.json")).toEqual(["shape:pack-manifest"]);
    expect(reasonsFor(violations, "apps/daemon/tests/fixtures/licensed-pack/denied/pack.json")).toEqual(["blob"]);
  });

  test("a tracked .tgz, .tar, .tar.gz or .zip archive is flagged at any path outside the fixture roots, in any letter case (Sol #191)", async () => {
    // Archives are binary, so the shape rules never read them; the path is the rule.
    const archiveBytes = "synthetic archive placeholder";
    const violations = await violationsFor([
      { path: "packages/21st-catalog/generated/pack.tgz", text: archiveBytes },
      { path: "vendor/kit.TAR.GZ", text: archiveBytes },
      { path: "tools/scratch/kit.tar", text: archiveBytes },
      { path: "assets/kit.Zip", text: archiveBytes },
      // Anchored at the known roots, not any depth.
      { path: "packages/other/tests/fixtures/licensed-pack/pack.tgz", text: archiveBytes },
      { path: "apps/daemon/tests/fixtures/licensed-pack/basic.tgz", text: archiveBytes },
      { path: "apps/daemon/tests/fixtures/licensed-pack/basic.zip", text: archiveBytes },
      // Not archives.
      { path: "docs/tar-notes.md", text: "notes" },
      { path: "data/catalog.json.gz", text: "{}" },
      { path: "src/zip.ts", text: "export {};" },
    ]);
    expect(flaggedPaths(violations)).toEqual([
      "assets/kit.Zip",
      "packages/21st-catalog/generated/pack.tgz",
      "packages/other/tests/fixtures/licensed-pack/pack.tgz",
      "tools/scratch/kit.tar",
      "vendor/kit.TAR.GZ",
    ]);
    expect(reasonsFor(violations, "packages/21st-catalog/generated/pack.tgz")).toEqual(["path:tracked-archive"]);
  });
});

describe("licensed pack guard mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const violation: LicensedPackViolation = {
    path: "data/component-kits/cult-ui-pro/registry/foo.json",
    reasons: ["path:cult-ui-pro-kit"],
  };

  test("warn-only mode reports violations without failing the check", () => {
    const errors: string[] = [];
    const log = { error: (line: string) => errors.push(line), log: () => {} };
    expect(reportLicensedPackViolations([violation], "warn", log)).toBe(true);
    expect(errors.join("\n")).toContain("advisory (on-demand check)");
    expect(errors.join("\n")).toContain(violation.path);

    errors.length = 0;
    expect(reportLicensedPackViolations([violation], "enforce", log)).toBe(false);
    expect(errors.join("\n")).toContain(violation.path);
    expect(errors.join("\n")).not.toContain("advisory (on-demand check)");
  });

  test("LICENSED_PACK_GUARD_MODE defaults to warn, accepts enforce, and rejects anything else", () => {
    expect(resolveLicensedPackGuardMode(undefined)).toEqual({ mode: "warn" });
    expect(resolveLicensedPackGuardMode("")).toEqual({ mode: "warn" });
    expect(resolveLicensedPackGuardMode("warn")).toEqual({ mode: "warn" });
    expect(resolveLicensedPackGuardMode("enforce")).toEqual({ mode: "enforce" });
    expect(resolveLicensedPackGuardMode("enforced")).toHaveProperty("error");
  });
});

// Real-git cases: a throwaway repository under the OS temp directory, so the
// guard's `git ls-files -s` path and the generator's `git ls-tree` path run
// for real against synthetic content.
const scratchRoots: string[] = [];

async function scratchRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "licensed-pack-guard-"));
  scratchRoots.push(root);
  for (const [repositoryPath, text] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(repositoryPath)), { recursive: true });
    await writeFile(path.join(root, repositoryPath), text, "utf8");
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=guard@example.test", "-c", "user.name=guard", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
  return root;
}

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LONG_LICENSED_TEXT = "synthetic licensed payload line\n".repeat(8);
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const LONG_SHARED_TEXT = "shared boilerplate that also lives outside the licensed set\n".repeat(4);

describe("licensed pack blob generator", () => {
  test("gitBlobId matches git hash-object", async () => {
    const root = await scratchRepo({ "a.txt": LONG_LICENSED_TEXT });
    const expected = execFileSync("git", ["hash-object", "a.txt"], { cwd: root, encoding: "utf8" }).trim();
    expect(gitBlobId(Buffer.from(LONG_LICENSED_TEXT, "utf8"))).toBe(expected);
  });

  test("the generator drops blobs under 64 bytes and blobs that also occur outside the licensed path set, writes sorted unique git blob ids with no paths, and is byte-identical on a second run", async () => {
    const tiny = "tiny\n";
    const licensedA = LONG_LICENSED_TEXT;
    const licensedB = LONG_LICENSED_TEXT + "second file\n";
    const root = await scratchRepo({
      "data/component-kits/cult-ui-pro/registry/a.json": licensedA,
      "data/component-kits/cult-ui-pro/registry/a-copy.json": licensedA,
      "data/component-kits/cult-ui-pro/registry/b.json": licensedB,
      "data/component-kits/cult-ui-pro/registry/tiny.json": tiny,
      "data/component-kits/cult-ui-pro/LICENSE-NOTE.txt": LONG_SHARED_TEXT,
      "docs/shared-note.txt": LONG_SHARED_TEXT,
      "apps/web/src/unrelated.ts": "export const unrelated = 'not licensed content at all, long enough to keep';\n",
    });

    const { text: first } = await generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", existing: "" });
    const lines = first.trimEnd().split("\n");
    expect(lines).toEqual([oidFor(licensedA), oidFor(licensedB)].sort());
    expect(first).not.toContain("data/");
    expect(first).not.toContain(oidFor(tiny));
    expect(first).not.toContain(oidFor(LONG_SHARED_TEXT));
    expect(first.endsWith("\n")).toBe(true);

    const { text: second } = await generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", existing: "" });
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  test("the generator reports every dropped shared blob with its other paths, and fixture copies do not count as shared", async () => {
    const fixtureCopy = LONG_LICENSED_TEXT + "copied into a fixture\n";
    const root = await scratchRepo({
      "data/component-kits/cult-ui-pro/LICENSE-NOTE.txt": LONG_SHARED_TEXT,
      "docs/shared-note.txt": LONG_SHARED_TEXT,
      "apps/web/src/also-shared.txt": LONG_SHARED_TEXT,
      "data/component-kits/cult-ui-pro/registry/c.json": fixtureCopy,
      "apps/daemon/tests/fixtures/licensed-pack/basic/c.json": fixtureCopy,
    });
    const result = await generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", existing: "" });
    expect(result.droppedShared).toEqual([
      {
        oid: oidFor(LONG_SHARED_TEXT),
        sources: ["data/component-kits/cult-ui-pro/LICENSE-NOTE.txt"],
        sharedWith: ["apps/web/src/also-shared.txt", "docs/shared-note.txt"],
      },
    ]);
    expect(result.text).toBe(`${oidFor(fixtureCopy)}\n`);
  });

  test("the generator hashes registry files[].content payloads, so a payload saved as its own file is flagged by blob", async () => {
    const payload = 'export function SyntheticBlock() {\n  return <section className="synthetic">Synthetic payload</section>;\n}';
    const registryItem = JSON.stringify({
      name: "synthetic-block",
      files: [{ path: "registry/blocks/synthetic-block.tsx", content: payload }, { path: "x", content: "tiny" }],
    });
    const root = await scratchRepo({ "data/component-kits/cult-ui-pro/registry/synthetic-block.json": registryItem });
    const { text } = await generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", existing: "" });
    const ids = new Set(text.trimEnd().split("\n"));
    expect(ids.has(oidFor(payload))).toBe(true);
    expect(ids.has(oidFor(`${payload}\n`))).toBe(true);
    expect(ids.has(oidFor("tiny"))).toBe(false);

    // Moved out of the kit as written, or as an editor saves it (trailing newline).
    for (const moved of [payload, `${payload}\n`]) {
      const violations = await violationsFor([{ path: "apps/web/src/components/x.tsx", text: moved }], {
        deniedBlobs: [...ids],
      });
      expect(reasonsFor(violations, "apps/web/src/components/x.tsx")).toEqual(["blob"]);
    }
  });

  test("--pack-dir hashes each pack.json files[] entry with the same drop rules and extends the list", async () => {
    const root = await scratchRepo({
      "docs/shared-note.txt": LONG_SHARED_TEXT,
    });
    const packDir = await mkdtemp(path.join(tmpdir(), "licensed-pack-dir-"));
    scratchRoots.push(packDir);
    const packOnly = LONG_LICENSED_TEXT + "only in the pack\n";
    await mkdir(path.join(packDir, "kits/synthetic"), { recursive: true });
    await writeFile(path.join(packDir, "kits/synthetic/item.json"), packOnly, "utf8");
    await writeFile(path.join(packDir, "kits/synthetic/tiny.json"), "{}", "utf8");
    await writeFile(path.join(packDir, "kits/synthetic/shared.txt"), LONG_SHARED_TEXT, "utf8");
    await writeFile(
      path.join(packDir, "pack.json"),
      JSON.stringify({
        format: "mishh-pack@1",
        id: "synthetic-pack",
        files: [
          { path: "kits/synthetic/item.json", sha256: sha256Of(packOnly) },
          { path: "kits/synthetic/tiny.json", sha256: sha256Of("{}") },
          { path: "kits/synthetic/shared.txt", sha256: sha256Of(LONG_SHARED_TEXT) },
        ],
      }),
      "utf8",
    );
    const earlier = `${"f".repeat(40)}\n`;
    const result = await generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", packDir, existing: earlier });
    expect(result.text).toBe([oidFor(packOnly), "f".repeat(40)].sort().join("\n") + "\n");
    expect(result.droppedShared.map((blob) => blob.sources)).toEqual([["pack:kits/synthetic/shared.txt"]]);

    // A file that does not match its recorded sha256 stops the run.
    await writeFile(path.join(packDir, "kits/synthetic/item.json"), `${packOnly}tampered\n`, "utf8");
    await expect(
      generateLicensedPackBlobList({ repoRoot: root, ref: "HEAD", packDir, existing: "" }),
    ).rejects.toThrow(/does not match pack.json/);
  });

  test("selectLicensedPackBlobs is pure over a tree listing", () => {
    const { ids, droppedShared } = selectLicensedPackBlobs({
      tree: [
        { path: "licensed/a", oid: "b".repeat(40), size: 100 },
        { path: "licensed/b", oid: "a".repeat(40), size: 100 },
        { path: "licensed/c", oid: "c".repeat(40), size: 10 },
        { path: "licensed/d", oid: "d".repeat(40), size: 100 },
        { path: "public/d", oid: "d".repeat(40), size: 100 },
      ],
      licensedPaths: new Set(["licensed/a", "licensed/b", "licensed/c", "licensed/d"]),
    });
    expect(ids).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(droppedShared).toEqual([{ oid: "d".repeat(40), sources: ["licensed/d"], sharedWith: ["public/d"] }]);
  });
});

describe("licensed pack guard wrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the guard passes in enforce mode on a synthetic tree without licensed content", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "apps/web/src/index.ts": "export const ok = true;\n",
      "plugins/_official/examples/house/mish.json": JSON.stringify({ homepage: "https://example.test" }),
    });
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  test("the guard fails in enforce mode and passes in warn mode on a synthetic tree with licensed content", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = LONG_LICENSED_TEXT;
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${oidFor(denied)}\n`,
      "apps/web/src/moved.ts": denied,
    });
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "warn", minBlobIds: 1 })).resolves.toBe(true);
  });

  test("a tracked pack archive fails in enforce mode and is advisory in warn mode (Sol #191)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "packages/21st-catalog/generated/pack.tgz": "synthetic archive placeholder",
    });
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
    expect(errors.join("\n")).toContain("packages/21st-catalog/generated/pack.tgz [path:tracked-archive]");
    errors.length = 0;
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "warn", minBlobIds: 1 })).resolves.toBe(true);
    expect(errors.join("\n")).toContain(
      "advisory (on-demand check): packages/21st-catalog/generated/pack.tgz [path:tracked-archive]",
    );
  });

  test("enforce mode fails closed when the blob denylist is missing or malformed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await scratchRepo({ "apps/web/src/index.ts": "export const ok = true;\n" });
    await expect(checkLicensedPackContent({ repoRoot: missing }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
    await expect(checkLicensedPackContent({ repoRoot: missing }, { mode: "warn", minBlobIds: 1 })).resolves.toBe(true);

    const malformed = await scratchRepo({ [LICENSED_PACK_BLOB_LIST_PATH]: "data/component-kits/x.json\n" });
    await expect(checkLicensedPackContent({ repoRoot: malformed }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
  });

  test("enforce mode fails closed when the denylist holds fewer ids than LICENSED_PACK_BLOB_LIST_MIN_IDS", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "apps/web/src/index.ts": "export const ok = true;\n",
    });
    expect(LICENSED_PACK_BLOB_LIST_MIN_IDS).toBeGreaterThan(1);
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce" })).resolves.toBe(false);
    expect(errors.join("\n")).toContain("truncated");
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "warn" })).resolves.toBe(true);
  });

  test("LICENSED_PACK_GUARD_MODE from the environment drives the wrapper: enforce fails on content, a bad value always fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = LONG_LICENSED_TEXT;
    const dirty = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${oidFor(denied)}\n`,
      "apps/web/src/moved.ts": denied,
    });
    const clean = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "apps/web/src/index.ts": "export const ok = true;\n",
    });
    try {
      vi.stubEnv("LICENSED_PACK_GUARD_MODE", "enforce");
      await expect(checkLicensedPackContent({ repoRoot: dirty }, { minBlobIds: 1 })).resolves.toBe(false);
      await expect(checkLicensedPackContent({ repoRoot: clean }, { minBlobIds: 1 })).resolves.toBe(true);
      vi.stubEnv("LICENSED_PACK_GUARD_MODE", "enforced");
      await expect(checkLicensedPackContent({ repoRoot: clean }, { minBlobIds: 1 })).resolves.toBe(false);
      vi.stubEnv("LICENSED_PACK_GUARD_MODE", "");
      await expect(checkLicensedPackContent({ repoRoot: dirty }, { minBlobIds: 1 })).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("enforce mode fails when a tracked file cannot be read, and gitlinks are reported", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "apps/web/src/gone.ts": "export const gone = true;\n",
    });
    await rm(path.join(root, "apps/web/src/gone.ts"));
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub`], { cwd: root });
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
    expect(errors.join("\n")).toContain("apps/web/src/gone.ts");
    expect(errors.join("\n")).toContain("gitlink (submodule) vendor/sub");
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "warn", minBlobIds: 1 })).resolves.toBe(true);
  });

  test("gzip files are unpacked for the shape rules", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await scratchRepo({
      [LICENSED_PACK_BLOB_LIST_PATH]: `${"e".repeat(40)}\n`,
      "apps/web/src/index.ts": "export const ok = true;\n",
    });
    await mkdir(path.join(root, "apps/web/public"), { recursive: true });
    await writeFile(path.join(root, "apps/web/public/preview.html.gz"), gzipSync(Buffer.from(CONVERTED_HTML, "utf8")));
    execFileSync("git", ["add", "apps/web/public/preview.html.gz"], { cwd: root });
    await expect(checkLicensedPackContent({ repoRoot: root }, { mode: "enforce", minBlobIds: 1 })).resolves.toBe(false);
  });

  test("the check is not registered in the public guard entrypoint", () => {
    // Not registered since 2026-10-08 (the repo stays private, so P1-8's
    // enforce flip is cancelled); run it on demand instead — see the file
    // header of scripts/check-licensed-pack-content.ts.
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const names = execFileSync("pnpm", ["--silent", "guard", "--list-checks"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(names).not.toContain("licensed pack content");
  });

  test("the guard's own sources and this spec do not match its rules", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const own = [
      "scripts/check-licensed-pack-content.ts",
      "scripts/generate-licensed-pack-blobs.ts",
      "e2e/tests/scripts/check-licensed-pack-content.test.ts",
    ];
    const texts = new Map<string, string>();
    for (const repositoryPath of own) texts.set(repositoryPath, await readFile(path.join(repoRoot, repositoryPath), "utf8"));
    const violations = await findLicensedPackContentViolations({
      files: own.map((repositoryPath) => ({ path: repositoryPath, oid: "0".repeat(40) })),
      readText: async (repositoryPath) => texts.get(repositoryPath),
      deniedBlobs: new Set(),
      rules: { sectionCatalogCultProRule: true },
    });
    expect(violations).toEqual([]);
  });

  test("the committed denylist is sorted, unique, path-free git blob ids", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const text = await readFile(path.join(repoRoot, LICENSED_PACK_BLOB_LIST_PATH), "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{40}$/);
    expect([...new Set(lines)].sort()).toEqual(lines);
  });
});
