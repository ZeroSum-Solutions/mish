/* ─────────────────────────────────────────────────────────────────────────
 * scripts/lib/design-system-promotion/checks.ts
 *
 * Machine checks for the design-system promotion gate. Each check maps to
 * one machine criterion in design-systems/_schema/promotion.schema.ts and
 * docs/design-systems/QUALITY-STANDARD.md. Checks read files through the
 * `PackageFiles` snapshot so tests can run them against temp folders.
 * ─────────────────────────────────────────────────────────────────── */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DesignSystemProjectManifest } from "../../../design-systems/_schema/manifest.schema.ts";
import {
  CONTRAST_MINIMUMS,
  FIXTURE_THEMES,
  FIXTURE_WIDTHS,
  REQUIRED_CONTRAST_PAIRS,
  SPECIMEN_KINDS,
  type ContrastPair,
  type DesignSystemPromotionRecord,
} from "../../../design-systems/_schema/promotion.schema.ts";
import { getAllSchemaNames, isAllowedExtension } from "../../../packages/contracts/src/design-systems/token-schema.ts";
import {
  allDeclaredTokenNames,
  contrastRatio,
  focusRingOuterColor,
  overlay,
  parseColor,
  parseTokenModes,
  resolveTokenColor,
  type TokenMap,
} from "./tokens.ts";

export type CheckOutcome = { readonly pass: boolean; readonly messages: readonly string[] };

export type ContrastRow = {
  readonly mode: "light" | "dark";
  readonly fg: string;
  readonly bg: string;
  readonly kind: string;
  readonly ratio: number | null;
  readonly minimum: number;
  readonly pass: boolean;
  readonly note?: string;
};

export type MachineReport = {
  readonly outcomes: ReadonlyMap<string, CheckOutcome>;
  readonly contrast: readonly ContrastRow[];
};

/** Files the checks need, loaded once. Missing files are `null`. */
export type PackageFiles = {
  readonly root: string;
  readonly manifest: DesignSystemProjectManifest;
  readonly designMd: string | null;
  readonly usageMd: string | null;
  readonly tokensCss: string | null;
  readonly componentsHtml: string | null;
  readonly pages: ReadonlyMap<string, string | null>;
};

export const MAX_FIXTURE_BYTES = 300 * 1024;

/** DESIGN.md must carry an H2 whose text matches each topic. */
export const REQUIRED_DESIGN_TOPICS: ReadonlyArray<readonly [string, RegExp]> = [
  ["color", /colou?r/i],
  ["typography", /typograph/i],
  ["spacing", /spacing/i],
  ["layout", /layout/i],
  ["iconography", /icon/i],
  ["imagery", /imagery|image/i],
  ["motion", /motion/i],
  ["content voice", /content|voice/i],
  ["components", /component/i],
  ["states", /state/i],
  ["accessibility", /accessib/i],
  ["responsive", /responsive/i],
];

/** components.html must show these structures and states. */
export const REQUIRED_COMPONENT_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["primitives section", /id=["']primitives["']/],
  ["components section", /id=["']components["']/],
  ["patterns section", /id=["']patterns["']/],
  ["hover state", /:hover\b/],
  ["focus-visible state", /:focus-visible\b/],
  ["disabled state", /:disabled\b|\[aria-disabled=["']true["']\]/],
  ["error state", /\[aria-invalid=["']true["']\]/],
  ["loading state", /\[aria-busy=["']true["']\]/],
  ["empty state", /class=["'][^"']*\bempty-state\b/],
];

const PLACEHOLDER_TEXT = /lorem ipsum|dolor sit amet|placeholder text|sample text here/i;
const PLACEHOLDER_MARKER = /\b(?:TODO|TBD|XXX)\b/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?<![\w-])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|(?<![\w-])(?:white|black)(?![\w-])/;

export async function loadPackageFiles(
  root: string,
  manifest: DesignSystemProjectManifest,
  record: DesignSystemPromotionRecord,
): Promise<PackageFiles> {
  const pagePaths = new Set<string>([
    ...Object.values(record.specimens),
    ...(manifest.preview?.pages ?? []).map((page) => page.path),
  ]);
  const pages = new Map<string, string | null>();
  for (const pagePath of pagePaths) pages.set(pagePath, await readText(path.join(root, pagePath)));
  return {
    root,
    manifest,
    designMd: await readText(path.join(root, manifest.files.design)),
    usageMd: manifest.usage === undefined ? null : await readText(path.join(root, manifest.usage)),
    tokensCss: await readText(path.join(root, manifest.files.tokens)),
    componentsHtml: manifest.files.components === undefined ? null : await readText(path.join(root, manifest.files.components)),
    pages,
  };
}

export async function runMachineChecks(
  files: PackageFiles,
  record: DesignSystemPromotionRecord,
  packageQualityViolations: readonly string[],
): Promise<MachineReport> {
  const outcomes = new Map<string, CheckOutcome>();
  const modes = files.tokensCss == null ? null : parseTokenModes(files.tokensCss);
  const light = modes?.light ?? null;
  const dark = light != null && modes?.darkExplicit != null ? overlay(light, modes.darkExplicit) : null;
  const contrast = contrastRows(record, light, dark);

  outcomes.set("DSP-02", checkTokens(files, light));
  outcomes.set("DSP-03", checkModes(modes));
  outcomes.set("DSP-04", checkDesignTopics(files.designMd));
  outcomes.set("DSP-05", checkComponentCoverage(files.componentsHtml));
  outcomes.set("DSP-06", checkResponsive(files, record));
  outcomes.set("DSP-08", checkReducedMotion(files, modes?.reducedMotion ?? null));
  outcomes.set("DSP-09", checkRealisticContent(files, record));
  outcomes.set("DSP-11", checkContrast(contrast, light, dark));
  outcomes.set("DSP-12", checkFocus(files, record, light, dark));
  outcomes.set("DSP-15", checkSpecimens(files, record));
  outcomes.set("DSP-16", await checkFixtures(files, record));
  outcomes.set("DSP-17", outcome(packageQualityViolations.map((violation) => `package contract: ${violation}`)));
  outcomes.set("DSP-18", checkDocumentation(files));
  outcomes.set("DSP-19", checkLifecycleRecord(record));
  outcomes.set("DSP-21", checkCleanConsumer(files, record));
  return { outcomes, contrast };
}

function outcome(messages: readonly string[]): CheckOutcome {
  return { pass: messages.length === 0, messages };
}

function specimenPages(files: PackageFiles, record: DesignSystemPromotionRecord): Array<[string, string | null]> {
  return SPECIMEN_KINDS.map((kind) => [record.specimens[kind], files.pages.get(record.specimens[kind]) ?? null]);
}

/** Specimens plus components.html: every page a consumer would render. */
function renderedPages(files: PackageFiles, record: DesignSystemPromotionRecord): Array<[string, string | null]> {
  return [...specimenPages(files, record), [files.manifest.files.components ?? "components.html", files.componentsHtml]];
}

function checkTokens(files: PackageFiles, light: TokenMap | null): CheckOutcome {
  if (light == null) return outcome(["tokens.css has no unscoped :root block"]);
  const messages: string[] = [];
  for (const name of getAllSchemaNames()) {
    if (!light.has(name)) messages.push(`${name} is missing from :root`);
  }
  const schema = new Set(getAllSchemaNames());
  for (const name of light.keys()) {
    if (!schema.has(name) && !isAllowedExtension(files.manifest.id, name)) {
      messages.push(`${name} is neither a schema token nor an allowed extension`);
    }
  }
  return outcome(messages);
}

function checkModes(modes: ReturnType<typeof parseTokenModes> | null): CheckOutcome {
  if (modes?.light == null) return outcome(["light mode: no unscoped :root block"]);
  const messages: string[] = [];
  if (modes.darkExplicit == null) messages.push('dark mode: no :root[data-theme="dark"] block');
  if (modes.darkMedia == null) {
    messages.push('dark mode: no @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) } block');
  }
  if (modes.darkExplicit != null && modes.darkMedia != null) {
    const a = [...modes.darkExplicit].sort().join("\n");
    const b = [...modes.darkMedia].sort().join("\n");
    if (a !== b) messages.push("dark mode: the data-theme block and the prefers-color-scheme block differ");
  }
  if (modes.darkExplicit != null) {
    for (const [name, value] of modes.light) {
      if (parseColor(value) != null && !modes.darkExplicit.has(name)) {
        messages.push(`dark mode: color token ${name} is not redeclared`);
      }
    }
  }
  return outcome(messages);
}

function h2Headings(markdown: string): string[] {
  return markdown.split(/\r?\n/).filter((line) => /^##\s+\S/.test(line)).map((line) => line.replace(/^##\s+/, ""));
}

function checkDesignTopics(designMd: string | null): CheckOutcome {
  if (designMd == null) return outcome(["DESIGN.md is missing"]);
  const headings = h2Headings(designMd);
  return outcome(
    REQUIRED_DESIGN_TOPICS.filter(([, pattern]) => !headings.some((heading) => pattern.test(heading))).map(
      ([topic]) => `DESIGN.md has no H2 section for ${topic}`,
    ),
  );
}

function checkComponentCoverage(componentsHtml: string | null): CheckOutcome {
  if (componentsHtml == null) return outcome(["components.html is missing"]);
  return outcome(
    REQUIRED_COMPONENT_MARKERS.filter(([, pattern]) => !pattern.test(componentsHtml)).map(
      ([label]) => `components.html does not show the ${label}`,
    ),
  );
}

function checkResponsive(files: PackageFiles, record: DesignSystemPromotionRecord): CheckOutcome {
  const messages: string[] = [];
  for (const [pagePath, html] of renderedPages(files, record)) {
    if (html == null) continue;
    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) messages.push(`${pagePath} has no viewport meta tag`);
    if (!/@media[^{]*\((?:max|min)-width\s*:/i.test(html)) messages.push(`${pagePath} has no width media query`);
    const covered = new Set(record.visualRegression.fixtures.filter((f) => f.page === pagePath).map((f) => f.width));
    for (const width of FIXTURE_WIDTHS) {
      if (!covered.has(width)) messages.push(`${pagePath} has no visual fixture at ${width}px`);
    }
  }
  return outcome(messages);
}

function isZeroDuration(value: string | undefined): boolean {
  return value !== undefined && /^0(?:m?s)?$/.test(value.trim());
}

function checkReducedMotion(files: PackageFiles, reduced: TokenMap | null): CheckOutcome {
  const messages: string[] = [];
  if (reduced == null) {
    messages.push("tokens.css has no @media (prefers-reduced-motion: reduce) block");
  } else {
    for (const name of ["--motion-fast", "--motion-base"]) {
      if (!isZeroDuration(reduced.get(name))) messages.push(`tokens.css reduced-motion block does not set ${name} to 0ms`);
    }
  }
  for (const [pagePath, html] of files.pages) {
    if (html != null && /@keyframes/.test(html) && !/prefers-reduced-motion\s*:\s*reduce/.test(html)) {
      messages.push(`${pagePath} animates with @keyframes but has no reduced-motion rule`);
    }
  }
  const components = files.componentsHtml;
  if (components != null && /@keyframes/.test(components) && !/prefers-reduced-motion\s*:\s*reduce/.test(components)) {
    messages.push("components.html animates with @keyframes but has no reduced-motion rule");
  }
  return outcome(messages);
}

function visibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
}

function checkRealisticContent(files: PackageFiles, record: DesignSystemPromotionRecord): CheckOutcome {
  const messages: string[] = [];
  for (const [pagePath, html] of renderedPages(files, record)) {
    if (html == null) continue;
    if (!/<html[^>]*\blang=["'][a-zA-Z-]+["']/i.test(html)) messages.push(`${pagePath} has no <html lang>`);
    const text = visibleText(html);
    const match = PLACEHOLDER_TEXT.exec(text) ?? PLACEHOLDER_MARKER.exec(text);
    if (match != null) messages.push(`${pagePath} contains placeholder text "${match[0]}"`);
  }
  return outcome(messages);
}

function contrastRows(record: DesignSystemPromotionRecord, light: TokenMap | null, dark: TokenMap | null): ContrastRow[] {
  const seen = new Set<string>();
  const pairs: ContrastPair[] = [];
  for (const pair of [...REQUIRED_CONTRAST_PAIRS, ...record.contrast.pairs]) {
    const key = `${pair.fg}|${pair.bg}|${pair.kind}`;
    if (!seen.has(key)) pairs.push(pair);
    seen.add(key);
  }
  const rows: ContrastRow[] = [];
  for (const [mode, tokens] of [["light", light], ["dark", dark]] as const) {
    if (tokens == null) continue;
    const base = resolveTokenColor("--bg", tokens);
    for (const pair of pairs) {
      const minimum = CONTRAST_MINIMUMS[pair.kind];
      const fg = resolveTokenColor(pair.fg, tokens);
      const bg = resolveTokenColor(pair.bg, tokens);
      if (typeof fg === "string" || typeof bg === "string") {
        rows.push({ mode, ...pair, ratio: null, minimum, pass: false, note: typeof fg === "string" ? fg : String(bg) });
        continue;
      }
      const ratio = contrastRatio(fg, bg, typeof base === "string" ? undefined : base);
      rows.push({ mode, ...pair, ratio: Math.round(ratio * 100) / 100, minimum, pass: ratio >= minimum });
    }
  }
  return rows;
}

function checkContrast(rows: readonly ContrastRow[], light: TokenMap | null, dark: TokenMap | null): CheckOutcome {
  const messages: string[] = [];
  if (light == null) messages.push("light mode tokens are missing; contrast was not computed");
  if (dark == null) messages.push("dark mode tokens are missing; contrast was not computed");
  for (const row of rows.filter((candidate) => !candidate.pass)) {
    messages.push(
      `${row.mode}: ${row.fg} on ${row.bg} (${row.kind}) ${row.ratio == null ? `not computable: ${row.note}` : `${row.ratio}:1 < ${row.minimum}:1`}`,
    );
  }
  return outcome(messages);
}

function checkFocus(
  files: PackageFiles,
  record: DesignSystemPromotionRecord,
  light: TokenMap | null,
  dark: TokenMap | null,
): CheckOutcome {
  const messages: string[] = [];
  for (const [mode, tokens] of [["light", light], ["dark", dark]] as const) {
    if (tokens == null) {
      messages.push(`${mode}: tokens are missing; focus ring was not checked`);
      continue;
    }
    const ring = focusRingOuterColor(tokens);
    if (typeof ring === "string") {
      messages.push(`${mode}: ${ring}`);
      continue;
    }
    // `--surface-warm` is a real background focusable elements sit on (e.g. a
    // sunken sidebar) — not just `--bg`/`--surface` — so the ring must clear
    // 3:1 there too.
    for (const surface of ["--bg", "--surface", "--surface-warm"]) {
      const bg = resolveTokenColor(surface, tokens);
      if (typeof bg === "string") {
        messages.push(`${mode}: ${bg}`);
        continue;
      }
      const ratio = contrastRatio(ring, bg);
      if (ratio < CONTRAST_MINIMUMS.ui) {
        messages.push(`${mode}: focus ring outer color on ${surface} is ${ratio.toFixed(2)}:1 < 3:1`);
      }
    }
  }
  for (const [pagePath, html] of renderedPages(files, record)) {
    if (html == null) continue;
    // Focus must be drawn with `outline`, never `box-shadow`: a selected/
    // current-item indicator (e.g. `[aria-current="page"]`) commonly sets its
    // own `box-shadow` at higher specificity, which silently cancels a
    // box-shadow-only focus ring on that same element. `outline` is a
    // different property, so nothing else on these pages can override it.
    if (!/:focus-visible[^{]*\{[^}]*outline\s*:\s*[^;]*var\(--accent\)/.test(html)) {
      messages.push(`${pagePath} has no :focus-visible rule that draws an outline with var(--accent)`);
    }
  }
  return outcome(messages);
}

function checkSpecimens(files: PackageFiles, record: DesignSystemPromotionRecord): CheckOutcome {
  const messages: string[] = [];
  const declared = new Set((files.manifest.preview?.pages ?? []).map((page) => page.path));
  for (const kind of SPECIMEN_KINDS) {
    const pagePath = record.specimens[kind];
    const html = files.pages.get(pagePath) ?? null;
    if (html == null) {
      messages.push(`${kind} specimen ${pagePath} does not exist`);
      continue;
    }
    if (!declared.has(pagePath)) messages.push(`${kind} specimen ${pagePath} is not declared in manifest.preview.pages`);
    if (!/<main\b/i.test(html)) messages.push(`${kind} specimen ${pagePath} has no <main> landmark`);
    if (!/<title>[^<]+<\/title>/i.test(html)) messages.push(`${kind} specimen ${pagePath} has no <title>`);
  }
  return outcome(messages);
}

type FixtureImageFormat = "webp" | "png";

/** `RIFF....WEBP` or the 8-byte PNG signature. */
function detectFixtureImageFormat(buffer: Buffer): FixtureImageFormat | null {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return "png";
  return null;
}

/** Encoded pixel width from a WebP (VP8/VP8L/VP8X) or PNG (IHDR) header. `null` when it cannot be read cheaply. */
function fixtureImageWidth(buffer: Buffer, format: FixtureImageFormat): number | null {
  if (format === "png") {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    return buffer.readUInt32BE(16);
  }
  const fourcc = buffer.toString("ascii", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy: 3-byte frame tag, then the 0x9d 0x01 0x2a start code, then a
    // little-endian 14-bit width (top 2 bits are a scale factor).
    if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return buffer.readUInt16LE(26) & 0x3fff;
  }
  if (fourcc === "VP8L") {
    // Lossless: a 0x2f signature byte, then a packed little-endian bitstream
    // whose low 14 bits are (width - 1).
    if (buffer.length < 25 || buffer[20] !== 0x2f) return null;
    return (buffer.readUInt32LE(21) & 0x3fff) + 1;
  }
  if (fourcc === "VP8X") {
    // Extended: 1 flags byte, 3 reserved bytes, then a 24-bit little-endian
    // (canvas width - 1).
    if (buffer.length < 30) return null;
    return (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16)) + 1;
  }
  return null;
}

async function checkFixtures(files: PackageFiles, record: DesignSystemPromotionRecord): Promise<CheckOutcome> {
  const messages: string[] = [];
  for (const fixture of record.visualRegression.fixtures) {
    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(files.root, fixture.path));
    } catch {
      messages.push(`${fixture.path} does not exist`);
      continue;
    }
    if (buffer.length === 0) {
      messages.push(`${fixture.path} is empty (0 bytes)`);
      continue;
    }
    if (buffer.length > MAX_FIXTURE_BYTES) messages.push(`${fixture.path} is ${Math.round(buffer.length / 1024)} KB > 300 KB`);
    const format = detectFixtureImageFormat(buffer);
    if (format == null) {
      messages.push(`${fixture.path} is not a valid WebP or PNG image`);
      continue;
    }
    const width = fixtureImageWidth(buffer, format);
    if (width == null) {
      messages.push(`${fixture.path} has a ${format} header but its encoded width could not be read`);
    } else if (width !== fixture.width) {
      messages.push(`${fixture.path} declares width ${fixture.width}px but is encoded at ${width}px`);
    }
  }
  for (const [pagePath] of renderedPages(files, record)) {
    for (const width of FIXTURE_WIDTHS) {
      for (const theme of FIXTURE_THEMES) {
        const found = record.visualRegression.fixtures.some(
          (fixture) => fixture.page === pagePath && fixture.width === width && fixture.theme === theme,
        );
        if (!found) messages.push(`no visual fixture for ${pagePath} at ${width}px in ${theme} mode`);
      }
    }
  }
  return outcome(messages);
}

function checkDocumentation(files: PackageFiles): CheckOutcome {
  const messages: string[] = [];
  if (files.designMd == null) {
    messages.push("DESIGN.md is missing");
  } else {
    if (!/^>\s*Category:\s*\S/m.test(files.designMd)) messages.push("DESIGN.md has no `> Category:` line");
    if (h2Headings(files.designMd).length < 7) messages.push("DESIGN.md has fewer than seven H2 sections");
  }
  if (files.usageMd == null) {
    messages.push("USAGE.md is missing or not declared");
  } else {
    const headings = new Set(h2Headings(files.usageMd).map((heading) => heading.trim()));
    for (const heading of ["Read Order", "Design Highlights", "Do", "Avoid"]) {
      if (!headings.has(heading)) messages.push(`USAGE.md has no "## ${heading}" section`);
    }
  }
  return outcome(messages);
}

function checkLifecycleRecord(record: DesignSystemPromotionRecord): CheckOutcome {
  const messages: string[] = [];
  if (!record.changelog.some((entry) => entry.version === record.version)) {
    messages.push(`changelog has no entry for the current version ${record.version}`);
  }
  if (record.status === "deprecated" && record.deprecation.deprecatedAt === undefined) {
    messages.push("status is deprecated but deprecation.deprecatedAt is not set");
  }
  return outcome(messages);
}

function styleText(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? "");
  const inline = [...html.matchAll(/\sstyle=["']([^"']*)["']/gi)].map((match) => match[1] ?? "");
  return [...blocks, ...inline].join("\n");
}

function checkCleanConsumer(files: PackageFiles, record: DesignSystemPromotionRecord): CheckOutcome {
  const messages: string[] = [];
  const declared = files.tokensCss == null ? new Set<string>() : allDeclaredTokenNames(files.tokensCss);
  for (const [pagePath, html] of specimenPages(files, record)) {
    if (html == null) continue;
    const tokensHref = path.posix.relative(path.posix.dirname(pagePath), files.manifest.files.tokens);
    const stylesheets = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)].map((match) => match[0]);
    if (stylesheets.length !== 1 || !stylesheets[0]!.includes(`href="${tokensHref}"`)) {
      messages.push(`${pagePath} must link exactly one stylesheet: ${tokensHref}`);
    }
    if (/\b(?:src|href)=["']https?:|url\(\s*["']?https?:|@import/i.test(html)) {
      messages.push(`${pagePath} loads a remote resource or uses @import`);
    }
    const css = styleText(html).replace(/\/\*[\s\S]*?\*\//g, "");
    const literal = COLOR_LITERAL.exec(css);
    if (literal != null) messages.push(`${pagePath} uses a raw color "${literal[0]}" instead of a token`);
    for (const match of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      if (!declared.has(match[1]!)) messages.push(`${pagePath} references ${match[1]} which tokens.css does not declare`);
    }
    if (/(^|[\s;{])--[A-Za-z0-9_-]+\s*:/.test(css)) messages.push(`${pagePath} declares its own custom properties`);
  }
  return outcome([...new Set(messages)]);
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
