import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "node:assert/strict";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function read(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

// No public registry carries a Mishh Mashh image, so the evaluation lanes
// must not fall back to a guessed image name: the operator names the image
// they published (deploy/scripts/publish-images.sh) and Azure can pull.
for (const template of ["deploy/azure/aci.bicep", "deploy/azure/app-service.bicep"]) {
  test(`${template} requires an explicit image`, async () => {
    const source = await read(template);
    const declaration = source.match(/^param image string(.*)$/m);
    assert.ok(declaration, `${template} declares an image parameter`);
    assert.equal(declaration[1]!.trim(), "", `${template} image parameter has no default`);
  });
}

test("deploy-azure.sh refuses to run without --image", () => {
  const env = { ...process.env };
  delete env.IMAGE;
  const result = spawnSync("bash", [path.join(repoRoot, "deploy/azure/deploy-azure.sh"), "--target", "aci"], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--image is required/);
});

test("Azure docs and script name no unpublished image", async () => {
  for (const file of ["deploy/azure/README.md", "deploy/azure/deploy-azure.sh", "deploy/azure/aci.bicep", "deploy/azure/app-service.bicep"]) {
    assert.doesNotMatch(await read(file), /vanjayak/, `${file} names a Docker Hub image nobody publishes`);
  }
});
