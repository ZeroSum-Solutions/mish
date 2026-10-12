// Bundled capability integrity helpers.
//
// These helpers turn the bundled capability layer into an inspectable
// dependency graph: on-disk scenario manifests declare pipeline atoms, and an
// atom is legitimate only when it has a bundled atom manifest or is a
// registered first-party built-in atom. Callers pass repository roots and
// already-read source text, so the helpers stay pure and never import an app's
// private implementation as a shared helper (root `AGENTS.md` boundary).
//
// Evidence sources are deliberately repository-visible:
//   - `plugins/_official/**/mish.json` manifests (scenario + atom)
//   - `apps/daemon/src/plugins/atoms.ts` read as TEXT for the built-in atom
//     registry, which `docs/atoms.md` names the catalog source of truth.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const MANIFEST_FILENAME = 'mish.json';

// The array declaration that owns the first-party built-in atom catalog. The
// parser is intentionally strict: a rename or restructure must fail loudly
// rather than silently yield an empty registry that would make every atom
// look unresolved.
const FIRST_PARTY_ATOMS_MARKER = 'export const FIRST_PARTY_ATOMS';
const FIRST_PARTY_ATOMS_TERMINATOR = '\n];';

export type BundledAtomResolutionSource = 'bundled-manifest' | 'built-in-registry';

export interface RequiredConnectorRef {
  id: string;
  tools: string[];
}

export interface BundledPluginManifest {
  /** Manifest `name`, the id routing and snapshots bind to. */
  id: string;
  /** Absolute folder the manifest was read from. */
  folder: string;
  /** Flattened `od.pipeline.stages[*].atoms[]` in declaration order. */
  pipelineAtomIds: string[];
  /** `od.context.atoms[]` when the manifest declares a context atom list. */
  contextAtomIds: string[];
  /** `od.connectors.required[]` normalized to `{ id, tools }`. */
  requiredConnectors: RequiredConnectorRef[];
}

export interface AtomResolution {
  atomId: string;
  resolved: boolean;
  source: BundledAtomResolutionSource | null;
}

export interface UnresolvedPipelineAtom {
  pluginId: string;
  atomId: string;
}

export interface AtomClosureInput {
  plugins: ReadonlyArray<BundledPluginManifest>;
  /** Ids that ship an on-disk atom manifest under `plugins/_official/atoms/`. */
  bundledAtomIds: ReadonlySet<string>;
  /** Ids registered in the first-party built-in atom catalog. */
  builtInAtomIds: ReadonlySet<string>;
}

export interface AtomResolutionInput {
  atomId: string;
  bundledAtomIds: ReadonlySet<string>;
  builtInAtomIds: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read every immediate child directory of `root` that ships an
 * `mish.json`. Directories without a manifest are skipped — the bundled
 * walker supports both `<root>/<plugin>/` and `<root>/<tier>/<plugin>/`, and
 * callers pass the tier folder. Results are sorted by id so failure output is
 * stable.
 */
export async function readPluginManifests(root: string): Promise<BundledPluginManifest[]> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const manifests: BundledPluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readPluginManifest(path.join(root, entry.name));
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read a single plugin folder's manifest, or null when it ships none. */
export async function readPluginManifest(folder: string): Promise<BundledPluginManifest | null> {
  const manifestPath = path.join(folder, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`${manifestPath} does not declare a non-empty string "name"`);
  }

  return {
    id: parsed.name,
    folder,
    pipelineAtomIds: extractPipelineAtomIds(parsed),
    contextAtomIds: extractContextAtomIds(parsed),
    requiredConnectors: extractRequiredConnectors(parsed),
  };
}

/** Flatten `od.pipeline.stages[*].atoms[]` in declaration order. */
export function extractPipelineAtomIds(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const od = manifest.od;
  if (!isRecord(od)) return [];
  const pipeline = od.pipeline;
  if (!isRecord(pipeline)) return [];
  const stages = pipeline.stages;
  if (!Array.isArray(stages)) return [];

  const atomIds: string[] = [];
  for (const stage of stages) {
    if (!isRecord(stage)) continue;
    const atoms = stage.atoms;
    if (!Array.isArray(atoms)) continue;
    for (const atom of atoms) {
      if (typeof atom === 'string' && atom.length > 0) atomIds.push(atom);
    }
  }
  return atomIds;
}

/** Read `od.context.atoms[]` when the manifest declares one. */
export function extractContextAtomIds(manifest: unknown): string[] {
  if (!isRecord(manifest)) return [];
  const od = manifest.od;
  if (!isRecord(od)) return [];
  const context = od.context;
  if (!isRecord(context)) return [];
  const atoms = context.atoms;
  if (!Array.isArray(atoms)) return [];
  return atoms.filter((atom): atom is string => typeof atom === 'string' && atom.length > 0);
}

/** Normalize `od.connectors.required[]` into `{ id, tools }` pairs. */
export function extractRequiredConnectors(manifest: unknown): RequiredConnectorRef[] {
  if (!isRecord(manifest)) return [];
  const od = manifest.od;
  if (!isRecord(od)) return [];
  const connectors = od.connectors;
  if (!isRecord(connectors)) return [];
  const required = connectors.required;
  if (!Array.isArray(required)) return [];

  const refs: RequiredConnectorRef[] = [];
  for (const entry of required) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const tools = Array.isArray(entry.tools)
      ? entry.tools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    refs.push({ id: entry.id, tools });
  }
  return refs;
}

/**
 * Extract the first-party built-in atom ids from the catalog source text.
 *
 * The daemon module is app-private, so the integrity test reads its source as
 * evidence instead of importing it; `docs/atoms.md` names this file the catalog
 * source of truth. Throws when the array shape has moved, because an empty
 * registry would otherwise make the closure check vacuous in the unsafe
 * direction (everything unresolved) or hide a parser drift (everything
 * resolved).
 */
export function parseFirstPartyAtomIds(sourceText: string): string[] {
  const start = sourceText.indexOf(FIRST_PARTY_ATOMS_MARKER);
  if (start < 0) {
    throw new Error(
      `built-in atom catalog is missing the "${FIRST_PARTY_ATOMS_MARKER}" array declaration`,
    );
  }
  const end = sourceText.indexOf(FIRST_PARTY_ATOMS_TERMINATOR, start);
  if (end < 0) {
    throw new Error('built-in atom catalog array terminator not found; parser needs updating');
  }

  const ids: string[] = [];
  for (const match of sourceText.slice(start, end).matchAll(/id:\s*'([^']+)'/g)) {
    const id = match[1];
    if (id !== undefined && id.length > 0) ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error('built-in atom catalog parsed to an empty registry');
  }
  return ids;
}

/**
 * Resolve one pipeline atom id to a bundled atom manifest or a registered
 * first-party built-in atom. An id that resolves to neither is unresolved —
 * never silently dropped.
 */
export function resolvePipelineAtom(input: AtomResolutionInput): AtomResolution {
  if (input.bundledAtomIds.has(input.atomId)) {
    return { atomId: input.atomId, resolved: true, source: 'bundled-manifest' };
  }
  if (input.builtInAtomIds.has(input.atomId)) {
    return { atomId: input.atomId, resolved: true, source: 'built-in-registry' };
  }
  return { atomId: input.atomId, resolved: false, source: null };
}

/**
 * Report every pipeline atom in every plugin that resolves to nothing. Empty
 * means the retained dependency closure is complete.
 */
export function findUnresolvedPipelineAtoms(input: AtomClosureInput): UnresolvedPipelineAtom[] {
  const unresolved: UnresolvedPipelineAtom[] = [];
  for (const plugin of input.plugins) {
    for (const atomId of new Set(plugin.pipelineAtomIds)) {
      const resolution = resolvePipelineAtom({
        atomId,
        bundledAtomIds: input.bundledAtomIds,
        builtInAtomIds: input.builtInAtomIds,
      });
      if (!resolution.resolved) unresolved.push({ pluginId: plugin.id, atomId });
    }
  }
  return unresolved;
}
