import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, normalize } from 'node:path';
import { buildDarwinPlacementOwner } from './owner-build.js';

/**
 * Pinned digest of the tracked `owner-native.c`. A sibling test recomputes it
 * from the file, so a source change must restate provenance explicitly.
 */
export const PLACEMENT_OWNER_SOURCE_SHA256 = '9e62e01972ce1c38f0bb77b736636ae0d7cd6d0b60d35161e7ba4c5427e96c1a';
export const PLACEMENT_OWNER_PROVENANCE_SCHEMA = 'mishmash.placement-owner-provenance/v1';
const HEADER_NAMES = ['node_api.h', 'js_native_api.h', 'js_native_api_types.h', 'node_api_types.h', 'node_version.h'] as const;

export interface PlacementOwnerBindingInput { path: string; sha256: string }
export interface PlacementOwnerProvenance {
  schema: typeof PLACEMENT_OWNER_PROVENANCE_SCHEMA;
  binary: PlacementOwnerBindingInput;
  sourceSHA256: string;
  headers: ReadonlyArray<{ name: string; sha256: string }>;
  compiler: string; sdk: string; command: readonly string[];
  node: string; napi: 10; arch: 'arm64' | 'x86_64'; platform: 'darwin'; osRelease: string; deploymentTarget: '13.0';
  buildReceipt: string;
}
export interface PlacementHostFacts { platform: string; arch: string; node: string; osRelease: string; mainThread: boolean }

const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value) && normalize(value) === value;
export class PlacementProvenanceError extends Error {
  constructor(readonly reason: string) { super(`Placement owner provenance refused: ${reason}`); this.name = 'PlacementProvenanceError'; }
}

/** Strict closed-shape parser; no defaults, no tolerated extra fields. */
export function parsePlacementOwnerProvenance(input: unknown): PlacementOwnerProvenance {
  const fields = ['schema', 'binary', 'sourceSHA256', 'headers', 'compiler', 'sdk', 'command', 'node', 'napi', 'arch', 'platform', 'osRelease', 'deploymentTarget', 'buildReceipt'];
  if (!record(input) || !exact(input, fields) || input.schema !== PLACEMENT_OWNER_PROVENANCE_SCHEMA) throw new PlacementProvenanceError('shape');
  const binary = input.binary;
  if (!record(binary) || !exact(binary, ['path', 'sha256']) || !absolute(binary.path) || !binary.path.endsWith('.node') || !sha(binary.sha256)) throw new PlacementProvenanceError('binary');
  if (!sha(input.sourceSHA256)) throw new PlacementProvenanceError('source');
  const headers = input.headers;
  if (!Array.isArray(headers) || headers.length !== HEADER_NAMES.length || !headers.every((h, i) => record(h) && exact(h, ['name', 'sha256']) && h.name === HEADER_NAMES[i] && sha(h.sha256))) throw new PlacementProvenanceError('headers');
  if (!text(input.compiler) || !text(input.sdk) || !Array.isArray(input.command) || input.command.length === 0 || !input.command.every(part => text(part))) throw new PlacementProvenanceError('toolchain');
  if (!text(input.node, 32) || input.napi !== 10 || (input.arch !== 'arm64' && input.arch !== 'x86_64') || input.platform !== 'darwin' || !text(input.osRelease, 32) || input.deploymentTarget !== '13.0') throw new PlacementProvenanceError('target');
  if (!text(input.buildReceipt, 1024)) throw new PlacementProvenanceError('build-receipt');
  return input as unknown as PlacementOwnerProvenance;
}

/**
 * Matches the explicit binding selection, pinned source and the independently
 * observed current runtime. Any mismatch is a qualified-host refusal, never an
 * ordinary fallback. Returns the provenance record's own SHA-256.
 */
export function verifyPlacementOwnerProvenance(provenancePath: string, binding: PlacementOwnerBindingInput, host: PlacementHostFacts): { provenance: PlacementOwnerProvenance; provenanceSHA256: string } {
  if (!absolute(provenancePath)) throw new PlacementProvenanceError('path');
  let bytes: Buffer;
  try { bytes = readFileSync(provenancePath); } catch { throw new PlacementProvenanceError('unreadable'); }
  if (bytes.length > 64 * 1024) throw new PlacementProvenanceError('size');
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new PlacementProvenanceError('json'); }
  const provenance = parsePlacementOwnerProvenance(parsed);
  if (provenance.binary.path !== binding.path || provenance.binary.sha256 !== binding.sha256) throw new PlacementProvenanceError('binding-selection');
  if (provenance.sourceSHA256 !== PLACEMENT_OWNER_SOURCE_SHA256) throw new PlacementProvenanceError('source-digest');
  const arch = provenance.arch === 'x86_64' ? 'x64' : provenance.arch;
  if (provenance.node !== host.node || arch !== host.arch || provenance.platform !== host.platform || provenance.osRelease !== host.osRelease) throw new PlacementProvenanceError('runtime-identity');
  return { provenance, provenanceSHA256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Explicit developer build outside daemon startup. Writes the binary and an
 * exclusively created provenance record; it never selects or loads either.
 */
export async function buildPlacementOwnerWithProvenance(input: { sourcePath: string; outputPath: string; nodeIncludeDir: string; arch: 'arm64' | 'x86_64'; provenancePath: string; osRelease: string; buildReceipt: string }): Promise<PlacementOwnerProvenance> {
  const build = await buildDarwinPlacementOwner(input);
  const provenance: PlacementOwnerProvenance = {
    schema: PLACEMENT_OWNER_PROVENANCE_SCHEMA, binary: { path: build.path, sha256: build.sha256 }, sourceSHA256: build.sourceSHA256,
    headers: build.headers.map(header => ({ name: basename(header.path), sha256: header.sha256 })),
    compiler: build.compiler, sdk: build.sdk, command: build.command, node: build.node, napi: 10, arch: build.arch, platform: 'darwin',
    osRelease: input.osRelease, deploymentTarget: '13.0', buildReceipt: input.buildReceipt,
  };
  parsePlacementOwnerProvenance(provenance);
  await writeFile(input.provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return provenance;
}
