import { describe, expect, it } from 'vitest';

import { buildProjectRawUrl } from '../src/mcp.js';

describe('buildProjectRawUrl', () => {
  it('builds nested raw urls', () => {
    expect(buildProjectRawUrl('http://127.0.0.1:7456', 'p1', 'a/b c/index.html')).toBe(
      'http://127.0.0.1:7456/api/projects/p1/raw/a/b%20c/index.html',
    );
  });
  it('rejects dot segments, backslashes and NUL', () => {
    for (const bad of ['../../other', 'a/./b', 'a/..', 'a\\b', 'a\0b']) {
      expect(() => buildProjectRawUrl('http://127.0.0.1:7456', 'p1', bad)).toThrow();
    }
  });
});
