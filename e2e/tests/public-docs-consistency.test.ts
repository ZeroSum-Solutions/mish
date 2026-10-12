import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Contributor and setup docs are the first thing an outside developer copies
// from. They must point at what this public repository actually ships: its own
// clone URL, the families its fast lane can build, and files that exist.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SETUP_DOCS = [
  "QUICKSTART.md",
  "CONTRIBUTING.md",
  "docs/install-guide.md",
  "docs/deployment/docker.md",
  "docs/deployment/cloud/aliyun.md",
  "docs/deployment/workspace-team-rollout.md",
  "docs/wsl-setup.md",
  "docs/skills-contributing.md",
  "docs/windows-troubleshooting.md",
  "docs/whats-new.md",
  "docs/notebooklm.md",
];

describe("public setup docs", () => {
  it("name the public repository, not the private working repository", () => {
    for (const doc of SETUP_DOCS) {
      expect(read(doc), `${doc} names the private working repository`).not.toMatch(/Mishh-Mashh-2/);
    }
    expect(read("CONTRIBUTING.md")).not.toMatch(/private repository/i);
  });

  it("embed only images that exist", () => {
    const doc = "docs/deployment/docker.md";
    for (const [, target] of read(doc).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target!)) continue;
      const resolved = path.resolve(path.dirname(path.join(repoRoot, doc)), target!);
      expect(existsSync(resolved), `${doc} embeds missing image ${target}`).toBe(true);
    }
  });
});

describe("docs/agency-site.md", () => {
  const doc = read("docs/agency-site.md");

  it("lists exactly the families the fast-lane registry ships", () => {
    const registry = JSON.parse(read("packages/agency-fast-lane/src/atlas/family-registry.json")) as {
      families: Array<{ family: string }>;
    };
    const section = doc.split(/^### Families$/m)[1]?.split(/^#{2,3} /m)[0] ?? "";
    const documented = [...section.matchAll(/^\| ([a-z][a-z0-9, -]*) \|/gm)]
      .flatMap((match) => match[1]!.split(","))
      .map((name) => name.trim())
      .filter((name) => name !== "family");
    expect(documented.sort()).toEqual(registry.families.map((entry) => entry.family).sort());
  });

  it("does not direct users to agency studies that are not in this repository", () => {
    for (const match of doc.matchAll(/@(agency-[a-z0-9-]+)/g)) {
      expect(existsSync(path.join(repoRoot, "skills", match[1]!)), `docs/agency-site.md offers @${match[1]}`).toBe(true);
    }
  });
});
