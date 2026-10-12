import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveToolsDevDataRoot } from "./data-root.js";

/**
 * Development build of the native adoption mover helper (B4-1, phase A).
 *
 * `tools-dev start|run|restart --placement-adoption-executor` compiles the
 * tracked `apps/daemon/src/workbench/placement/native.c` into a tool
 * directory derived from the same explicit `OD_DATA_DIR` the daemon resolves
 * as its data root, records the binary's digest next to it, and hands the
 * daemon `OD_PLACEMENT_ADOPTION_EXECUTOR=1`. The daemon verifies the binary
 * against this record (and the record's source digest against its own pin);
 * it never builds or searches for the helper itself. Root AGENTS.md records
 * this as a sanctioned exception to the daemon data directory contract. The
 * layout, record schema and opt-in name are a pinned copy of
 * `WORKBENCH_ADOPTION_HELPER_LAYOUT` and friends in `packages/contracts`
 * (tools-dev has no contracts dependency); e2e/tests/workbench/placement-adoption-layout.test.ts
 * keeps them equal.
 */
export const PLACEMENT_ADOPTION_EXECUTOR_ENV = "OD_PLACEMENT_ADOPTION_EXECUTOR";
export const PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA = "mishmash.placement-adoption-helper/v1";
export const PLACEMENT_ADOPTION_HELPER_LAYOUT = Object.freeze({
  toolDir: Object.freeze(["placement", "adoption-helper"] as const),
  binary: "placement-helper",
  record: "helper.json",
});
/**
 * Written only when this build created the data root itself (pinned copy of
 * `WORKBENCH_ADOPTION_ROOT_RECORD`). The coordinated bootstrap counts the root
 * as created by its own boot only while it still holds nothing but this record
 * and the helper tree, then consumes the record; without it, a root that
 * already existed keeps adoption closed (`legacy-predecessor-unproven`) unless
 * the previous coordinated daemon sealed it at a clean stop (daemon
 * `workbench/placement/root-seal.ts`). Rebuilding the helper on a later start
 * writes only inside the placement directory, which the seal excludes.
 */
export const PLACEMENT_ROOT_CREATION_RECORD = Object.freeze({
  name: ".placement-root-created.json",
  schema: "mishmash.placement-root-created/v1",
});
const HELPER_SOURCE = ["apps", "daemon", "src", "workbench", "placement", "native.c"] as const;

export type PlacementAdoptionOptions = { placementAdoptionExecutor?: boolean };
export type AdoptionHelperBuild =
  | { kind: "built"; toolDir: string; binary: string; sha256: string; sourceSHA256: string }
  | { kind: "host-unsupported"; host: string };
type Host = { platform: string; arch: string };

const run = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const uid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Creates (0700) or accepts one directory level; never follows a symlink or accepts a shared directory. */
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== uid()) throw new Error(`placement adoption tool path is not a private directory: ${directory}`);
  await chmod(directory, 0o700);
}
/** Same-directory temporary then rename: a reader sees the old file or the complete new one. */
async function publish(target: string, write: (temporary: string) => Promise<void>, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await write(temporary);
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Phase A builds on darwin-arm64 only; elsewhere nothing is created and the daemon reports its host gate. */
export async function buildPlacementAdoptionHelper(input: { workspaceRoot: string; dataRoot: string; host?: Host }): Promise<AdoptionHelperBuild> {
  const host = input.host ?? { platform: process.platform, arch: process.arch };
  if (host.platform !== "darwin" || host.arch !== "arm64") return { kind: "host-unsupported", host: `${host.platform}-${host.arch}` };
  if (!path.isAbsolute(input.dataRoot) || !path.isAbsolute(input.workspaceRoot)) throw new Error("placement adoption helper build needs absolute workspace and data roots");
  await mkdir(path.dirname(input.dataRoot), { recursive: true, mode: 0o700 });
  const created = await mkdir(input.dataRoot, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return false;
    throw error;
  });
  if (created) {
    // Record our own creation, bound to this directory's identity, before anything else is put in it.
    const stat = await lstat(input.dataRoot, { bigint: true });
    const record = { schema: PLACEMENT_ROOT_CREATION_RECORD.schema, creator: "tools-dev", device: String(stat.dev), inode: String(stat.ino) };
    await writeFile(path.join(input.dataRoot, PLACEMENT_ROOT_CREATION_RECORD.name), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  }
  let toolDir = input.dataRoot;
  for (const segment of PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir) {
    toolDir = path.join(toolDir, segment);
    await privateDirectory(toolDir);
  }
  const source = path.join(input.workspaceRoot, ...HELPER_SOURCE);
  const sourceSHA256 = sha256(await readFile(source));
  const binary = path.join(toolDir, PLACEMENT_ADOPTION_HELPER_LAYOUT.binary);
  const compiler = (await run("/usr/bin/xcrun", ["clang", "--version"])).stdout.trim();
  // Same flags as the daemon's explicit `buildDarwinPlacementHelper` (build.ts).
  const args = (output: string) => ["clang", "-arch", "arm64", "-mmacosx-version-min=13.0", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", output];
  let digest = "";
  await publish(binary, async (temporary) => {
    await run("/usr/bin/xcrun", args(temporary));
    digest = sha256(await readFile(temporary));
  }, 0o500);
  const record = {
    schema: PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA,
    binary: { name: PLACEMENT_ADOPTION_HELPER_LAYOUT.binary, sha256: digest },
    sourceSHA256,
    platform: "darwin",
    arch: "arm64",
    compiler,
    command: ["/usr/bin/xcrun", ...args(binary)],
    buildReceipt: `tools-dev:${new Date().toISOString()}`,
  };
  await publish(
    path.join(toolDir, PLACEMENT_ADOPTION_HELPER_LAYOUT.record),
    (temporary) => writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
    0o400,
  );
  return { kind: "built", toolDir, binary, sha256: digest, sourceSHA256 };
}

/**
 * Daemon env for `--placement-adoption-executor`. The flag needs an explicit
 * `OD_DATA_DIR` (no cwd fallback): the tool directory must derive from the
 * daemon's own data root. Without the flag nothing is built or forwarded.
 */
export async function adoptionExecutorEnv(
  options: PlacementAdoptionOptions,
  context: { workspaceRoot: string; env?: NodeJS.ProcessEnv; host?: Host; log?: (line: string) => Promise<unknown> | unknown },
): Promise<Record<string, string>> {
  if (options.placementAdoptionExecutor !== true) return {};
  const dataRoot = resolveToolsDevDataRoot(context.workspaceRoot, context.env ?? process.env);
  if (dataRoot == null) {
    throw new Error("--placement-adoption-executor needs an explicit OD_DATA_DIR: the helper tool directory derives from the daemon data root");
  }
  const built = await buildPlacementAdoptionHelper({ workspaceRoot: context.workspaceRoot, dataRoot, ...(context.host ? { host: context.host } : {}) });
  await context.log?.(built.kind === "built"
    ? `[tools-dev] built placement adoption helper sha256=${built.sha256} source=${built.sourceSHA256}\n`
    : `[tools-dev] placement adoption helper not built: host ${built.host} is outside phase A; the daemon reports the gate\n`);
  return { [PLACEMENT_ADOPTION_EXECUTOR_ENV]: "1" };
}
