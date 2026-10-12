// Bundled capability integrity gate (design:
// `docs/superpowers/specs/2026-09-13-agency-capability-restoration-design.md`,
// integrity contract 1-4).
//
// Hosted under `e2e/tests/` per the root `AGENTS.md` boundary rule:
// cross-app / cross-resource consistency checks that observe more than one
// app, package, or resource boundary belong here, and no app's private `src/`
// may be imported as a shared helper.
//
// Evidence is repository-visible only:
//   - scenario + atom manifests under `plugins/_official/`
//   - the shared default-route table exported by `@open-design/contracts`
//   - `apps/daemon/src/plugins/atoms.ts` read as TEXT for the built-in atom
//     registry (`docs/atoms.md` names that file the catalog source of truth).
//
// The gate is written against the desired post-restoration state, so it is
// expected to be red until the curated scenarios, atoms, and routing land.

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCENARIO_PLUGIN_BY_KIND,
  DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND,
  DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
  defaultScenarioPluginIdForProjectMetadata,
  type DefaultScenarioPluginId,
  type ProjectKind,
  type ProjectMetadata,
} from '@open-design/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  findUnresolvedPipelineAtoms,
  parseFirstPartyAtomIds,
  readPluginManifest,
  readPluginManifests,
  resolvePipelineAtom,
  type BundledPluginManifest,
} from '@/plugins/bundled-integrity';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OFFICIAL_ROOT = path.join(repoRoot, 'plugins', '_official');
const SCENARIOS_ROOT = path.join(OFFICIAL_ROOT, 'scenarios');
const ATOMS_ROOT = path.join(OFFICIAL_ROOT, 'atoms');
const EXAMPLES_ROOT = path.join(OFFICIAL_ROOT, 'examples');
const DESIGN_SYSTEMS_ROOT = path.join(repoRoot, 'design-systems');
const BUNDLED_DESIGN_SYSTEMS_ROOT = path.join(OFFICIAL_ROOT, 'design-systems');
const BUILT_IN_ATOM_CATALOG = path.join(repoRoot, 'apps', 'daemon', 'src', 'plugins', 'atoms.ts');

// Exact curated roster from the design doc's product boundary: the four
// retained core scenarios, the three restored core scenarios, and the two
// restored advanced agency scenarios. Everything else (Community,
// HyperFrames, WebGL demos, share/export, `od-design-refine`, unselected
// examples) stays removed, so the roster is an equality — not a superset.
const CURATED_SCENARIO_IDS: string[] = [
  'od-code-migration',
  'od-default',
  'od-figma-migration',
  'od-media-generation',
  'od-new-generation',
  'od-next-strategy',
  'od-plugin-authoring',
  'od-tune-collab',
  'od-web-effect-extractor',
].sort();

const CURATED_ATOM_IDS: string[] = [
  'build-test',
  'code-import',
  'critique-theater',
  'design-extract',
  'diff-review',
  'direction-picker',
  'discovery-question-form',
  'figma-extract',
  'handoff',
  'patch-edit',
  'rewrite-plan',
  'todo-write',
  'token-map',
].sort();

// The five brand-derived systems (airbnb, apple, linear-app, stripe, vercel)
// were removed on 2026-09-23; see docs/legal/LICENSE-COMPLIANCE.md.
const CURATED_DESIGN_SYSTEM_IDS: string[] = [
  // First original agency archetype (Wave 0); see docs/plans/2026-09-22-design-system-wave-0.md.
  'neutral-product',
].sort();

// Every `ProjectMetadata['intent']` value, so the routing check exercises the
// whole intent axis rather than the subset that happens to be interesting
// today. `hyperframes` is included on purpose: before HyperFrames routing is
// retired it selects `example-hyperframes` (which must not be on disk), and
// afterwards it resolves to no default plugin.
const INTENT_PROBES: ReadonlyArray<NonNullable<ProjectMetadata['intent']>> = [
  'live-artifact',
  'web-clone',
  'document',
  'webgl-experience',
  'worker-visualizer',
  'marketing',
  'hyperframes',
];

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function readBuiltInAtomIds(): Promise<Set<string>> {
  const source = await fsp.readFile(BUILT_IN_ATOM_CATALOG, 'utf8');
  return new Set(parseFirstPartyAtomIds(source));
}

async function readBundledAtomIds(): Promise<Set<string>> {
  const atoms = await readPluginManifests(ATOMS_ROOT);
  return new Set(atoms.map((atom) => atom.id));
}

/**
 * Every scenario id the shared default-route table can select: the unselected
 * fallback, the per-kind and per-task-kind maps, and the intent-aware
 * metadata resolver across every kind/intent pair.
 */
function selectedDefaultScenarioIds(): DefaultScenarioPluginId[] {
  const selected = new Set<DefaultScenarioPluginId>([DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID]);
  for (const id of Object.values(DEFAULT_SCENARIO_PLUGIN_BY_KIND)) selected.add(id);
  for (const id of Object.values(DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND)) selected.add(id);
  for (const kind of Object.keys(DEFAULT_SCENARIO_PLUGIN_BY_KIND) as ProjectKind[]) {
    for (const intent of INTENT_PROBES) {
      const id = defaultScenarioPluginIdForProjectMetadata({ kind, intent });
      if (id) selected.add(id);
    }
  }
  return [...selected];
}

describe('bundled capability integrity', () => {
  it('bundles exactly the nine curated scenario ids, each with a matching manifest', async () => {
    const entries = await fsp.readdir(SCENARIOS_ROOT, { withFileTypes: true });
    const folderIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

    expect(
      folderIds,
      'plugins/_official/scenarios must hold exactly the curated roster from the design doc',
    ).toEqual(CURATED_SCENARIO_IDS);

    for (const id of CURATED_SCENARIO_IDS) {
      const manifest = await readPluginManifest(path.join(SCENARIOS_ROOT, id));
      expect(manifest, `plugins/_official/scenarios/${id} must ship open-design.json`).not.toBeNull();
      expect(
        manifest?.id,
        `plugins/_official/scenarios/${id} manifest name must match its folder id`,
      ).toBe(id);
    }
  });

  it('bundles exactly the 13 first-party pipeline atom ids', async () => {
    const entries = await fsp.readdir(ATOMS_ROOT, { withFileTypes: true });
    const folderIds = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort();

    expect(folderIds, 'plugins/_official/atoms must hold exactly the curated dependency roster').toEqual(
      CURATED_ATOM_IDS,
    );
  });

  it('bundles exactly the curated design systems in both catalog mirrors', async () => {
    for (const root of [DESIGN_SYSTEMS_ROOT, BUNDLED_DESIGN_SYSTEMS_ROOT]) {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const folderIds = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
        .map((entry) => entry.name)
        .sort();

      expect(folderIds, `${path.relative(repoRoot, root)} must hold exactly the curated roster`).toEqual(
        CURATED_DESIGN_SYSTEM_IDS,
      );
    }
  });

  it('resolves every scenario id selected by the shared default routes to an on-disk plugin manifest', async () => {
    const [scenarioManifests, exampleManifests] = await Promise.all([
      readPluginManifests(SCENARIOS_ROOT),
      readPluginManifests(EXAMPLES_ROOT),
    ]);
    const onDiskIds = new Set(
      [...scenarioManifests, ...exampleManifests].map((manifest) => manifest.id),
    );

    const missing = selectedDefaultScenarioIds()
      .filter((id) => !onDiskIds.has(id))
      .sort();

    expect(
      missing,
      'shared default routing selects scenario ids with no on-disk plugin manifest',
    ).toEqual([]);
  });

  it('resolves every pipeline atom in the retained scenarios to a bundled atom manifest or a built-in atom', async () => {
    const builtInAtomIds = await readBuiltInAtomIds();
    const bundledAtomIds = await readBundledAtomIds();

    const scenarioManifests = await readPluginManifests(SCENARIOS_ROOT);
    const exampleManifests = await readPluginManifests(EXAMPLES_ROOT);
    const routedIds = new Set<string>(selectedDefaultScenarioIds());
    // Retained scenarios = every curated scenario folder plus every example the
    // default routes still bind (today `example-web-prototype` /
    // `example-web-clone`).
    const retained: BundledPluginManifest[] = [
      ...scenarioManifests,
      ...exampleManifests.filter((manifest) => routedIds.has(manifest.id)),
    ];

    const atomReferenceCount = retained.reduce(
      (count, manifest) => count + manifest.pipelineAtomIds.length,
      0,
    );
    expect(
      atomReferenceCount,
      'retained scenarios must declare pipeline atoms, otherwise the closure check is vacuous',
    ).toBeGreaterThan(0);

    const unresolved = findUnresolvedPipelineAtoms({
      plugins: retained,
      bundledAtomIds,
      builtInAtomIds,
    });

    expect(
      unresolved,
      'pipeline atoms must ship a bundled manifest or be registered built-in atoms',
    ).toEqual([]);
  });

  it('declares the figma connector and files.get tool in od-figma-migration', async () => {
    const manifest = await readPluginManifest(path.join(SCENARIOS_ROOT, 'od-figma-migration'));
    if (!manifest) {
      throw new Error('plugins/_official/scenarios/od-figma-migration/open-design.json is missing');
    }

    const figma = manifest.requiredConnectors.find((connector) => connector.id === 'figma');
    expect(
      figma,
      'od-figma-migration must declare `figma` under od.connectors.required',
    ).toBeDefined();
    expect(
      figma?.tools ?? [],
      'od-figma-migration must declare the `files.get` tool on the figma connector',
    ).toContain('files.get');
  });

  describe('negative fixture', () => {
    it('reports an unresolved pipeline atom instead of ignoring it', async () => {
      const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-bundled-integrity-'));
      tempRoots.push(fixtureRoot);
      const fixtureFolder = path.join(fixtureRoot, 'fixture-unresolved-atom');
      await fsp.mkdir(fixtureFolder, { recursive: true });
      await fsp.writeFile(
        path.join(fixtureFolder, 'open-design.json'),
        JSON.stringify({
          name: 'fixture-unresolved-atom',
          version: '0.0.0',
          od: {
            kind: 'scenario',
            pipeline: {
              stages: [{ id: 'generate', atoms: ['file-write', 'definitely-not-a-real-atom'] }],
            },
          },
        }),
      );

      const fixtures = await readPluginManifests(fixtureRoot);
      expect(fixtures.map((fixture) => fixture.id)).toEqual(['fixture-unresolved-atom']);

      const builtInAtomIds = new Set(['file-write']);
      expect(
        resolvePipelineAtom({
          atomId: 'file-write',
          bundledAtomIds: new Set(),
          builtInAtomIds,
        }),
      ).toEqual({ atomId: 'file-write', resolved: true, source: 'built-in-registry' });
      expect(
        resolvePipelineAtom({
          atomId: 'definitely-not-a-real-atom',
          bundledAtomIds: new Set(),
          builtInAtomIds,
        }),
      ).toEqual({ atomId: 'definitely-not-a-real-atom', resolved: false, source: null });

      expect(
        findUnresolvedPipelineAtoms({
          plugins: fixtures,
          bundledAtomIds: new Set(),
          builtInAtomIds,
        }),
      ).toEqual([{ pluginId: 'fixture-unresolved-atom', atomId: 'definitely-not-a-real-atom' }]);
    });
  });
});
