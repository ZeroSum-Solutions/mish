import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { ResourceResult } from '@open-design/contracts';
import { parseNativeFormatRefusalDetails } from '@open-design/contracts';
import { searchResources, createLocalResourceSources } from '../../src/workbench/resources.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';
import { adoptionFixture, adoptionServer, closeAll, post } from './adoption-route-fixture.js';

/**
 * AC-R18.7 / AC-R18.8: candidates 44 (svelte-animations), 45 (cnblocks) and 46
 * (animations) are reference-only for the accepted HTML/React targets. Discovery
 * and inspect show the exact repository/commit, native Svelte format, target
 * mismatch and deferred need; plan/apply refuse with 422 unsupported-capability
 * (carrying needDecision/needReason) after authority and revision checks, and
 * metadata alone never passes apply. Same results through HTTP and od.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => closeAll(servers, roots));

const TRIO = ['svelte-animations', 'cnblocks', 'animations'] as const;
const COMMITS = {
  'svelte-animations': '74a6e2c0973c284005a69a013c28c7259842e34f',
  cnblocks: '81c7209fc9696bd7823911a4b9d076f657202ef4',
  animations: 'c0e5d02b35caf88bb09bd72a3e9c49031e1657ea',
} as const;
const REGISTRY_SHA = {
  normal: 'e6d047e76284ce4a8a35b05729d3a8e696e02f6b788526fa67a40a67a86792b0',
  mist: 'b14f12d53b3bdddb464c9b60dc63d8892842022fa3d47055588e28271e38278c',
  veil: '4c152d5298fe2b9992983fcb484bd323c1f9b0b9955c1e0d96cac6b8a2f050b7',
} as const;

const sources = () => createLocalResourceSources({ listPlugins: async () => [] });
async function trio(): Promise<{ results: ResourceResult[]; statuses: Awaited<ReturnType<typeof searchResources>>['sourceStatuses'] }> {
  const response = await searchResources({ query: '', facets: { sourceIds: [...TRIO] }, limit: 100 }, { principalId: 'local-daemon' }, sources());
  return { results: response.results, statuses: response.sourceStatuses };
}

describe('reference-only Svelte trio discovery (AC-R18.7, AC-R18.8)', () => {
  it('every source is searched and every item is an attributed reference with the native format and target mismatch', async () => {
    const { results, statuses } = await trio();
    for (const id of TRIO) {
      const status = statuses.find(item => item.sourceId === id)!;
      expect(status.state).toBe('searched');
      expect(status.itemCount).toBeGreaterThan(0);
    }
    expect(results.length).toBeGreaterThan(0);
    for (const item of results) {
      expect(item.readiness).toBe('reference-only');
      expect(item.admissionStage).toBe('reference-only');
      expect(item.compatibility).toMatchObject({ nativeFormat: 'svelte', targets: [], state: 'unsupported' });
      expect(item.compatibility.reason).toMatch(/HTML\/CSS\/JS and React/);
      expect(item.needDecision).toBe('reference-only');
      expect(item.needReason).toMatch(/G24/);
      expect(item.adoptionCapability).toEqual({ available: false, reason: 'unsupported-capability' });
      expect(item.previewCapability.kind).not.toBe('html');
      expect(item.acceptanceEvidence).toBeUndefined();
      const identity = item.sourceIdentity!;
      expect(identity.acquisitionMode).toBe('reference-link');
      expect(identity.repositoryUrl).toBe(`https://github.com/SikandarJODD/${item.ref.sourceId}`);
      expect(identity.commit).toBe(COMMITS[item.ref.sourceId as keyof typeof COMMITS]);
      expect(item.ref.revisionOrDigest.startsWith(`${identity.commit}:sha256:`)).toBe(true);
      expect(item.sourceAttribution.url).toBe(identity.repositoryUrl);
    }
  });

  it('cnblocks identity is collection-scoped: hero-one in Normal, Mist and Veil are three distinct references', async () => {
    const { results } = await trio();
    const heroes = results.filter(item => item.ref.sourceId === 'cnblocks' && item.ref.itemId.endsWith('/hero-one'));
    expect(heroes.map(item => item.ref.itemId).sort()).toEqual(['mist/hero-one', 'normal/hero-one', 'veil/hero-one']);
    expect(new Set(heroes.map(item => item.refKey)).size).toBe(3);
    for (const hero of heroes) {
      const collection = hero.ref.itemId.split('/')[0] as keyof typeof REGISTRY_SHA;
      expect(hero.ref.revisionOrDigest).toBe(`${COMMITS.cnblocks}:sha256:${REGISTRY_SHA[collection]}`);
      expect(hero.title).toMatch(new RegExp(collection, 'i'));
    }
  });

  it('cnblocks documents a generic jsrepo MCP that stays documented and unexecuted, never an installed connector', async () => {
    const { results, statuses } = await trio();
    for (const item of results.filter(entry => entry.ref.sourceId === 'cnblocks')) {
      expect(item.sourceIdentity?.documentedConnector).toMatchObject({ name: expect.stringMatching(/jsrepo/), state: 'documented-unexecuted' });
    }
    expect(statuses.find(status => status.sourceId === 'cnblocks')?.reason).toMatch(/222 registry entries/);
  });

  it('candidate 44 is retained once and points to its candidate 46 successor without being replaced by it', async () => {
    const { results } = await trio();
    const keys = results.map(item => item.refKey);
    expect(new Set(keys).size).toBe(keys.length);
    const old = results.filter(item => item.ref.sourceId === 'svelte-animations');
    const successor = results.filter(item => item.ref.sourceId === 'animations');
    expect(old.length).toBeGreaterThan(0); expect(successor.length).toBeGreaterThan(0);
    const linked = old.flatMap(item => item.relatedRefs ?? []).filter(link => link.relation === 'successor-candidate');
    expect(linked.length).toBeGreaterThan(0);
    for (const link of linked) expect(successor.some(item => resourceRefKey(item.ref) === resourceRefKey(link.ref))).toBe(true);
  });
});

describe('inspect, plan and apply refusals through HTTP and od (AC-R18.7, AC-R18.8)', () => {
  async function setup() {
    const f = adoptionFixture(roots);
    const url = await adoptionServer(servers, f, { sources: sources(), allowed: ['p1', 'p2'] });
    const veil = (await trio()).results.find(item => item.ref.itemId === 'veil/hero-one')!;
    return { f, url, veil };
  }

  it('inspect returns the same reference over HTTP and od', async () => {
    const { url, veil } = await setup();
    const http = await (await fetch(`${url}/api/workbench/resources/${veil.refKey}`)).json() as any;
    let cli: any; const code = await runWorkbenchCli(['inspect', '--ref', veil.refKey, '--json'], { baseUrl: url, write: value => { cli = value; } });
    expect(code).toBe(0);
    expect(cli).toEqual(http);
    expect(http.resource).toMatchObject({ readiness: 'reference-only', compatibility: { nativeFormat: 'svelte', state: 'unsupported' }, needDecision: 'reference-only' });
  });

  it('catalogue plan refuses with 422 unsupported-capability, carrying the need decision, and writes nothing', async () => {
    const { f, url, veil } = await setup();
    const before = f.tree('p1');
    const refused = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey: veil.refKey, entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(422);
    const details = parseNativeFormatRefusalDetails(refused.body.error.details);
    expect(details).toMatchObject({ reason: 'unsupported-capability', nativeFormat: 'svelte', needDecision: 'reference-only' });
    expect(details.supportedTargets).toEqual(['html', 'react']);
    expect(details.needReason).toMatch(/G24/);
    let cli: any; const code = await runAdoptionCli(['catalogue-prepare', '--ref', veil.refKey, '--project', 'p1', '--entry', 'src/App.tsx', '--json'], { baseUrl: url, write: value => { cli = value; } });
    expect(code).toBe(3);
    expect(cli.error.details).toEqual(refused.body.error.details);
    expect(f.tree('p1')).toEqual(before);
    expect(f.storedPlans()).toBe(0);
  });

  it('authority and revision are checked before the target format', async () => {
    const { url, veil } = await setup();
    const forbidden = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p9', refKey: veil.refKey, entryPath: 'src/App.tsx' });
    expect(forbidden.status).toBe(403);
    const staleKey = resourceRefKey({ ...veil.ref, revisionOrDigest: `${COMMITS.cnblocks}:sha256:${'0'.repeat(64)}` });
    const stale = await post(`${url}/api/workbench/adoption/catalogue/prepare`, { projectId: 'p1', refKey: staleKey, entryPath: 'src/App.tsx' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.reason).toBe('resource-ref-stale');
    expect(stale.body.error.details.currentRefKey).toBe(veil.refKey);
  });

  it('a hand-written plan that cites a native Svelte reference cannot pass apply by metadata alone', async () => {
    const { f, url, veil } = await setup();
    const draft = {
      projectId: 'p2', entryPath: 'src/App.tsx', source: { implementationOrigin: 'adapted', resourceRef: veil.ref },
      writes: [
        { path: 'src/Hero.tsx', role: 'source', contentBase64: Buffer.from('export const Hero = () => null;\n').toString('base64') },
        { path: 'src/App.tsx', role: 'entry', contentBase64: Buffer.from('import { Hero } from "./Hero";\nexport default function App() { return <Hero />; }\n').toString('base64') },
      ],
    };
    const refused = await post(`${url}/api/workbench/adoption/prepare`, draft);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toMatchObject({ reason: 'unsupported-capability', needDecision: 'reference-only' });
    expect(f.tree('p2')['src/Hero.tsx']).toBeUndefined();
    expect(f.storedPlans()).toBe(0);
  });
});
