import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const kitRoot = path.join(repoRoot, "plugins/_official/shared/ui-kits/hyperui");

const PINNED_COMMIT = "ae5038979b77320793360a46b85e7c71a73beda6";
const BLOCK_MAX_BYTES = 20 * 1024;
const CRM_DASHBOARD_CSS_MAX_BYTES = 120 * 1024;

interface ManifestBlock {
  id: string;
  file: string;
  bytes: number;
  images: number;
  scripts: number;
}

interface Manifest {
  upstream: { repo: string; commit: string; fetchedAt: string };
  blocks: ManifestBlock[];
}

function readManifest(): Manifest {
  const manifestPath = path.join(kitRoot, "manifest.json");
  expect(existsSync(manifestPath), `expected ${manifestPath} to exist`).toBe(true);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

describe("HyperUI vendoring", () => {
  test("manifest.json exists and lists at least one block", () => {
    const manifest = readManifest();
    expect(manifest.blocks.length).toBeGreaterThan(0);
  });

  test("every listed block file exists and is clean of script, img, and absolute-URL references", () => {
    const manifest = readManifest();
    for (const block of manifest.blocks) {
      const blockPath = path.join(kitRoot, block.file);
      expect(existsSync(blockPath), `expected block file to exist: ${block.file}`).toBe(true);

      const contents = readFileSync(blockPath, "utf8");
      expect(contents, `${block.file} must not contain <script`).not.toContain("<script");
      expect(contents, `${block.file} must not contain <img`).not.toContain("<img");
      expect(contents, `${block.file} must not contain http://`).not.toContain("http://");
      expect(contents, `${block.file} must not contain https://`).not.toContain("https://");
    }
  });

  test("every block file stays under the 20 KB per-block guard", () => {
    const manifest = readManifest();
    for (const block of manifest.blocks) {
      const blockPath = path.join(kitRoot, block.file);
      const { size } = statSync(blockPath);
      expect(size, `${block.file} is ${size} bytes, over the ${BLOCK_MAX_BYTES} byte guard`).toBeLessThan(
        BLOCK_MAX_BYTES,
      );
    }
  });

  test("UPSTREAM.json pins the exact vendored commit", () => {
    const upstreamPath = path.join(kitRoot, "UPSTREAM.json");
    expect(existsSync(upstreamPath)).toBe(true);
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as { commit: string };
    expect(upstream.commit).toBe(PINNED_COMMIT);
  });

  test("LICENSE is the MIT license", () => {
    const licensePath = path.join(kitRoot, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const license = readFileSync(licensePath, "utf8");
    expect(license.startsWith("MIT License")).toBe(true);
  });

  test("css/crm-dashboard.css exists, stays under 120 KB, and defines a grid rule", () => {
    const cssPath = path.join(kitRoot, "css/crm-dashboard.css");
    expect(existsSync(cssPath), `expected ${cssPath} to exist`).toBe(true);
    const { size } = statSync(cssPath);
    expect(size).toBeLessThan(CRM_DASHBOARD_CSS_MAX_BYTES);
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".grid");
  });

  // Six blocks lost an image column (a lone image, or a same-wrapper image grid) during
  // vendoring; left alone, the sibling that used to share `grid-cols-2` with the image would
  // still reserve a second column and render a blank half. The vendoring script's generic
  // single-child-column collapse (not a per-id patch) must have removed every grid-cols-2 token
  // these six files carried before stripping.
  test("blocks that lost an image column no longer carry a two-column grid class", () => {
    const affected = [
      "marketing/ctas/1",
      "marketing/ctas/3",
      "marketing/ctas/4",
      "marketing/sections/1",
      "marketing/sections/2",
      "marketing/sections/4",
    ];
    for (const id of affected) {
      const blockPath = path.join(kitRoot, "blocks", `${id}.html`);
      expect(existsSync(blockPath), `expected block file to exist: ${id}`).toBe(true);
      const contents = readFileSync(blockPath, "utf8");
      expect(contents.match(/grid-cols-2/g) ?? [], `${id} still contains grid-cols-2`).toHaveLength(0);
    }
  });
});
