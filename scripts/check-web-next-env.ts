/* ───────────────────────────────────────────────────────────────────
 * Guard: the tracked `apps/web/next-env.d.ts` stays machine-independent.
 *
 * Next.js rewrites this file on every dev/build start so that it imports the
 * route types of the configured distDir. tools-dev and the e2e harness run
 * Next with a namespace-scoped distDir under `.tmp/`, so an unguarded start
 * rewrites the tracked file to something like
 * `import "./../../.tmp/e2e/<run>/.../web/next/dev/types/routes.d.ts";` —
 * a path that only exists on the machine that ran the tests. That change has
 * been committed by accident before.
 *
 * The runtime side keeps the file stable (`apps/web/sidecar/next-env.ts`
 * after every prepare, `tools/dev/src/web-next-env.ts` on every web stop);
 * this guard makes a contaminated file fail `pnpm guard` before it lands:
 *
 *   every module import in next-env.d.ts resolves inside `./.next/`.
 *
 * Run standalone: `pnpm exec tsx scripts/check-web-next-env.ts`
 * Or as part of `pnpm guard` (registered in scripts/guard.ts).
 * ─────────────────────────────────────────────────────────────────── */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");

export const WEB_NEXT_ENV_PATH = "apps/web/next-env.d.ts";

const IMPORT_SPECIFIER_PATTERN = /^\s*import\s+(?:[^"';]*\s+from\s+)?["']([^"']+)["']/gm;
const REFERENCE_PATH_PATTERN = /^\s*\/\/\/\s*<reference\s+path=["']([^"']+)["']/gm;

/** Returns one message per import or path reference that escapes `./.next/`. */
export function webNextEnvViolations(source: string): string[] {
  const violations: string[] = [];
  const specifiers = [
    ...[...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[1]!),
    ...[...source.matchAll(REFERENCE_PATH_PATTERN)].map((match) => match[1]!),
  ];
  for (const specifier of specifiers) {
    const normalized = path.posix.normalize(specifier);
    if (!normalized.startsWith(".next/") || specifier.split("/").includes("..")) {
      violations.push(
        `${WEB_NEXT_ENV_PATH} imports "${specifier}", which is outside ./.next/ ` +
          `(a Next.js dev/build run with a non-default distDir rewrote the tracked file)`,
      );
    }
  }
  return violations;
}

export async function checkWebNextEnv(root: string = repoRoot): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path.join(root, WEB_NEXT_ENV_PATH), "utf8");
  } catch (error) {
    console.error(`${WEB_NEXT_ENV_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const violations = webNextEnvViolations(source);
  if (violations.length > 0) {
    console.error("Web next-env.d.ts violations found:");
    for (const violation of violations) console.error(`- ${violation}`);
    console.error(`Restore it with: git checkout -- ${WEB_NEXT_ENV_PATH}`);
    return false;
  }

  console.log(`Web next-env check passed: ${WEB_NEXT_ENV_PATH} only imports from ./.next/.`);
  return true;
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await checkWebNextEnv()) ? 0 : 1;
}
