// AC-R07 preamble / R07.1: the preview-adapter families, native video previews, target
// dependencies and the variant list are wire facts, so web, daemon and `od workbench inspect`
// read one shape.
import { describe, expect, it } from 'vitest';
import { PREVIEW_ADAPTER_FAMILIES, parseResourceDetailResponse } from '../src/api/workbench.js';

const resource = {
  ref: { sourceType: 'section', sourceId: 'sections', itemId: 'hyperui:application/charts/1', revisionOrDigest: 'sha256:abc' },
  refKey: 'opaque', title: 'Application Charts 1', category: 'section', readiness: 'unverified',
  compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: null },
  rightsStatus: 'unknown', fitReasons: [],
  previewCapability: { available: true, kind: 'html', url: '/api/sections/hyperui%3Aapplication%2Fcharts%2F1/preview', reason: null, adapter: 'compiled-html-section' },
  adoptionCapability: { available: false, reason: 'adapter-missing' },
  sourceAttribution: { title: 'hyperui' }, operationGrants: [],
  admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
};
const status = { sourceId: 'sections', state: 'searched', reason: null, itemCount: 1, listingDigest: 'abc' };
const detail = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ resource: { ...resource, ...patch }, sourceStatus: status, ...extra });

describe('preview adapter families', () => {
  it('names the compiled-section, styled-components and WebGL families next to plain HTML', () => {
    expect([...PREVIEW_ADAPTER_FAMILIES]).toEqual(['html-document', 'compiled-html-section', 'styled-components', 'webgl']);
    for (const adapter of PREVIEW_ADAPTER_FAMILIES) {
      expect(parseResourceDetailResponse(detail({ previewCapability: { ...resource.previewCapability, adapter } })).resource.previewCapability.adapter).toBe(adapter);
    }
  });
  it('refuses an unknown family and an adapter on a preview that is not an HTML document', () => {
    expect(() => parseResourceDetailResponse(detail({ previewCapability: { ...resource.previewCapability, adapter: 'tailwind-cdn' } }))).toThrow();
    expect(() => parseResourceDetailResponse(detail({ previewCapability: { available: false, kind: 'none', reason: 'adapter-missing', adapter: 'webgl' } }))).toThrow();
  });
});

describe('native video previews', () => {
  it('accepts a same-origin video preview', () => {
    const video = { available: true, kind: 'video', url: '/api/library/assets/clip/raw', reason: null };
    expect(parseResourceDetailResponse(detail({ category: 'video', previewCapability: video })).resource.previewCapability).toEqual(video);
  });
  it('refuses a remote or missing video source before any client loads it', () => {
    expect(() => parseResourceDetailResponse(detail({ category: 'video', previewCapability: { available: true, kind: 'video', url: 'https://cdn.example/clip.mp4', reason: null } }))).toThrow();
    expect(() => parseResourceDetailResponse(detail({ category: 'video', previewCapability: { available: true, kind: 'video', reason: null } }))).toThrow();
  });
});

describe('target dependencies and variants', () => {
  it('discloses the dependencies a variant brings into the target project', () => {
    const targetDependencies = [{ name: 'gsap', range: '^3.15.0', scope: 'project' }, { name: 'tailwindcss', range: '4.3.3', scope: 'compiled' }, { name: 'gsap', range: '3.15.0', scope: 'bundled' }];
    expect(parseResourceDetailResponse(detail({ targetDependencies })).resource.targetDependencies).toEqual(targetDependencies);
    expect(() => parseResourceDetailResponse(detail({ targetDependencies: [{ name: 'gsap', range: '^3', scope: 'cdn' }] }))).toThrow();
  });
  it('names a resource\'s place in its variant group', () => {
    expect(parseResourceDetailResponse(detail({ variantGroup: 'hyperui:application/charts', variantLabel: '1' })).resource.variantLabel).toBe('1');
    expect(() => parseResourceDetailResponse(detail({ variantLabel: '' }))).toThrow();
  });
  it('lists each variant with a current opaque key and marks exactly the inspected one', () => {
    const variants = [
      { refKey: 'opaque', title: 'Application Charts 1', label: '1', current: true, previewAvailable: true, targetDependencies: [] },
      { refKey: 'other', title: 'Application Charts 2', label: '2', current: false, previewAvailable: false, targetDependencies: [{ name: 'react', range: '>=17', scope: 'project' }] },
    ];
    expect(parseResourceDetailResponse(detail({}, { variants })).variants).toEqual(variants);
    expect(() => parseResourceDetailResponse(detail({}, { variants: variants.map(v => ({ ...v, current: false })) }))).toThrow();
    expect(() => parseResourceDetailResponse(detail({}, { variants: [{ ...variants[0], refKey: 'not-this-one' }, variants[1]] }))).toThrow();
  });
});
