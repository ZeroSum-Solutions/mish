import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `apps/web/next-env.d.ts` is a tracked file, but Next.js rewrites it on every
 * `next dev` / `next build` start (`writeAppTypeDeclarations`) to import the
 * route types from *the configured distDir*. tools-dev and the e2e harness run
 * Next with a namespace-scoped distDir under `.tmp/`, so an unguarded start
 * leaves the tracked file importing a machine-specific path such as
 * `./../../.tmp/e2e/<run>/.../web/next/dev/types/routes.d.ts`.
 *
 * Invariant: the tracked file only ever imports Next-generated types from the
 * default build output, `./.next/types/`. Next has no switch to skip the
 * write, so the web sidecar re-establishes the invariant after every prepare.
 *
 * The repair is a pure rewrite of the generated import specifiers rather than
 * "restore whatever was there before prepare": concurrent sidecars (parallel
 * Playwright workers, parallel e2e runtimes) interleave, and a snapshot taken
 * while a sibling is mid-prepare is already contaminated. Normalizing the
 * content converges to the committed file no matter how starts interleave.
 */
export const NEXT_ENV_FILE_NAME = "next-env.d.ts";
export const NEXT_ENV_STABLE_TYPES_PREFIX = "./.next/types/";

const NEXT_ENV_IMPORT_PATTERN = /^(\s*import\s+["'])([^"']+)(["'];?\s*)$/gm;

/** Rewrite every `import "./<distDir>/[dev/]types/<file>"` to `./.next/types/<file>`. */
export function stabilizeNextEnvContent(content: string): string {
  return content.replace(NEXT_ENV_IMPORT_PATTERN, (line, head: string, specifier: string, tail: string) => {
    const match = /(?:^|\/)types\/([^/]+)$/.exec(specifier);
    if (match == null) return line;
    return `${head}${NEXT_ENV_STABLE_TYPES_PREFIX}${match[1]}${tail}`;
  });
}

/**
 * Run Next's prepare and then put `next-env.d.ts` back into its stable form.
 * A file that did not exist before prepare is removed again, so a checkout
 * without it is not handed a generated one.
 */
export async function prepareNextAppPreservingNextEnv(
  app: { prepare(): Promise<void> },
  dir: string,
): Promise<void> {
  const nextEnvPath = join(dir, NEXT_ENV_FILE_NAME);
  const existedBefore = (await readFile(nextEnvPath, "utf8").catch(() => null)) != null;
  try {
    await app.prepare();
  } finally {
    await restoreStableNextEnv(nextEnvPath, existedBefore);
  }
}

async function restoreStableNextEnv(nextEnvPath: string, existedBefore: boolean): Promise<void> {
  if (!existedBefore) {
    await rm(nextEnvPath, { force: true }).catch(() => undefined);
    return;
  }
  const current = await readFile(nextEnvPath, "utf8").catch(() => null);
  if (current == null) return;
  const stable = stabilizeNextEnvContent(current);
  if (stable !== current) await writeFile(nextEnvPath, stable, "utf8").catch(() => undefined);
}
