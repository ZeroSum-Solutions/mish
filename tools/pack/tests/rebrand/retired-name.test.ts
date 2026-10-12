// The release/packaging sources must not carry the retired upstream product name (only LICENSE and
// NOTICE may). The name is assembled from parts so this file does not itself contain it, and the
// pattern spans comment line breaks, where a token-by-token rename misses the phrase.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const ROOTS = ["tools/pack/src", "tools/release/src", "tools/serve/src"];
// Optional comment leader (`*`, `//`, `#`) between the two words when they wrap across lines.
const RETIRED_NAME = new RegExp(`${"Open"}(?:[ _.-]?|\\s*\\n\\s*(?:\\*|//|#)?\\s*)${"Design"}`, "i");
const RETIRED_VENDOR = new RegExp(["ne", "xu"].join(""), "i");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(?:[cm]?[jt]s|json|sh|cmd|ps1|ya?ml|md|plist|template)$/.test(entry.name)) out.push(path);
  }
  return out;
}

it("keeps the retired upstream name out of release and packaging sources, even across line breaks", async () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(join(workspaceRoot, root))) {
      const text = await readFile(file, "utf8");
      if (RETIRED_NAME.test(text) || RETIRED_VENDOR.test(text)) offenders.push(relative(workspaceRoot, file));
    }
  }
  expect(offenders).toEqual([]);
});

it("matches the wrapped spelling a token rename leaves behind", () => {
  expect(RETIRED_NAME.test(`only official ${"Open"}\n   * ${"Design"} builds`)).toBe(true);
  expect(RETIRED_NAME.test("only official Mish builds")).toBe(false);
});
