import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  adoptionExecutorEnv,
  buildPlacementAdoptionHelper,
  PLACEMENT_ADOPTION_EXECUTOR_ENV,
  PLACEMENT_ADOPTION_HELPER_LAYOUT,
  PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA,
  PLACEMENT_ROOT_CREATION_RECORD,
} from "../src/placement-adoption-helper.js";
import { withoutAmbientPlacementOwner } from "../src/placement-owner.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { force: true, recursive: true }); });
function dataRoot(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tools-dev-adoption-")));
  scratch.push(dir);
  return path.join(dir, "data");
}
const measuredHost = process.platform === "darwin" && process.arch === "arm64";

describe("tools-dev adoption executor opt-in", () => {
  it("passes nothing without the flag and strips an ambient opt-in", () => {
    assert.equal(PLACEMENT_ADOPTION_EXECUTOR_ENV, "OD_PLACEMENT_ADOPTION_EXECUTOR");
    assert.deepEqual(withoutAmbientPlacementOwner({ OD_PLACEMENT_ADOPTION_EXECUTOR: "1", KEEP: "1" }), { KEEP: "1" });
  });

  it("refuses the flag without an explicit OD_DATA_DIR (no cwd fallback)", async () => {
    await assert.rejects(
      adoptionExecutorEnv({ placementAdoptionExecutor: true }, { workspaceRoot, env: {} }),
      /explicit OD_DATA_DIR/,
    );
    assert.deepEqual(await adoptionExecutorEnv({}, { workspaceRoot, env: {} }), {});
  });

  it("on any host other than darwin-arm64 builds nothing and still forwards the opt-in, so the daemon reports its host gate", async () => {
    const root = dataRoot();
    const result = await buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root, host: { platform: "linux", arch: "arm64" } });
    assert.deepEqual(result, { kind: "host-unsupported", host: "linux-arm64" });
    assert.equal(existsSync(root), false);
    const env = await adoptionExecutorEnv(
      { placementAdoptionExecutor: true },
      { workspaceRoot, env: { OD_DATA_DIR: root }, host: { platform: "linux", arch: "arm64" } },
    );
    assert.deepEqual(env, { OD_PLACEMENT_ADOPTION_EXECUTOR: "1" });
  });

  it("refuses a symlinked tool directory instead of building through it", async () => {
    const root = dataRoot();
    const elsewhere = path.join(path.dirname(root), "elsewhere");
    mkdirSync(path.join(root, PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir[0]), { recursive: true, mode: 0o700 });
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, path.join(root, ...PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir), "dir");
    await assert.rejects(
      buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root, host: { platform: "darwin", arch: "arm64" } }),
      /not a private directory/,
    );
  });

  it("records its own creation of the data root, bound to the root's identity, so bootstrap can prove it fresh", { skip: !measuredHost && "darwin-arm64 only" }, async () => {
    const root = dataRoot();
    const result = await buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root });
    assert.equal(result.kind, "built");
    const stat = lstatSync(root, { bigint: true });
    const record = JSON.parse(readFileSync(path.join(root, PLACEMENT_ROOT_CREATION_RECORD.name), "utf8"));
    assert.deepEqual(record, { schema: PLACEMENT_ROOT_CREATION_RECORD.schema, creator: "tools-dev", device: String(stat.dev), inode: String(stat.ino) });
    assert.equal(lstatSync(path.join(root, PLACEMENT_ROOT_CREATION_RECORD.name)).mode & 0o777, 0o600);
    // The root holds nothing but the record and the helper tree.
    assert.deepEqual((await import("node:fs")).readdirSync(root).sort(), [PLACEMENT_ROOT_CREATION_RECORD.name, PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir[0]].sort());
  });

  it("never records a data root it did not create", { skip: !measuredHost && "darwin-arm64 only" }, async () => {
    const root = dataRoot();
    mkdirSync(root, { mode: 0o700 });
    await buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root });
    assert.equal(existsSync(path.join(root, PLACEMENT_ROOT_CREATION_RECORD.name)), false);
  });

  it("builds the tracked native.c into the data-root tool directory with a build-time digest record", { skip: !measuredHost && "darwin-arm64 only" }, async () => {
    const root = dataRoot();
    const result = await buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root });
    assert.equal(result.kind, "built");
    if (result.kind !== "built") return;
    const toolDir = path.join(root, ...PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir);
    const binary = path.join(toolDir, PLACEMENT_ADOPTION_HELPER_LAYOUT.binary);
    const record = JSON.parse(readFileSync(path.join(toolDir, PLACEMENT_ADOPTION_HELPER_LAYOUT.record), "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["arch", "binary", "buildReceipt", "command", "compiler", "platform", "schema", "sourceSHA256"]);
    assert.equal(record.schema, PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA);
    assert.deepEqual(record.binary, { name: PLACEMENT_ADOPTION_HELPER_LAYOUT.binary, sha256: sha(readFileSync(binary)) });
    assert.equal(record.sourceSHA256, sha(readFileSync(path.join(workspaceRoot, "apps/daemon/src/workbench/placement/native.c"))));
    assert.equal(record.platform, "darwin");
    assert.equal(record.arch, "arm64");
    for (const dir of [path.join(root, PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir[0]), toolDir]) {
      assert.equal(lstatSync(dir).mode & 0o777, 0o700, dir);
    }
    assert.equal(lstatSync(binary).mode & 0o777, 0o500);
    assert.equal(lstatSync(path.join(toolDir, PLACEMENT_ADOPTION_HELPER_LAYOUT.record)).mode & 0o777, 0o400);
    // A rebuild replaces both files atomically and leaves no temporaries.
    const again = await buildPlacementAdoptionHelper({ workspaceRoot, dataRoot: root });
    assert.equal(again.kind, "built");
    assert.deepEqual((await import("node:fs")).readdirSync(toolDir).sort(), [PLACEMENT_ADOPTION_HELPER_LAYOUT.record, PLACEMENT_ADOPTION_HELPER_LAYOUT.binary].sort());
    // A rebuild keeps the original creation record unchanged.
    assert.equal(existsSync(path.join(root, PLACEMENT_ROOT_CREATION_RECORD.name)), true);
  });
});
