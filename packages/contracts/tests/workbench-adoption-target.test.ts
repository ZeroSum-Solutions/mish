import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_TARGET_ADAPTERS, CATALOGUE_TARGET_REASONS, parseCatalogueAdoptionRequest, parseCatalogueSaveRequest, parseCatalogueSavedUnitResponse,
  parseCatalogueSavedUnitDeleteResponse, parseCatalogueSavedUnitsResponse, parseCatalogueTargetReport,
} from '../src/index.js';

// G02 (additive sibling of the catalogue report): which target adapter a
// prepared catalogue plan landed through, and what the project manifest said.
describe('catalogue target report (G02 react-source/v1, html-artifact/v1)', () => {
  const react = { adapter: 'react-source/v1', framework: 'react', reactMajor: 18, typescript: true, styleRuntime: 'tailwind4', dependencyDigest: 'a'.repeat(64) };
  it('accepts the two first-scope adapters and nothing else', () => {
    expect(CATALOGUE_TARGET_ADAPTERS).toEqual(['html-artifact/v1', 'react-source/v1']);
    expect(parseCatalogueTargetReport(react)).toEqual(react);
    expect(parseCatalogueTargetReport({ ...react, adapter: 'html-artifact/v1', framework: 'none', reactMajor: null, typescript: false, styleRuntime: 'unknown' })).toMatchObject({ adapter: 'html-artifact/v1' });
    // A 0.x React manifest is reported as declared (major 0) for a standalone HTML unit, not rejected on the wire.
    expect(parseCatalogueTargetReport({ ...react, adapter: 'html-artifact/v1', reactMajor: 0 })).toMatchObject({ reactMajor: 0 });
    expect(() => parseCatalogueTargetReport({ ...react, adapter: 'react-unit/v1' })).toThrow();
    expect(() => parseCatalogueTargetReport({ ...react, adapter: 'svelte-source/v1' })).toThrow();
  });
  it('a React source report must name a React major; unknown fields and malformed digests are refused', () => {
    expect(() => parseCatalogueTargetReport({ ...react, reactMajor: null })).toThrow();
    expect(() => parseCatalogueTargetReport({ ...react, dependencyDigest: 'x' })).toThrow();
    expect(() => parseCatalogueTargetReport({ ...react, installCommand: 'npm i gsap' })).toThrow();
  });
});

describe('catalogue target refusal reasons and saved units (W2, W4)', () => {
  it('names every typed target refusal reason', () => {
    expect(CATALOGUE_TARGET_REASONS).toEqual([
      'package-manifest-missing', 'target-not-react', 'target-ambiguous', 'react-version-unsupported',
      'react-version-unreadable', 'react-dom-missing', 'react-dom-mismatch', 'typescript-missing',
      // Sol B5/6 BLOCK: the installed react or react-dom could not be resolved inside the project root.
      'react-version-unresolved',
    ]);
  });
  it('Sol B5/6: a saved-unit delete answers the removed unit ID', () => {
    expect(parseCatalogueSavedUnitDeleteResponse({ deleted: 'a'.repeat(64) })).toEqual({ deleted: 'a'.repeat(64) });
    expect(() => parseCatalogueSavedUnitDeleteResponse({ deleted: 'not-an-id' })).toThrow();
  });
  it('a catalogue prepare may name a saved unit; save names the apply operation', () => {
    const id = 'a'.repeat(64);
    expect(parseCatalogueAdoptionRequest({ projectId: 'p2', refKey: 'abc', entryPath: 'src/App.tsx', savedUnitId: id })).toMatchObject({ savedUnitId: id });
    expect(() => parseCatalogueAdoptionRequest({ projectId: 'p2', refKey: 'abc', entryPath: 'src/App.tsx', savedUnitId: '../x' })).toThrow();
    expect(parseCatalogueSaveRequest({ projectId: 'p1', operationId: 'apply-1' })).toEqual({ projectId: 'p1', operationId: 'apply-1' });
    expect(() => parseCatalogueSaveRequest({ projectId: 'p1', operationId: 'apply-1', files: [] })).toThrow();
    const savedUnit = { id, refKey: 'abc', title: 'Flip filter (React)', target: 'react-source/v1', sourceProjectId: 'p1', sourceOperationId: 'apply-1',
      files: [{ path: 'GsapFlipFilter.tsx', role: 'source', sha256: 'b'.repeat(64), bytes: 10 }] };
    expect(parseCatalogueSavedUnitResponse({ savedUnit })).toEqual({ savedUnit });
    expect(parseCatalogueSavedUnitsResponse({ savedUnits: [savedUnit] })).toEqual({ savedUnits: [savedUnit] });
    expect(() => parseCatalogueSavedUnitResponse({ savedUnit: { ...savedUnit, files: [{ ...savedUnit.files[0], path: '/abs' }] } })).toThrow();
    expect(() => parseCatalogueSavedUnitResponse({ savedUnit: { ...savedUnit, files: [{ ...savedUnit.files[0], role: 'entry' }] } })).toThrow();
  });
});
