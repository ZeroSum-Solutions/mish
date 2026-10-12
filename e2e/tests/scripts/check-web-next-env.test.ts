import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  WEB_NEXT_ENV_PATH,
  checkWebNextEnv,
  webNextEnvViolations,
} from "../../../scripts/check-web-next-env.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const STABLE = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/types/routes.d.ts";',
  "",
  "// NOTE: This file should not be edited",
  "",
].join("\n");

// The exact shape a tools-dev / e2e Next dev run wrote into the tracked file.
const NAMESPACED = STABLE.replace(
  "./.next/types/routes.d.ts",
  "./../../.tmp/e2e/run-1/tools-dev/web/next/dev/types/routes.d.ts",
);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function rootWith(content: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "web-next-env-guard-"));
  roots.push(root);
  await mkdir(path.join(root, path.dirname(WEB_NEXT_ENV_PATH)), { recursive: true });
  await writeFile(path.join(root, WEB_NEXT_ENV_PATH), content, "utf8");
  return root;
}

describe("web next-env.d.ts guard", () => {
  test("the repository copy only imports from ./.next/", async () => {
    const source = await readFile(path.join(repoRoot, WEB_NEXT_ENV_PATH), "utf8");
    expect(webNextEnvViolations(source)).toEqual([]);
  });

  test("accepts the committed shape", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(webNextEnvViolations(STABLE)).toEqual([]);
    await expect(checkWebNextEnv(await rootWith(STABLE))).resolves.toBe(true);
  });

  test("rejects a namespace distDir import written by a tools-dev Next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(webNextEnvViolations(NAMESPACED)).toEqual([
      expect.stringContaining("./../../.tmp/e2e/run-1/tools-dev/web/next/dev/types/routes.d.ts"),
    ]);
    await expect(checkWebNextEnv(await rootWith(NAMESPACED))).resolves.toBe(false);
  });

  test("rejects imports that escape ./.next/ through .. segments or other roots", () => {
    expect(webNextEnvViolations('import "./.next/../out/types/routes.d.ts";')).toHaveLength(1);
    expect(webNextEnvViolations('import "./out/types/routes.d.ts";')).toHaveLength(1);
    expect(webNextEnvViolations('/// <reference path="../../.tmp/x/types/routes.d.ts" />')).toHaveLength(1);
  });

  test("fails when the file is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(path.join(tmpdir(), "web-next-env-guard-"));
    roots.push(root);
    await expect(checkWebNextEnv(root)).resolves.toBe(false);
  });
});
