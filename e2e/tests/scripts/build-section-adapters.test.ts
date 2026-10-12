import assert from "node:assert/strict";

import { test } from "vitest";

import {
  assertClean,
  buildSectionAdapters,
  SPECS,
  type Spec,
} from "../../../scripts/build-section-adapters.ts";

// BLOCK 2 (delta audit:
// <private-notes>/mishh-genui-production/audits/sections-B-real-delta-deepseek.md,
// sections-B-c-code-deepseek.md, sections-B-c-tests-deepseek.md):
// the review question requires `build-section-adapters.ts --check` to REJECT an unmapped literal
// colour utility, an arbitrary-value utility, an inline <script>, and an external asset reference
// — this file proves each one actually fires the gate, with a named reason, rather than the
// rejection path being merely asserted correct.

// A real, already-vendored HyperUI block: the "pinned source" check (which runs before the
// generated-output check this file targets) must pass so each fixture actually exercises the
// output-side gate, not the unrelated missing-source path.
const REAL_BLOCK_FILE = "blocks/marketing/ctas/1.html";

function adversarialSpec(slug: string, markup: string, css = ""): Spec {
  return {
    slug,
    blockId: "marketing/ctas/1",
    blockFile: REAL_BLOCK_FILE,
    version: "0.0.0-fixture",
    roles: [],
    text: [],
    markup: () => markup,
    css,
  };
}

function rejects(spec: Spec, reasonPattern: RegExp): void {
  const report = buildSectionAdapters({ check: true, specs: [spec] });
  assert.equal(report.failed, true, `${spec.slug}: expected the gate to reject this fixture`);
  assert.equal(report.written.length, 0, `${spec.slug}: a rejected fixture must never be counted as written`);
  assert.ok(
    report.errors.some((error) => reasonPattern.test(error)),
    `${spec.slug}: expected an error matching ${reasonPattern}, got: ${report.errors.join(" | ")}`,
  );
}

test("build-section-adapters --check: rejects an unmapped literal Tailwind color utility class", () => {
  rejects(
    adversarialSpec("fixture-literal-color-utility", '<div class="bg-emerald-600 text-white">Contact us</div>'),
    /unmapped literal Tailwind color utility class/,
  );
});

test("build-section-adapters --check: rejects an arbitrary-value utility ([...])", () => {
  rejects(
    adversarialSpec("fixture-arbitrary-utility", '<div class="top-[117px]">Contact us</div>'),
    /arbitrary-value utility/,
  );
});

test("build-section-adapters --check: rejects an inline <script>", () => {
  rejects(
    adversarialSpec("fixture-inline-script", "<script>alert(document.cookie)</script>"),
    /<script> element/,
  );
});

test("build-section-adapters --check: rejects an external asset URL", () => {
  rejects(
    adversarialSpec("fixture-external-asset", '<img src="https://evil.example/asset.png" data-od-asset="hero">'),
    /external URL/,
  );
});

test("build-section-adapters --check: a clean fixture fails ONLY for the expected out-of-date reason, never an adversarial one (control case)", () => {
  const report = buildSectionAdapters({
    check: true,
    specs: [adversarialSpec("fixture-clean", '<div class="od-cta__heading">Contact us</div>')],
  });
  // This fixture's slug has no corresponding checked-in output file, so it is reported as
  // "out of date" (nothing to compare against). Delta re-audit (tests packet #4): asserting only
  // that no ADVERSARIAL reason fires is a tautology-adjacent weak assertion — a regression that
  // made `assertClean` reject everything would still pass it, since "out of date" would also fire
  // for the wrong reason. Assert the error set is EXACTLY the expected one instead.
  assert.equal(report.failed, true);
  assert.equal(report.errors.length, 1, `expected exactly one error, got: ${report.errors.join(" | ")}`);
  assert.match(report.errors[0]!, /out of date — run without --check to regenerate/);
});

// The control case above proves a clean fixture fails for the RIGHT reason when it has no
// checked-in output to compare against. It does not prove clean output actually CLEARS the gate.
// This does: the real, unmodified SPECS checked against their real checked-in files.
test("build-section-adapters --check: the real, unmodified specs pass with zero errors", () => {
  const report = buildSectionAdapters({ check: true, specs: SPECS });
  assert.deepEqual(report.errors, []);
  assert.equal(report.failed, false);
  assert.equal(report.written.length, SPECS.length);
});

// `assertClean` itself is only ever run against the isolated `html`/`css` fragments `generate()`
// builds, never a whole generated .ts file (which legitimately contains `[...]` TypeScript array
// literal syntax, e.g. `text: [{...}, {...}]`, that the arbitrary-utility bracket pattern would
// otherwise misfire on). Delta re-audit (tests packet #5): test the pattern against an ISOLATED
// fragment directly, through `assertClean` itself, rather than scanning a whole checked-in file
// with a bare regex (a weaker proxy that would miss a color the fragment-level gate catches only
// because it spans the html/css boundary).
test("assertClean: rejects a fragment containing a literal Tailwind color utility class", () => {
  assert.throws(
    () => assertClean("fragment", '<div class="bg-emerald-600 text-white">Contact us</div>'),
    /unmapped literal Tailwind color utility class/,
  );
});

test("assertClean: a clean fragment (the same shape the three shipped adapters actually emit) does not throw", () => {
  assert.doesNotThrow(() => assertClean("fragment", '<div class="od-cta__heading">Contact us</div>'));
});
