import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * tools-dev runs Next.js with a namespace-scoped distDir under `.tmp/`, and
 * Next rewrites the tracked `apps/web/next-env.d.ts` on every start to import
 * route types from that distDir. The web sidecar puts the file back after its
 * own prepare (`apps/web/sidecar/next-env.ts`), but a sidecar that is killed
 * mid-prepare (stop timeout, crashed worker) never reaches that repair.
 *
 * tools-dev therefore re-establishes the same invariant whenever it stops web:
 * every import in the tracked file targets `./.next/types/`. The rewrite is a
 * convergent normalization, not a snapshot restore, so it is safe while other
 * namespaces' sidecars are starting concurrently.
 */
export const WEB_NEXT_ENV_RELATIVE_PATH = "apps/web/next-env.d.ts";
const STABLE_TYPES_PREFIX = "./.next/types/";
const IMPORT_LINE_PATTERN = /^(\s*import\s+["'])([^"']+)(["'];?\s*)$/gm;

export function stabilizeWebNextEnvContent(content: string): string {
  return content.replace(IMPORT_LINE_PATTERN, (line, head: string, specifier: string, tail: string) => {
    const match = /(?:^|\/)types\/([^/]+)$/.exec(specifier);
    if (match == null) return line;
    return `${head}${STABLE_TYPES_PREFIX}${match[1]}${tail}`;
  });
}

/** Returns true when the tracked file had to be repaired. */
export async function stabilizeWebNextEnv(workspaceRoot: string): Promise<boolean> {
  const filePath = path.join(workspaceRoot, WEB_NEXT_ENV_RELATIVE_PATH);
  const current = await readFile(filePath, "utf8").catch(() => null);
  if (current == null) return false;
  const stable = stabilizeWebNextEnvContent(current);
  if (stable === current) return false;
  await writeFile(filePath, stable, "utf8");
  return true;
}
