import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesignBriefModelOutput, ResourceRef } from '@open-design/contracts';
import type { BriefGeneration, BriefGenerator, BriefGeneratorInput } from '../../src/workbench/brief/generator.js';
import type { DesignReferenceDocument, DesignReferenceSource } from '../../src/workbench/brief/references.js';

const field = (value: string | null, basis: 'stated' | 'context' | 'assumed' | 'user' | 'reference' = 'assumed') => ({ value, basis });

/** A schema-valid model answer; tests override the parts they exercise. */
export function modelOutput(overrides: Partial<DesignBriefModelOutput> = {}): DesignBriefModelOutput {
  return {
    audience: field('Local customers', 'stated'), purpose: field('Show the menu and hours', 'stated'), conversion: field(null),
    sections: [{ name: 'Hero', purpose: 'Name and promise', basis: 'assumed' }, { name: 'Menu', purpose: null, basis: 'stated' }],
    design: { typography: field('Readable serif headings'), color: field('Warm neutrals'), spacing: field('Generous'), layout: field('Single column'), motion: field('Subtle fades') },
    responsive: field('Single column on phones'), accessibility: field('WCAG AA contrast and visible focus'),
    implementationConstraints: [], intent: { styleDirections: [], targetRuntime: null },
    assumptions: ['Opening hours were not given'], questions: ['What is the main call to action?'], referenceChanges: [],
    ...overrides,
  };
}

/** Scripted stand-in for the subscription model lane: no provider is called. A plain string answer reports no model. */
export function fakeGenerator(answers: Array<string | BriefGeneration | ((input: BriefGeneratorInput) => string) | Error>): BriefGenerator & { calls: BriefGeneratorInput[] } {
  const calls: BriefGeneratorInput[] = [];
  return {
    id: 'fake', modelId: 'fake-model', billingLane: 'test-fixture', maxInputChars: 200_000, calls,
    async available() { return { available: true }; },
    async generate(input) {
      calls.push(input);
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer');
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return { text: next(input), reportedModel: null };
      return typeof next === 'string' ? { text: next, reportedModel: null } : next;
    },
  };
}

export const refOf = (itemId: string, revisionOrDigest = `sha-${itemId}`): ResourceRef => ({ sourceType: 'reference', sourceId: 'design-md', itemId, revisionOrDigest });

export function referenceDoc(itemId: string, overrides: Partial<DesignReferenceDocument> = {}): DesignReferenceDocument {
  return {
    ref: refOf(itemId), title: itemId[0]!.toUpperCase() + itemId.slice(1), attribution: `Awesome DESIGN.md · ${itemId} (MIT)`,
    review: 'reviewed', deriveFromReference: 'permitted', projectId: null,
    excerpt: `${itemId} uses calm neutral surfaces with one saturated accent.`,
    tokens: { colors: [{ role: 'text', value: '#111111' }, { role: 'background', value: '#ffffff' }, { role: 'accent', value: '#635bff' }], fonts: [{ role: 'display', family: 'Inter' }] },
    ...overrides,
  };
}

/** In-memory reference source with the stale/unknown/forbidden answers the routes must map. */
export function referenceSource(docs: DesignReferenceDocument[]): DesignReferenceSource {
  return {
    async resolve(ref, context) {
      const doc = docs.find(item => item.ref.sourceId === ref.sourceId && item.ref.itemId === ref.itemId);
      if (!doc) return { kind: 'unknown' };
      if (doc.projectId && doc.projectId !== context.projectId) return { kind: 'forbidden' };
      if (doc.ref.revisionOrDigest !== ref.revisionOrDigest) return { kind: 'stale' };
      return { kind: 'found', document: doc };
    },
  };
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'od-brief-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
