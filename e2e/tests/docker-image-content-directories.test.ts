import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

// The daemon resolves several content directories relative to the project root
// at runtime. Anything it reads that way has to be COPYed into the image, in
// both the build stage and the runtime stage, or the deployment loses that
// content with no error — the daemon simply finds nothing and carries on.
//
// `data/plugin-previews/manifest.json` is the case that motivated this test: it
// is committed by the bake pipeline and is what `resolvePluginPreviewsDir()`
// looks for. Without it, `loadManifest()` returns `{}` and every plugin falls
// back to the live-iframe preview path, which is exactly the GPU cost the bakes
// exist to avoid.

const dockerfile = new URL("../../deploy/Dockerfile", import.meta.url);

function stageSections(content: string): { build: string; runtime: string } {
  // The runtime stage is the last `FROM`; everything before it is the build.
  const lastFrom = content.lastIndexOf("\nFROM ");
  expect(lastFrom).toBeGreaterThan(0);
  return { build: content.slice(0, lastFrom), runtime: content.slice(lastFrom) };
}

describe("deploy/Dockerfile content directories", () => {
  it("copies every runtime-resolved content directory into both stages", async () => {
    const content = await readFile(dockerfile, "utf8");
    const { build, runtime } = stageSections(content);

    // `assets` is copied wholesale in build but selectively in runtime, so it is
    // matched loosely; the rest are whole-directory copies in both stages.
    // `design-templates` holds the Templates catalog and the agency-site
    // compiler the daemon imports at runtime (`agency-recipe.ts`).
    for (const dir of ["skills", "design-systems", "design-templates", "craft", "data"]) {
      expect(build, `build stage should COPY ${dir}`).toMatch(
        new RegExp(`^COPY ${dir} \\./${dir}$`, "m"),
      );
      expect(runtime, `runtime stage should COPY ${dir}`).toMatch(
        new RegExp(`^COPY --from=build [^\\n]*/app/${dir} \\./${dir}$`, "m"),
      );
    }

    expect(build, "retired prompt templates should not be copied into the build stage").not.toMatch(
      /^COPY prompt-templates \.\/prompt-templates$/m,
    );
    expect(runtime, "retired prompt templates should not be copied into the runtime stage").not.toMatch(
      /^COPY --from=build [^\n]*\/app\/prompt-templates \.\/prompt-templates$/m,
    );
  });

  it("ships the checked-in plugin preview manifest", async () => {
    // Narrower than the directory check above and stated separately: this is the
    // file whose absence is silent, so it is worth failing on its own terms
    // rather than only as part of a directory list.
    const content = await readFile(dockerfile, "utf8");
    const { build, runtime } = stageSections(content);

    expect(build).toMatch(/^COPY data \.\/data$/m);
    expect(runtime).toMatch(/^COPY --from=build [^\n]*\/app\/data \.\/data$/m);
  });

  it("copies only runtime sources that exist in a public checkout or the build stage creates", async () => {
    // Content shipped only in a private pack (community pets) is absent from a
    // public checkout; a runtime `COPY --from=build` of it must not make
    // `docker build` fail with "not found".
    const content = await readFile(dockerfile, "utf8");
    const { build, runtime } = stageSections(content);
    const generated = new Set(["deploy/daemon", "apps/web/out"]);
    const sources = [...runtime.matchAll(/^COPY --from=build\s+(?:--chown=\S+\s+)?\/app\/(\S+)\s+\S+$/gm)].map(
      (match) => match[1]!,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      if (generated.has(source)) continue;
      const created = build.split("\n").some((line) => /mkdir -p/.test(line) && line.includes(`/app/${source}`));
      expect(
        created || existsSync(new URL(`../../${source}`, import.meta.url)),
        `runtime stage copies /app/${source}, which is neither in the repository nor created by the build stage`,
      ).toBe(true);
    }
  });
});
