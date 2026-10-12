import { describe, expect, it } from 'vitest';

import { twenty1stCardPreviewUrl, parseTwenty1stItem, parseTwenty1stSourceResponse, selectTwenty1stPrimarySourceFile } from '../src/api/twenty1st.js';

const HASH = 'a'.repeat(64);
const source = (files = [
  { path: 'components/orbit.tsx', content: 'export const Orbit = () => <div />;', sha256: HASH },
  { path: 'demo.tsx', content: 'export default Orbit;', sha256: HASH },
]) => ({
  id: '21st:example', title: 'Orbit', provenance: 'upstream-private', sourceVerified: true,
  referenceUrl: 'https://21st.dev/@author/components/orbit', referenceAuthor: 'author', sourceSha256: HASH, files,
});

describe('private 21st source contracts', () => {
  it('retains separate local closure and byte verification without changing source identity', () => {
    const closure = { status: 'missing', missing: [{ importer: 'gallery/demo.tsx', specifier: '@/components/ui/separator', resolvedCandidate: 'gallery/components/ui/separator' }] };
    const parsed = parseTwenty1stSourceResponse({ ...source(), localImportClosure: closure });
    expect(parsed).toHaveProperty('localImportClosure', closure);
    expect(parsed).toHaveProperty('sourceVerified', true);
    expect(parsed.sourceSha256).toBe(HASH);
    expect(parsed.id).toBe('21st:example');
    expect(() => parseTwenty1stSourceResponse({ ...source(), localImportClosure: { status: 'missing', missing: [{ ...closure.missing[0], resolvedCandidate: '../outside' }] } })).toThrow('path');
    expect(() => parseTwenty1stSourceResponse({ ...source(), localImportClosure: { status: 'unverified', reason: 'made-up' } })).toThrow('closure');
    expect(parseTwenty1stSourceResponse({ ...source(), localImportClosure: { status: 'unverified', reason: 'ambiguous-baseurl-import' } }))
      .toHaveProperty('localImportClosure', { status: 'unverified', reason: 'ambiguous-baseurl-import' });
  });
  it('keeps upstream implementation provenance separate from upstream rights', () => {
    const parsed = parseTwenty1stItem({
      id: '21st:example', slug: 'example', name: 'Orbit', author: 'author',
      authorProfileUrl: 'https://21st.dev/@author', itemUrl: 'https://21st.dev/@author/components/orbit',
      rights: 'reference-only', copyable: false, licenseLabel: null, licenseUrl: null, licenseNotice: null,
      preview: { kind: 'image', source: 'twenty-first-dev-cdn' },
      privateImplementation: { title: 'Orbit', description: 'Saved demo', provenance: 'upstream-private',
        refinement: { originalSourceSha256: 'b'.repeat(64), note: 'Reviewed local copy.' },
        sourceSha256: HASH, sourceVerified: true,
        sourceUrl: '/api/21st/21st%3Aexample/source', previewUrl: '/api/21st/21st%3Aexample/preview' },
    });
    expect(parsed).toHaveProperty('privateImplementation.provenance', 'upstream-private');
    expect(parsed).toHaveProperty('privateImplementation.sourceVerified', true);
    expect(parsed.privateImplementation?.refinement).toEqual({ originalSourceSha256: 'b'.repeat(64), note: 'Reviewed local copy.' });
    expect(parsed.copyable).toBe(false);
    expect(parsed.licenseNotice).toBeNull();
  });

  it('preserves disclosed original pins and rejects malformed refinement metadata', () => {
    const refinement = { originalSourceSha256: 'b'.repeat(64), note: 'Reviewed local copy.' };
    expect(parseTwenty1stSourceResponse({ ...source(), refinement })).toHaveProperty('refinement', refinement);
    for (const bad of [{ ...refinement, originalSourceSha256: 'invalid' }, { ...refinement, note: '' }, { ...refinement, note: 'a'.repeat(1001) }]) {
      expect(() => parseTwenty1stSourceResponse({ ...source(), refinement: bad })).toThrow();
    }
  });

  it('accepts a variable set of actual TSX, demo, and dependency files', () => {
    const parsed = parseTwenty1stSourceResponse(source());
    expect(parsed.files.map(file => file.path)).toEqual(['components/orbit.tsx', 'demo.tsx']);
    expect(parsed).toHaveProperty('sourceVerified', true);
    expect(parsed.provenance).toBe('upstream-private');
  });

  it('honors the declared component entry and refuses an absent entry', () => {
    const parsed = parseTwenty1stSourceResponse({ ...source(), primarySourcePath: 'components/orbit.tsx' });
    expect(selectTwenty1stPrimarySourceFile(parsed).path).toBe('components/orbit.tsx');
    const demo = parseTwenty1stSourceResponse({ ...source(), primarySourcePath: 'demo.tsx' });
    expect(selectTwenty1stPrimarySourceFile(demo).path).toBe('demo.tsx');
    expect(() => parseTwenty1stSourceResponse({ ...source(), primarySourcePath: '../secret.ts' })).toThrow('path');
    expect(() => parseTwenty1stSourceResponse({ ...source(), primarySourcePath: 'missing.tsx' })).toThrow('missing');
  });

  it('keeps older bundle selection stable when files are reordered', () => {
    const files = [
      { path: 'gallery/components/twentyfirst/example/demo.tsx', content: 'demo', sha256: HASH },
      { path: 'gallery/components/twentyfirst/example/b-card.tsx', content: 'B', sha256: HASH },
      { path: 'gallery/components/twentyfirst/example/a-card.tsx', content: 'A', sha256: HASH },
    ];
    expect(selectTwenty1stPrimarySourceFile(parseTwenty1stSourceResponse(source(files))).content).toBe('A');
    expect(selectTwenty1stPrimarySourceFile(parseTwenty1stSourceResponse(source([...files].reverse()))).content).toBe('A');
  });

  it.each(['../secret.ts', 'a/../secret.ts', '/secret.ts', 'C:/secret.ts', 'a\\secret.ts', './demo.tsx', 'a//demo.tsx', 'a/%2e%2e/secret.ts', 'demo.tsx\0', 'a/.. /secret.ts', 'a/secret.ts.', ' a/secret.ts'])('rejects unsafe source path %s', path => {
    expect(() => parseTwenty1stSourceResponse(source([{ path, content: '', sha256: HASH }]))).toThrow('path');
  });

  it('rejects duplicate paths and invalid per-file hashes', () => {
    const file = { path: 'demo.tsx', content: '', sha256: HASH };
    expect(() => parseTwenty1stSourceResponse(source([file, file]))).toThrow('duplicate');
    expect(() => parseTwenty1stSourceResponse(source([{ ...file, sha256: 'not-a-hash' }]))).toThrow('sha256');
  });

  it('requires an explicit upstream verification result', () => {
    expect(() => parseTwenty1stSourceResponse({ ...source(), sourceVerified: undefined })).toThrow('sourceVerified');
    expect(parseTwenty1stSourceResponse({ ...source(), sourceVerified: false })).toHaveProperty('sourceVerified', false);
  });

  it('bounds the source file count and UTF-8 payload size', () => {
    expect(() => parseTwenty1stSourceResponse(source([]))).toThrow('files');
    expect(() => parseTwenty1stSourceResponse(source(Array.from({ length: 129 }, (_, n) => ({ path: `${n}.tsx`, content: '', sha256: HASH }))))).toThrow('files');
    expect(() => parseTwenty1stSourceResponse(source([{ path: 'demo.tsx', content: '😀'.repeat(524289), sha256: HASH }]))).toThrow('size');
    expect(() => parseTwenty1stSourceResponse(source(Array.from({ length: 5 }, (_, n) => ({ path: `${n}.tsx`, content: 'a'.repeat(2 * 1024 * 1024), sha256: HASH }))))).toThrow('size');
  });

  it('preserves the exact seven-file alternative format', () => {
    const files = ['index.ts', 'runtime.ts', 'component.js', 'style.css', 'index.html', 'NOTICE.txt', 'README.md'].map(path => ({ path, content: '', sha256: HASH }));
    const independent = { ...source(files), provenance: 'independently-authored' };
    expect(parseTwenty1stSourceResponse(independent).provenance).toBe('independently-authored');
    expect(() => parseTwenty1stSourceResponse({ ...independent, files: files.slice(1) })).toThrow('seven');
  });
});


describe('local implementation thumbnail contract', () => {
  const row = (thumbnail?: unknown) => ({
    id: '21st:example', slug: 'example', name: 'Orbit', author: 'author',
    authorProfileUrl: 'https://21st.dev/@author', itemUrl: 'https://21st.dev/@author/components/orbit',
    rights: 'reference-only', copyable: false, licenseLabel: null, licenseUrl: null, licenseNotice: null,
    preview: { kind: 'image', source: 'twenty-first-dev-cdn' },
    privateImplementation: { title: 'Orbit', description: 'Saved demo', provenance: 'upstream-private',
      sourceSha256: HASH, sourceVerified: true,
      sourceUrl: '/api/21st/21st%3Aexample/source', previewUrl: '/api/21st/21st%3Aexample/preview',
      ...(thumbnail === undefined ? {} : { thumbnail }) },
  });
  it('uses an exact image revision for the selected local implementation', () => {
    const parsed = parseTwenty1stItem(row({ revision: HASH }));
    expect(parsed.privateImplementation?.thumbnail).toEqual({ revision: HASH });
    expect(twenty1stCardPreviewUrl(parsed)).toBe(`/api/21st/21st%3Aexample/implementation-thumbnail?revision=${HASH}`);
    expect(parsed.preview).toEqual({ kind: 'image', source: 'twenty-first-dev-cdn' });
  });
  it('retains the saved reference URL when no matching local screenshot is advertised', () => {
    expect(twenty1stCardPreviewUrl(parseTwenty1stItem(row()))).toBe('/api/21st/21st%3Aexample/reference-preview');
  });
  it.each([{ revision: '../image' }, { revision: 'A'.repeat(64) }, {}, null])('rejects an invalid local thumbnail revision %j', thumbnail => {
    expect(() => parseTwenty1stItem(row(thumbnail))).toThrow();
  });
});
