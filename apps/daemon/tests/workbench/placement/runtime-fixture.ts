import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlacementOwnerWithProvenance } from '../../../src/workbench/placement/owner-provenance.js';
import { PLACEMENT_OWNER_ENV } from '../../../src/workbench/placement/owner-bootstrap.js';

/** Actual measured cohort; native cases skip elsewhere and say so. */
export const nativeSupported = process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.5.0' && process.versions.node === '24.16.0';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const TSX_ESM = resolve(REPO_ROOT, 'node_modules/tsx/dist/esm/index.mjs');
export const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/workbench/placement/owner-native.c');

export interface OwnerFixture { evidence: string; binding: { path: string; sha256: string }; provenancePath: string }
/** Explicit owned-fixture build (not startup): a real arm64 binary plus its provenance record. */
export async function buildOwnerFixture(label: string): Promise<OwnerFixture> {
  const evidence = await realpath(await mkdtemp(join(process.env.OD_PLACEMENT_TEST_EVIDENCE ?? tmpdir(), `${label}-`)));
  const provenancePath = join(evidence, 'owner.provenance.json');
  const provenance = await buildPlacementOwnerWithProvenance({
    sourcePath, outputPath: join(evidence, 'owner.node'), provenancePath, nodeIncludeDir: resolve(dirname(process.execPath), '../include/node'),
    arch: 'arm64', osRelease: release(), buildReceipt: `fixture:${label}`,
  });
  return { evidence, binding: provenance.binary, provenancePath };
}
export function ownerEnv(fixture: OwnerFixture, dataDir: string): NodeJS.ProcessEnv {
  return { OD_DATA_DIR: dataDir, [PLACEMENT_OWNER_ENV.binding]: fixture.binding.path, [PLACEMENT_OWNER_ENV.sha256]: fixture.binding.sha256, [PLACEMENT_OWNER_ENV.provenance]: fixture.provenancePath };
}
let sequence = 0;
/** A parent for fresh, not-yet-created data roots inside the owned evidence directory. */
export async function rootParent(fixture: OwnerFixture): Promise<string> {
  const parent = join(fixture.evidence, `roots-${++sequence}`); await mkdir(parent, { mode: 0o700 }); return parent;
}
