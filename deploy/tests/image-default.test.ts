import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "../..");

async function read(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

function capture(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  assert.ok(match?.[1], `${label}: pattern ${pattern} not found`);
  return match[1];
}

// The image publish-images.sh pushes by default is the one every deploy
// surface must pull by default; otherwise a fresh install pulls an image no
// script ever published.
async function publishedImage(): Promise<string> {
  const script = await read("deploy/scripts/publish-images.sh");
  const registry = capture(script, /^REGISTRY="\$\{REGISTRY:-([^}]+)\}"/m, "REGISTRY");
  const namespace = capture(script, /^IMAGE_NAMESPACE="\$\{IMAGE_NAMESPACE:-([^}]+)\}"/m, "IMAGE_NAMESPACE");
  const repository = capture(script, /^IMAGE_REPOSITORY="\$\{IMAGE_REPOSITORY:-([^}]+)\}"/m, "IMAGE_REPOSITORY");
  return `${registry}/${namespace.toLowerCase()}/${repository}`;
}

test("deploy surfaces default to the image publish-images.sh publishes", async () => {
  const image = `${await publishedImage()}:latest`;

  const defaults: Array<[string, string]> = [
    ["deploy/docker-compose.yml", capture(await read("deploy/docker-compose.yml"), /image: \$\{MISH_IMAGE:-([^}]+)\}/, "compose")],
    ["deploy/.env.example", capture(await read("deploy/.env.example"), /^MISH_IMAGE=(\S+)$/m, ".env.example")],
    ["deploy/scripts/install.sh", capture(await read("deploy/scripts/install.sh"), /^DEFAULT_IMAGE="([^"]+)"/m, "install.sh")],
    ["deploy/Dockerfile.local", capture(await read("deploy/Dockerfile.local"), /^FROM (\S+)$/m, "Dockerfile.local")],
    ["deploy/azure/container-instance.bicep", capture(await read("deploy/azure/container-instance.bicep"), /^param image string = '([^']+)'/m, "bicep")],
    ["deploy/azure/azure-pipelines.yml", capture(await read("deploy/azure/azure-pipelines.yml"), /^\s*mishImage: (\S+)$/m, "azure-pipelines")],
  ];

  for (const [file, value] of defaults) {
    assert.equal(value, image, `${file} default image`);
  }
});

test("deploy README names the image publish-images.sh publishes", async () => {
  const image = await publishedImage();
  const readme = await read("deploy/README.md");
  const named = new Set(readme.match(/ghcr\.io\/zerosum-solutions\/[a-z0-9._-]+/g) ?? []);
  assert.deepEqual([...named], [image]);
});
