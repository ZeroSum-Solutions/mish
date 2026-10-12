// Agency capability restoration (2026-09-13) — curated scenario roster.
//
// The repo's plugins/_official/scenarios/ directory is the v1 source of
// truth for first-party scenario SKILL.md bundles. The clean-slate
// catalog intentionally keeps this list small: the four retained core
// scenarios plus the five restored core/advanced agency scenarios, and
// nothing else. This test pins that roster so a future PR can't
// silently re-add Community, export, WebGL, HyperFrames, or
// `od-design-refine` content, nor drop an approved scenario.
//
// We assert the on-disk inventory rather than any daemon-side catalog:
// the folder set is the publishable plugin substrate the routed
// scenarios resolve against.

import path from 'node:path';
import url from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const scenariosRoot = path.join(repoRoot, 'plugins', '_official', 'scenarios');

// Retained core scenarios (already installed before restoration).
const RETAINED_CORE_SCENARIOS = [
  'od-media-generation',
  'od-new-generation',
  'od-next-strategy',
  'od-web-effect-extractor',
];

// Restored core scenarios.
const RESTORED_CORE_SCENARIOS = [
  'od-default',
  'od-plugin-authoring',
  'od-figma-migration',
];

// Restored advanced agency scenarios.
const RESTORED_ADVANCED_SCENARIOS = [
  'od-code-migration',
  'od-tune-collab',
];

const EXPECTED_SCENARIOS = [
  ...RETAINED_CORE_SCENARIOS,
  ...RESTORED_CORE_SCENARIOS,
  ...RESTORED_ADVANCED_SCENARIOS,
].sort();

describe('plugins/_official/scenarios roster', () => {
  it('contains exactly the curated first-party scenario ids', async () => {
    const entries = await readdir(scenariosRoot, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(dirs).toEqual(EXPECTED_SCENARIOS);
  });

  it('every scenario folder ships SKILL.md + mish.json', async () => {
    for (const id of EXPECTED_SCENARIOS) {
      const folder = path.join(scenariosRoot, id);
      const skill = await stat(path.join(folder, 'SKILL.md'));
      const manifest = await stat(path.join(folder, 'mish.json'));
      expect(skill.isFile()).toBe(true);
      expect(manifest.isFile()).toBe(true);
    }
  });

  it('keeps retired catalog content out of the scenario roster', async () => {
    const retired = [
      'od-design-refine',
      'od-nextjs-export',
      'od-react-export',
      'od-vue-export',
      'od-share-to-community',
    ];
    const entries = await readdir(scenariosRoot, { withFileTypes: true });
    const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const id of retired) {
      expect(dirs.has(id)).toBe(false);
    }
  });
});
