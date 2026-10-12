import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { stabilizeWebNextEnv, stabilizeWebNextEnvContent, WEB_NEXT_ENV_RELATIVE_PATH } from "../src/web-next-env.js";

const STABLE = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/types/routes.d.ts";',
  "",
  "// NOTE: This file should not be edited",
  "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
  "",
].join("\n");

const NAMESPACED = STABLE.replace(
  "./.next/types/routes.d.ts",
  "./../../.tmp/e2e/run-7/tools-dev/web/next/dev/types/routes.d.ts",
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function workspaceWith(content: string | null): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tools-dev-next-env-"));
  roots.push(root);
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  if (content != null) await writeFile(path.join(root, WEB_NEXT_ENV_RELATIVE_PATH), content, "utf8");
  return root;
}

describe("stabilizeWebNextEnvContent", () => {
  it("maps a namespace distDir import back to ./.next/types", () => {
    assert.equal(stabilizeWebNextEnvContent(NAMESPACED), STABLE);
  });

  it("is the identity on the committed file", () => {
    assert.equal(stabilizeWebNextEnvContent(STABLE), STABLE);
  });
});

describe("stabilizeWebNextEnv", () => {
  it("repairs a file left behind by a web sidecar killed mid-prepare", async () => {
    const root = await workspaceWith(NAMESPACED);
    assert.equal(await stabilizeWebNextEnv(root), true);
    assert.equal(await readFile(path.join(root, WEB_NEXT_ENV_RELATIVE_PATH), "utf8"), STABLE);
  });

  it("does not touch a stable or missing file", async () => {
    const stableRoot = await workspaceWith(STABLE);
    assert.equal(await stabilizeWebNextEnv(stableRoot), false);
    const emptyRoot = await workspaceWith(null);
    assert.equal(await stabilizeWebNextEnv(emptyRoot), false);
    await assert.rejects(readFile(path.join(emptyRoot, WEB_NEXT_ENV_RELATIVE_PATH), "utf8"));
  });
});
