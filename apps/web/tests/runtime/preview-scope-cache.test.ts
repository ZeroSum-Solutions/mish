import { describe, expect, it } from 'vitest';

import { projectPreviewScopeDirHref } from '../../src/runtime/preview-scope-cache';

describe('projectPreviewScopeDirHref', () => {
  it('keeps the packaged od:// scheme and host in scoped bases', () => {
    const href = 'od://app/api/projects/p1/preview/scope-od-1/pages/';
    expect(projectPreviewScopeDirHref('p1', href, 'pages/a.html'))
      .toBe('od://app/api/projects/p1/preview/scope-od-1/pages/');
    expect(projectPreviewScopeDirHref('p1', href, 'other dir/b.html'))
      .toBe('od://app/api/projects/p1/preview/scope-od-1/other%20dir/');
    expect(projectPreviewScopeDirHref('p1', href, 'index.html'))
      .toBe('od://app/api/projects/p1/preview/scope-od-1/');
  });

  it('keeps http bases and their port unchanged', () => {
    expect(projectPreviewScopeDirHref(
      'p1',
      'http://127.0.0.1:7456/api/projects/p1/preview/scope-http-1/',
      'deck/slides.html',
    )).toBe('http://127.0.0.1:7456/api/projects/p1/preview/scope-http-1/deck/');
  });

  it('rejects hrefs that are not this project’s preview capability', () => {
    expect(projectPreviewScopeDirHref('p1', 'od://app/api/projects/p2/preview/s/', 'a.html')).toBeNull();
    expect(projectPreviewScopeDirHref('p1', 'od://app/api/projects/p1/raw/a.html', 'a.html')).toBeNull();
    expect(projectPreviewScopeDirHref('p1', 'not a url', 'a.html')).toBeNull();
  });
});
