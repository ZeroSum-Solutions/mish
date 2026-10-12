/* ─────────────────────────────────────────────────────────────────────────
 * scripts/generate-licensed-pack-blobs.ts
 *
 * Writes scripts/data/licensed-pack-blobs.txt, the blob denylist the licence
 * guard (scripts/check-licensed-pack-content.ts) reads: git blob ids (the
 * `git hash-object` SHA-1), one per line, sorted, with no paths or names.
 *
 * Sources:
 *   (i)   every blob at `--ref` (default HEAD) whose path matches a licence
 *         path rule;
 *   (ii)  every string payload in `files[].content` of a licensed JSON (the
 *         kit's registry items embed their source there), hashed as written
 *         and with a trailing newline, so a payload saved as its own file is
 *         caught;
 *   (iii) with `--pack-dir <folder>`, every file a built pack's pack.json
 *         lists in files[], after checking its files[].sha256.
 * Drop rules: blobs under 64 bytes, and blobs that also occur at a path
 * outside the licensed set at `--ref` (shared). Paths under the fixture roots
 * do not count as outside. Every dropped shared blob is printed with the paths
 * it shares, and the run fails unless `--accept-shared` is passed, because a
 * shared blob can be a leak rather than boilerplate.
 *
 * The result is merged with the existing list (a union), because the licensed
 * paths disappear once P1-8 deletes them; `--replace` starts from empty. The
 * output is deterministic, so a second run is byte-identical. After a
 * regeneration, raise LICENSED_PACK_BLOB_LIST_MIN_IDS to the new count.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-licensed-pack-blobs.ts [--ref <rev>] [--pack-dir <folder>] [--replace] [--accept-shared]
 * ─────────────────────────────────────────────────────────────────────── */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  LICENSED_PACK_BLOB_LIST_PATH,
  findLicensedPackPathMatches,
  formatLicensedPackBlobList,
  gitBlobId,
  isLicensedPackFixturePath,
  parseLicensedPackBlobList,
} from "./check-licensed-pack-content.ts";

const execFileAsync = promisify(execFile);

export const MIN_LICENSED_BLOB_BYTES = 64;

export type TreeBlob = { path: string; oid: string; size: number };

/** A licensed blob that is not a tracked file: an embedded payload or a pack file. */
export type ExtraBlob = { oid: string; size: number; source: string };

export type DroppedSharedBlob = { oid: string; sources: string[]; sharedWith: string[] };

/**
 * Pure selection: licensed blobs of at least MIN_LICENSED_BLOB_BYTES that
 * never occur at a non-licensed, non-fixture path, plus qualifying extra
 * blobs. Returns sorted unique ids and every blob dropped as shared.
 */
export function selectLicensedPackBlobs(input: {
  tree: readonly TreeBlob[];
  licensedPaths: ReadonlySet<string>;
  extra?: readonly ExtraBlob[];
}): { ids: string[]; droppedShared: DroppedSharedBlob[] } {
  const sharedPaths = new Map<string, string[]>();
  for (const blob of input.tree) {
    if (input.licensedPaths.has(blob.path) || isLicensedPackFixturePath(blob.path)) continue;
    sharedPaths.set(blob.oid, [...(sharedPaths.get(blob.oid) ?? []), blob.path]);
  }
  const candidates: ExtraBlob[] = [
    ...input.tree
      .filter((blob) => input.licensedPaths.has(blob.path))
      .map((blob) => ({ oid: blob.oid, size: blob.size, source: blob.path })),
    ...(input.extra ?? []),
  ];
  const ids = new Set<string>();
  const dropped = new Map<string, DroppedSharedBlob>();
  for (const blob of candidates) {
    if (blob.size < MIN_LICENSED_BLOB_BYTES) continue;
    const sharedWith = sharedPaths.get(blob.oid);
    if (sharedWith !== undefined) {
      const entry = dropped.get(blob.oid) ?? { oid: blob.oid, sources: [], sharedWith: [...sharedWith].sort() };
      entry.sources.push(blob.source);
      dropped.set(blob.oid, entry);
      continue;
    }
    ids.add(blob.oid);
  }
  const droppedShared = [...dropped.values()]
    .map((entry) => ({ ...entry, sources: [...new Set(entry.sources)].sort() }))
    .sort((a, b) => (a.oid < b.oid ? -1 : 1));
  return { ids: [...ids].sort(), droppedShared };
}

/** Blob ids for each `files[].content` string of a registry-shaped JSON, as written and with a trailing newline. */
export function embeddedPayloadBlobs(jsonPath: string, text: string): ExtraBlob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  const blobs: ExtraBlob[] = [];
  for (const entry of files) {
    const content = (entry as { content?: unknown } | null)?.content;
    if (typeof content !== "string") continue;
    for (const variant of [content, `${content}\n`]) {
      const bytes = Buffer.from(variant, "utf8");
      blobs.push({ oid: gitBlobId(bytes), size: bytes.byteLength, source: `${jsonPath}#files[].content` });
    }
  }
  return blobs;
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Reads many blobs through one `git cat-file --batch` process. */
async function readBlobs(repoRoot: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Map();
  const child = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot, stdio: ["pipe", "pipe", "inherit"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.end(`${unique.join("\n")}\n`);
  const code = await exited;
  if (code !== 0) throw new Error(`git cat-file --batch exited with ${code}`);
  const output = Buffer.concat(chunks);
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [oid, type, size] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (oid === undefined || type !== "blob" || size === undefined) throw new Error(`unexpected cat-file header at ${offset}`);
    const start = headerEnd + 1;
    blobs.set(oid, output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

/** `git ls-tree -r -l -z <ref>`: blob entries with sizes, and gitlink paths reported separately. */
async function listTreeBlobs(repoRoot: string, ref: string): Promise<{ blobs: TreeBlob[]; gitlinks: string[] }> {
  const stdout = await git(repoRoot, ["ls-tree", "-r", "-l", "-z", ref]);
  const blobs: TreeBlob[] = [];
  const gitlinks: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [, type, oid, size] = record.slice(0, tab).split(/\s+/);
    const repositoryPath = record.slice(tab + 1);
    if (type === "commit") gitlinks.push(repositoryPath);
    else if (type === "blob" && oid !== undefined && size !== undefined) {
      blobs.push({ path: repositoryPath, oid, size: Number(size) });
    }
  }
  return { blobs, gitlinks };
}

function isSafePackRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Hashes each pack.json files[] entry after checking it against its recorded sha256. */
export async function packDirBlobs(packDir: string): Promise<ExtraBlob[]> {
  const manifest: unknown = JSON.parse(await readFile(path.join(packDir, "pack.json"), "utf8"));
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new Error(`${packDir}/pack.json has no files[] list`);
  const blobs: ExtraBlob[] = [];
  for (const entry of files) {
    const record = (entry ?? {}) as { path?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof record.path !== "string" || !isSafePackRelativePath(record.path)) {
      throw new Error(`${packDir}/pack.json files[] has an unsafe or missing path: ${JSON.stringify(record.path)}`);
    }
    if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new Error(`${packDir}/pack.json files[] entry ${record.path} has no sha256`);
    }
    const bytes = await readFile(path.join(packDir, ...record.path.split("/")));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.sha256) {
      throw new Error(`${packDir}/${record.path}: sha256 ${actual} does not match pack.json ${record.sha256}`);
    }
    if (typeof record.bytes === "number" && record.bytes !== bytes.byteLength) {
      throw new Error(`${packDir}/${record.path}: ${bytes.byteLength} bytes, pack.json says ${record.bytes}`);
    }
    blobs.push({ oid: gitBlobId(bytes), size: bytes.byteLength, source: `pack:${record.path}` });
  }
  return blobs;
}

export type GeneratedBlobList = {
  /** Full text of the new denylist (existing ∪ newly selected ids). */
  text: string;
  droppedShared: DroppedSharedBlob[];
  gitlinks: string[];
};

export async function generateLicensedPackBlobList(options: {
  repoRoot: string;
  ref?: string;
  packDir?: string;
  /** Current denylist text to merge with; "" starts from empty. */
  existing: string;
}): Promise<GeneratedBlobList> {
  const ref = options.ref ?? "HEAD";
  const { blobs: tree, gitlinks } = await listTreeBlobs(options.repoRoot, ref);
  const oidByPath = new Map(tree.map((blob) => [blob.path, blob.oid]));
  const manifestOids = tree
    .filter((blob) => blob.path.startsWith("plugins/") && blob.path.endsWith("/open-design.json"))
    .map((blob) => blob.oid);
  const manifests = await readBlobs(options.repoRoot, manifestOids);
  const pathMatches = await findLicensedPackPathMatches(
    tree.map((blob) => blob.path),
    async (repositoryPath) => {
      const oid = oidByPath.get(repositoryPath);
      return oid === undefined ? undefined : manifests.get(oid)?.toString("utf8");
    },
  );
  const licensedPaths = new Set(pathMatches.keys());

  const licensedJson = tree.filter((blob) => licensedPaths.has(blob.path) && blob.path.endsWith(".json"));
  const jsonBodies = await readBlobs(
    options.repoRoot,
    licensedJson.map((blob) => blob.oid),
  );
  const embedded = licensedJson.flatMap((blob) =>
    embeddedPayloadBlobs(blob.path, jsonBodies.get(blob.oid)?.toString("utf8") ?? ""),
  );
  const packed = options.packDir === undefined ? [] : await packDirBlobs(options.packDir);
  const selected = selectLicensedPackBlobs({ tree, licensedPaths, extra: [...embedded, ...packed] });

  const existing = parseLicensedPackBlobList(options.existing);
  if ("error" in existing) throw new Error(`existing denylist: ${existing.error}`);
  return {
    text: formatLicensedPackBlobList([...existing.ids, ...selected.ids]),
    droppedShared: selected.droppedShared,
    gitlinks,
  };
}

function parseArgs(argv: readonly string[]): {
  ref?: string;
  packDir?: string;
  replace: boolean;
  acceptShared: boolean;
} {
  const result: { ref?: string; packDir?: string; replace: boolean; acceptShared: boolean } = {
    replace: false,
    acceptShared: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--replace") {
      result.replace = true;
    } else if (arg === "--accept-shared") {
      result.acceptShared = true;
    } else if ((arg === "--ref" || arg === "--pack-dir") && value !== undefined) {
      if (arg === "--ref") result.ref = value;
      else result.packDir = path.resolve(value);
      index++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  const outPath = path.join(repoRoot, LICENSED_PACK_BLOB_LIST_PATH);
  let existing = "";
  if (!args.replace) {
    try {
      existing = await readFile(outPath, "utf8");
    } catch {
      existing = "";
    }
  }
  const result = await generateLicensedPackBlobList({
    repoRoot,
    existing,
    ...(args.ref === undefined ? {} : { ref: args.ref }),
    ...(args.packDir === undefined ? {} : { packDir: args.packDir }),
  });
  for (const gitlink of result.gitlinks) console.error(`Not hashed, gitlink (submodule): ${gitlink}`);
  for (const blob of result.droppedShared) {
    console.error(
      `Dropped shared blob ${blob.oid}: licensed at ${blob.sources.join(", ")}; also at ${blob.sharedWith.join(", ")}`,
    );
  }
  if (result.droppedShared.length > 0 && !args.acceptShared) {
    console.error(
      `${result.droppedShared.length} licensed blob(s) also occur outside the licensed paths. Remove the copies, or pass --accept-shared once each is confirmed as boilerplate. Nothing written.`,
    );
    process.exitCode = 1;
  } else {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, result.text, "utf8");
    const count = result.text === "" ? 0 : result.text.trimEnd().split("\n").length;
    console.log(
      `Wrote ${count} blob id(s) to ${LICENSED_PACK_BLOB_LIST_PATH}. Set LICENSED_PACK_BLOB_LIST_MIN_IDS to ${count} if it is lower.`,
    );
  }
}
