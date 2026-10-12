import { describe, expect, it } from 'vitest';
import { demoDocument } from '@open-design/genui-catalog/data';
import { createLocalResourceSources } from '../../src/workbench/resources.js';

/**
 * AC-R07 preamble: "selected WebGL adapters" join the Enlarge readiness/error checks. Selection
 * is evidence-based: a GenUI demo whose own document requests a WebGL context is offered under
 * the `webgl` adapter family, so the Enlarge host runs its WebGL availability and context-loss
 * checks and fails closed to a labelled fallback. Every other demo stays a plain HTML document.
 */
const WEBGL = /getContext\(\s*["'`](?:webgl2?|experimental-webgl)["'`]/;

describe('GenUI WebGL preview adapter selection', () => {
  it('marks exactly the demos that request a WebGL context', async () => {
    const source = createLocalResourceSources({ listPlugins: async () => [] }).find(s => s.sourceId === 'genui')!;
    const { items } = await source.list({ principalId: 'local-daemon' });
    const previewable = items.filter(item => item.previewCapability.available);
    const webgl = previewable.filter(item => item.previewCapability.adapter === 'webgl').map(item => item.ref.itemId).sort();
    const expected = previewable.filter(item => WEBGL.test(demoDocument(item.ref.itemId) ?? '')).map(item => item.ref.itemId).sort();
    expect(expected).toEqual(expect.arrayContaining(['atc-shader', 'silk']));
    expect(webgl).toEqual(expected);
    for (const item of previewable.filter(item => !expected.includes(item.ref.itemId))) expect(item.previewCapability.adapter).toBe('html-document');
  });
});
