import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";

import {
  PROMOTION_CRITERIA,
  validateDesignSystemPromotionRecord,
  type DesignSystemPromotionRecord,
} from "../../../design-systems/_schema/promotion.schema.ts";
import {
  contrastRatio,
  focusRingOuterColor,
  parseColor,
  parseTokenModes,
} from "../../../scripts/lib/design-system-promotion/tokens.ts";
import {
  DESIGN_SYSTEMS_ROOT,
  evaluatePromotion,
  findDesignSystemsMissingPromotionRecord,
  findUnallowedDefaultDesignSystems,
  findUnpromotedDesignSystemReferences,
} from "../../../scripts/design-system-promotion-gate.ts";

const EXEMPLAR = path.join(DESIGN_SYSTEMS_ROOT, "neutral-product");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function copyExemplar(): string {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), "ds-promotion-")), "neutral-product");
  tempRoots.push(path.dirname(root));
  cpSync(EXEMPLAR, root, { recursive: true });
  return root;
}

function readRecord(root: string): DesignSystemPromotionRecord {
  return JSON.parse(readFileSync(path.join(root, "promotion.json"), "utf8")) as DesignSystemPromotionRecord;
}

function writeRecord(root: string, record: unknown): void {
  writeFileSync(path.join(root, "promotion.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function editFile(root: string, file: string, edit: (text: string) => string): void {
  const filePath = path.join(root, file);
  writeFileSync(filePath, edit(readFileSync(filePath, "utf8")));
}

function attestAllHumanCriteria(record: DesignSystemPromotionRecord, reviewer: string): DesignSystemPromotionRecord {
  const criteria = { ...record.criteria };
  for (const spec of PROMOTION_CRITERIA.filter((criterion) => criterion.check !== "machine")) {
    criteria[spec.id] = { result: "pass", checkedBy: reviewer, date: "2026-09-23", evidence: ["DESIGN.md"] };
  }
  return { ...record, criteria };
}

describe("promotion record schema", () => {
  test("accepts the committed exemplar record", () => {
    const result = validateDesignSystemPromotionRecord(readRecord(EXEMPLAR));
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  });

  test("rejects unknown keys, a non-gate machine checker, and na without justification", () => {
    const record = readRecord(EXEMPLAR);
    const broken = {
      ...record,
      extra: true,
      criteria: {
        ...record.criteria,
        "DSP-02": { ...record.criteria["DSP-02"], checkedBy: "someone" },
        "DSP-14": { result: "na", checkedBy: "Reviewer", date: "2026-09-23", evidence: [] },
      },
    };
    const result = validateDesignSystemPromotionRecord(broken);
    assert.equal(result.ok, false);
    const errors = result.ok ? "" : result.errors.join("\n");
    assert.match(errors, /\$\.extra is not part of the promotion record schema/);
    assert.match(errors, /DSP-02\.checkedBy must be "promotion-gate"/);
    assert.match(errors, /DSP-14\.justification must be a non-empty string/);
  });
});

describe("token modes and contrast math", () => {
  test("computes WCAG ratios, including translucent colors over a base", () => {
    assert.equal(Math.round(contrastRatio(parseColor("#000")!, parseColor("#ffffff")!) * 100) / 100, 21);
    assert.equal(Math.round(contrastRatio(parseColor("#777777")!, parseColor("#fff")!) * 100) / 100, 4.48);
    const translucent = contrastRatio(parseColor("rgba(0, 0, 0, 0.5)")!, parseColor("#ffffff")!);
    assert.ok(translucent > 3.9 && translucent < 4.1);
  });

  test("reads light, both dark blocks, reduced motion, and the outer focus-ring color", () => {
    const modes = parseTokenModes(`
      :root { --bg: #ffffff; --accent: #1e5a78; --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
      :root[data-theme="dark"] { --bg: #111111; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #111111; } }
      @media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) { --motion-fast: 0ms; } }
    `);
    assert.equal(modes.light?.get("--bg"), "#ffffff");
    assert.equal(modes.darkExplicit?.get("--bg"), "#111111");
    assert.equal(modes.darkMedia?.get("--bg"), "#111111");
    assert.equal(modes.reducedMotion?.get("--motion-fast"), "0ms");
    assert.deepEqual(focusRingOuterColor(modes.light!), { r: 0x1e, g: 0x5a, b: 0x78, a: 1 });
  });

  test("does not treat a dark selector nested under an unrelated prefix as a root match", () => {
    // `.never :root[data-theme="dark"]` and `.never :root:not(...)` cannot ever
    // match the document root, so they must not be read as the dark tokens.
    const modes = parseTokenModes(`
      :root { --bg: #ffffff; }
      .never :root[data-theme="dark"] { --bg: #000000; }
      @media (prefers-color-scheme: dark) {
        .never :root:not([data-theme="light"]) { --bg: #000000; }
      }
    `);
    assert.equal(modes.darkExplicit, null);
    assert.equal(modes.darkMedia, null);
  });

  test("still accepts the real root selector when it is one item of a selector list", () => {
    const modes = parseTokenModes(`
      :root, .compat { --bg: #ffffff; }
      .legacy, :root[data-theme="dark"] { --bg: #000000; }
    `);
    assert.equal(modes.light?.get("--bg"), "#ffffff");
    assert.equal(modes.darkExplicit?.get("--bg"), "#000000");
  });

  test("merges a later duplicate mode block in cascade order instead of ignoring it", () => {
    const modes = parseTokenModes(`
      :root { --bg: #ffffff; --fg: #111111; }
      :root { --bg: #eeeeee; }
      :root[data-theme="dark"] { --bg: #111111; --fg: #eeeeee; }
      :root[data-theme="dark"] { --fg: #111214; }
    `);
    assert.equal(modes.light?.get("--bg"), "#eeeeee");
    assert.equal(modes.light?.get("--fg"), "#111111");
    assert.equal(modes.darkExplicit?.get("--bg"), "#111111");
    assert.equal(modes.darkExplicit?.get("--fg"), "#111214");
  });

  test("clamps out-of-range rgb channels and alpha the way browsers do", () => {
    assert.deepEqual(parseColor("rgb(999, -10, 0)"), { r: 255, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor("rgba(0, 0, 0, 4)"), { r: 0, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseColor("rgba(0, 0, 0, -4)"), { r: 0, g: 0, b: 0, a: 0 });
  });

  test("merges a later duplicate @media (prefers-color-scheme: dark) block in cascade order too", () => {
    const modes = parseTokenModes(`
      :root { --bg: #ffffff; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #111111; --fg: #eeeeee; } }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #222222; } }
    `);
    assert.equal(modes.darkMedia?.get("--bg"), "#222222");
    assert.equal(modes.darkMedia?.get("--fg"), "#eeeeee");
  });

  test("a leading statement at-rule (@charset) does not glue onto the next selector", () => {
    const modes = parseTokenModes(`
      @charset "UTF-8";
      :root { --bg: #ffffff; }
      @import url("other.css");
      :root[data-theme="dark"] { --bg: #111111; }
    `);
    assert.equal(modes.light?.get("--bg"), "#ffffff");
    assert.equal(modes.darkExplicit?.get("--bg"), "#111111");
  });
});

describe("promotion gate", () => {
  test("the committed exemplar passes as a candidate", async () => {
    const result = await evaluatePromotion(EXEMPLAR);
    assert.equal(result.status, "candidate");
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.contrast.length > 0 && result.contrast.every((row) => row.pass));
  });

  test("refuses promoted without human attestations and an independent passing critique", async () => {
    const root = copyExemplar();
    writeRecord(root, { ...readRecord(root), status: "promoted" });
    const result = await evaluatePromotion(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /DSP-01 .*status promoted needs pass or justified na/.test(error)));
    assert.ok(result.errors.some((error) => /needs at least one independent critique/.test(error)));
  });

  test("a failed independent critique does not block candidate, but does not satisfy promoted either", async () => {
    const root = copyExemplar();
    writeFileSync(path.join(root, "promotion", "critiques", "2026-09-22-fake-reviewer.md"), "# fail\n", { flag: "wx" });
    const record = readRecord(root);
    const withFailedCritique = {
      ...record,
      critiques: [
        {
          id: "2026-09-22-fake-reviewer",
          reviewer: "Fake Reviewer",
          relationship: "independent",
          date: "2026-09-22",
          versionReviewed: record.version,
          verdict: "fail",
          scope: ["responsive", "focus"],
          findings: "promotion/critiques/2026-09-22-fake-reviewer.md",
        },
      ],
    };
    writeRecord(root, withFailedCritique);

    const candidateResult = await evaluatePromotion(root);
    assert.equal(candidateResult.status, "candidate");
    assert.deepEqual(candidateResult.errors, []);
    assert.equal(candidateResult.ok, true);
    // The report must say the critique failed, not that it is still missing.
    assert.equal(candidateResult.criteria.find((row) => row.check === "critique")?.computed, "fail");

    const attested = attestAllHumanCriteria(withFailedCritique as DesignSystemPromotionRecord, "Independent Reviewer");
    writeRecord(root, { ...attested, status: "promoted" });
    const promotedResult = await evaluatePromotion(root);
    assert.equal(promotedResult.ok, false);
    assert.ok(promotedResult.errors.some((error) => /needs at least one independent critique/.test(error)));
  });

  test("does not count a critique written by an author", async () => {
    const root = copyExemplar();
    const record = attestAllHumanCriteria(readRecord(root), "Independent Reviewer");
    writeRecord(root, {
      ...record,
      status: "promoted",
      critiques: [
        {
          id: "self-review",
          reviewer: record.authors[0],
          relationship: "independent",
          date: "2026-09-23",
          versionReviewed: record.version,
          verdict: "pass",
          scope: ["DSP-20"],
          findings: "DESIGN.md",
        },
      ],
    });
    const result = await evaluatePromotion(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /independent critique/.test(error)));
  });

  test("allows promoted once every criterion passes and an independent critique passes", async () => {
    const root = copyExemplar();
    const record = attestAllHumanCriteria(readRecord(root), "Independent Reviewer");
    writeRecord(root, {
      ...record,
      status: "promoted",
      critiques: [
        {
          id: "critique-1",
          reviewer: "Independent Reviewer",
          relationship: "independent",
          date: "2026-09-23",
          versionReviewed: record.version,
          verdict: "pass",
          scope: ["specimens", "accessibility"],
          findings: "DESIGN.md",
        },
      ],
    });
    const result = await evaluatePromotion(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  test("fails a candidate whose dark mode is missing and flags the stale recorded result", async () => {
    const root = copyExemplar();
    editFile(root, "tokens.css", (css) => css.replace(/\n:root\[data-theme="dark"\] \{[\s\S]*?\n\}\n/, "\n"));
    const result = await evaluatePromotion(root);
    assert.equal(result.ok, false);
    const modes = result.criteria.find((row) => row.id === "DSP-03");
    assert.equal(modes?.computed, "fail");
    assert.ok(result.errors.some((error) => /DSP-03: promotion.json records "pass" but the gate computes "fail"/.test(error)));
  });

  test("fails DSP-03 when a second duplicate dark-media block overrides --bg to white", async () => {
    const root = copyExemplar();
    editFile(root, "tokens.css", (css) =>
      css.replace(
        "@media (prefers-reduced-motion: reduce) {",
        '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) { --bg: #ffffff; }\n}\n\n@media (prefers-reduced-motion: reduce) {',
      ),
    );
    const result = await evaluatePromotion(root);
    assert.equal(result.ok, false);
    const modes = result.criteria.find((row) => row.id === "DSP-03");
    assert.equal(modes?.computed, "fail");
    assert.ok(modes?.messages.some((message) => message.includes("the data-theme block and the prefers-color-scheme block differ")));
  });

  test("a leading @charset in tokens.css does not break DSP-02/DSP-03 on the exemplar", async () => {
    const root = copyExemplar();
    editFile(root, "tokens.css", (css) => `@charset "UTF-8";\n${css}`);
    const result = await evaluatePromotion(root);
    assert.equal(result.criteria.find((row) => row.id === "DSP-02")?.computed, "pass");
    assert.equal(result.criteria.find((row) => row.id === "DSP-03")?.computed, "pass");
  });

  test("fails clean-consumer verification when a specimen uses a raw color", async () => {
    const root = copyExemplar();
    editFile(root, "preview/specimen-campaign.html", (html) => html.replace("</style>", ".rogue { color: #ff00aa; }\n</style>"));
    const result = await evaluatePromotion(root);
    const clean = result.criteria.find((row) => row.id === "DSP-21");
    assert.equal(clean?.computed, "fail");
    assert.ok(clean?.messages.some((message) => message.includes("#ff00aa")));
  });

  test("fails contrast when a text token drops below 4.5:1", async () => {
    const root = copyExemplar();
    editFile(root, "tokens.css", (css) => css.replace("--muted: #55585f;", "--muted: #9a9ca0;"));
    const result = await evaluatePromotion(root);
    const contrast = result.criteria.find((row) => row.id === "DSP-11");
    assert.equal(contrast?.computed, "fail");
    assert.ok(contrast?.messages.some((message) => message.startsWith("light: --muted on --bg")));
  });

  test("fails a visual-regression fixture that is empty or not a valid image", async () => {
    const root = copyExemplar();
    writeFileSync(path.join(root, "promotion/evidence/app-360-light.webp"), Buffer.alloc(0));
    writeFileSync(path.join(root, "promotion/evidence/app-1280-light.webp"), "not an image, just text");
    const result = await evaluatePromotion(root);
    const fixtures = result.criteria.find((row) => row.id === "DSP-16");
    assert.equal(fixtures?.computed, "fail");
    assert.ok(fixtures?.messages.some((message) => message.includes("promotion/evidence/app-360-light.webp is empty (0 bytes)")));
    assert.ok(
      fixtures?.messages.some((message) =>
        message.includes("promotion/evidence/app-1280-light.webp is not a valid WebP or PNG image"),
      ),
    );
  });

  test("fails a visual-regression fixture whose WebP header has no VP8 chunk data to read a width from", async () => {
    const root = copyExemplar();
    // 12 bytes: a complete RIFF/WEBP header with no VP8/VP8L/VP8X chunk
    // following it, so width extraction cannot read anything.
    writeFileSync(path.join(root, "promotion/evidence/app-360-light.webp"), Buffer.from("RIFF0000WEBP", "ascii"));
    const result = await evaluatePromotion(root);
    const fixtures = result.criteria.find((row) => row.id === "DSP-16");
    assert.equal(fixtures?.computed, "fail");
    assert.ok(
      fixtures?.messages.some((message) =>
        message.includes("promotion/evidence/app-360-light.webp has a webp header but its encoded width could not be read"),
      ),
    );
  });

  test("fails focus behavior when a rendered page draws focus with box-shadow instead of an outline (a higher-specificity box-shadow rule, e.g. the current-page nav item, can silently cancel a box-shadow-only focus ring)", async () => {
    const root = copyExemplar();
    editFile(root, "preview/specimen-app.html", (html) =>
      html.replace(
        ":focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
        ":focus-visible { outline: none; box-shadow: var(--focus-ring); }",
      ),
    );
    const result = await evaluatePromotion(root);
    const focus = result.criteria.find((row) => row.id === "DSP-12");
    assert.equal(focus?.computed, "fail");
    assert.ok(focus?.messages.some((message) => message.includes("preview/specimen-app.html has no :focus-visible rule")));
  });

  test("fails focus behavior when the ring color drops below 3:1 against --surface-warm", async () => {
    const root = copyExemplar();
    editFile(root, "tokens.css", (css) => css.replace("--surface-warm: #f0f0ee;", "--surface-warm: #1e5a78;"));
    const result = await evaluatePromotion(root);
    const focus = result.criteria.find((row) => row.id === "DSP-12");
    assert.equal(focus?.computed, "fail");
    assert.ok(focus?.messages.some((message) => message.includes("--surface-warm")));
  });

  test("fails a visual-regression fixture whose encoded width does not match its declared width", async () => {
    const root = copyExemplar();
    const wideFixture = readFileSync(path.join(root, "promotion/evidence/app-1280-light.webp"));
    writeFileSync(path.join(root, "promotion/evidence/app-360-light.webp"), wideFixture);
    const result = await evaluatePromotion(root);
    const fixtures = result.criteria.find((row) => row.id === "DSP-16");
    assert.equal(fixtures?.computed, "fail");
    assert.ok(
      fixtures?.messages.some((message) =>
        message.includes("promotion/evidence/app-360-light.webp declares width 360px but is encoded at 1280px"),
      ),
    );
  });
});

describe("promotion record coverage (a deleted promotion.json must not silently drop enforcement)", () => {
  test("flags a design system that has no promotion.json", async () => {
    const root = tempDir("ds-coverage-");
    mkdirSync(path.join(root, "widget-x"));
    cpSync(EXEMPLAR, path.join(root, "neutral-product"), { recursive: true });
    const missing = await findDesignSystemsMissingPromotionRecord(root);
    assert.deepEqual(missing, ["widget-x"]);
  });

  test("does not flag a system that carries a record", async () => {
    const root = tempDir("ds-coverage-");
    cpSync(EXEMPLAR, path.join(root, "neutral-product"), { recursive: true });
    const missing = await findDesignSystemsMissingPromotionRecord(root);
    assert.deepEqual(missing, []);
  });

  test("the real design-systems/ tree has no system missing a promotion.json", async () => {
    assert.deepEqual(await findDesignSystemsMissingPromotionRecord(), []);
  });
});

describe("no unpromoted design-system references in bundled examples/templates", () => {
  test("the real design-templates/ and plugins/_official/examples/ trees reference no design system that is not promoted", async () => {
    assert.deepEqual(await findUnpromotedDesignSystemReferences(), []);
  });

  test("flags a bundled example that references a candidate design system, and allows one that references a promoted system", async () => {
    const templatesRoot = tempDir("ds-templates-");
    const examplesRoot = tempDir("ds-examples-");
    const designSystemsRoot = tempDir("ds-systems-");

    mkdirSync(path.join(designSystemsRoot, "candidate-system"));
    writeFileSync(path.join(designSystemsRoot, "candidate-system", "promotion.json"), JSON.stringify({ status: "candidate" }));
    mkdirSync(path.join(designSystemsRoot, "promoted-system"));
    writeFileSync(path.join(designSystemsRoot, "promoted-system", "promotion.json"), JSON.stringify({ status: "promoted" }));

    mkdirSync(path.join(examplesRoot, "example-a"), { recursive: true });
    writeFileSync(
      path.join(examplesRoot, "example-a", "open-design.json"),
      JSON.stringify({ od: { context: { designSystem: { ref: "candidate-system", primary: true } } } }),
    );
    mkdirSync(path.join(templatesRoot, "template-b"), { recursive: true });
    writeFileSync(
      path.join(templatesRoot, "template-b", "open-design.json"),
      JSON.stringify({ od: { context: { designSystem: { ref: "promoted-system", primary: true } } } }),
    );

    const violations = await findUnpromotedDesignSystemReferences([templatesRoot, examplesRoot], designSystemsRoot);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.designSystemId, "candidate-system");
    assert.equal(violations[0]?.status, "candidate");
  });

  test("reports a referenced id that names no design system at all", async () => {
    const examplesRoot = tempDir("ds-examples-");
    const designSystemsRoot = tempDir("ds-systems-");
    mkdirSync(path.join(examplesRoot, "example-a"), { recursive: true });
    writeFileSync(
      path.join(examplesRoot, "example-a", "open-design.json"),
      JSON.stringify({ od: { context: { designSystem: { ref: "does-not-exist" } } } }),
    );
    const violations = await findUnpromotedDesignSystemReferences([examplesRoot], designSystemsRoot);
    assert.deepEqual(violations, [
      { file: violations[0]?.file, designSystemId: "does-not-exist", status: null },
    ]);
  });
});

describe("default design system in code", () => {
  function writeStatus(root: string, id: string, status: string): void {
    mkdirSync(path.join(root, id));
    writeFileSync(path.join(root, id, "promotion.json"), JSON.stringify({ status }));
  }

  test("the real default design system is allowed", async () => {
    assert.deepEqual(await findUnallowedDefaultDesignSystems(), []);
  });

  test("allows a candidate default while no system is promoted", async () => {
    const root = tempDir("ds-defaults-");
    writeStatus(root, "candidate-system", "candidate");
    assert.deepEqual(await findUnallowedDefaultDesignSystems(["candidate-system"], root), []);
  });

  test("fails a candidate default once any system is promoted", async () => {
    const root = tempDir("ds-defaults-");
    writeStatus(root, "candidate-system", "candidate");
    writeStatus(root, "promoted-system", "promoted");
    assert.deepEqual(await findUnallowedDefaultDesignSystems(["candidate-system"], root), [
      { designSystemId: "candidate-system", status: "candidate" },
    ]);
    assert.deepEqual(await findUnallowedDefaultDesignSystems(["promoted-system"], root), []);
  });

  test("fails a draft default and a default that names no design system", async () => {
    const root = tempDir("ds-defaults-");
    writeStatus(root, "draft-system", "draft");
    assert.deepEqual(await findUnallowedDefaultDesignSystems(["draft-system", "vercel"], root), [
      { designSystemId: "draft-system", status: "draft" },
      { designSystemId: "vercel", status: null },
    ]);
  });
});
