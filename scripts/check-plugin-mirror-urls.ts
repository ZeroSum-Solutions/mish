/* ─────────────────────────────────────────────────────────────────────────
 * scripts/check-plugin-mirror-urls.ts
 *
 * Guard for `plugin-assets.open-design.ai` references inside bundled example
 * plugins' `example.html`. The daemon's preview route (`apps/daemon/src/
 * routes/plugins/assets.ts`) only rewrites an external `src`/`poster`/CSS
 * `url()` value to the same-origin asset-cache proxy when its path ends in a
 * recognized image/video extension (`isCacheableExternalUrl` in
 * `apps/daemon/src/plugins/plugin-asset-cache.ts`). A mirror URL that fails
 * that check is served as-is and the preview route's CSP (`img-src 'self'`,
 * `connect-src 'none'`, no `font-src`) blocks it outright — a live 404/broken
 * asset in the shipped preview.
 *
 * This is not hypothetical: 10 `plugin-assets.open-design.ai` URLs across
 * ai-designer-portfolio, dreamcore-landing, evergreen-finance, and
 * stellar-launch carried a malformed `&w=1280&q=85` suffix after `.webp`
 * (an image-CDN resize query that never had a leading `?`), which is not a
 * cacheable extension. Fixed by stripping the suffix; this guard catches a
 * repeat.
 *
 * Checks every `plugin-assets.open-design.ai` URL referenced in each bundled
 * example plugin's `example.html` and fails if any is not cache-eligible.
 *
 * Run standalone: `pnpm exec tsx scripts/check-plugin-mirror-urls.ts`
 * Or as part of `pnpm guard` (registered in scripts/guard.ts).
 * ─────────────────────────────────────────────────────────────────────── */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCacheableExternalUrl } from "../apps/daemon/src/plugins/plugin-asset-cache.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const EXAMPLES_REPO_PATH = "plugins/_official/examples";
const MIRROR_HOST = "plugin-assets.open-design.ai";

// Matches an absolute http(s) URL up to the first quote, space, or closing
// paren/angle-bracket — same boundary the daemon's own rewriter and the
// audit's `grep -oE 'https?://[^"'"'"' )]+'` use.
const URL_PATTERN = /https?:\/\/[^"'\s)>]+/g;

export interface MirrorUrlViolation {
  pluginId: string;
  url: string;
}

/** Pure check over one example.html's text; no filesystem access, for tests. */
export function findUncacheableMirrorUrls(pluginId: string, html: string): MirrorUrlViolation[] {
  const violations: MirrorUrlViolation[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (!url.includes(MIRROR_HOST)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isCacheableExternalUrl(url)) violations.push({ pluginId, url });
  }
  return violations;
}

export async function checkPluginMirrorUrls(): Promise<boolean> {
  const examplesDir = path.join(repoRoot, EXAMPLES_REPO_PATH);
  let entries;
  try {
    entries = await readdir(examplesDir, { withFileTypes: true });
  } catch (error) {
    console.error(`Plugin mirror URL check failed: cannot read ${EXAMPLES_REPO_PATH}: ${
      error instanceof Error ? error.message : String(error)
    }`);
    return false;
  }

  const violations: MirrorUrlViolation[] = [];
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const examplePath = path.join(examplesDir, entry.name, "example.html");
    let html: string;
    try {
      html = await readFile(examplePath, "utf8");
    } catch {
      continue; // No example.html for this plugin — nothing to check.
    }
    checked++;
    violations.push(...findUncacheableMirrorUrls(entry.name, html));
  }

  if (violations.length > 0) {
    console.error(
      `Plugin mirror URL check failed: ${violations.length} ${MIRROR_HOST} URL(s) will not be rewritten by the plugin-asset-cache (isCacheableExternalUrl returned false) and will 404 under the preview route's CSP:`,
    );
    for (const v of violations) console.error(`- ${v.pluginId}: ${v.url}`);
    return false;
  }

  console.log(
    `Plugin mirror URL check passed: every ${MIRROR_HOST} reference across ${checked} example plugins has a cacheable extension.`,
  );
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ok = await checkPluginMirrorUrls();
  if (!ok) process.exitCode = 1;
}
