// Flagship step 4, Improve prompt (B8-1): a build binds the accepted design brief of the project
// that holds it — `{projectId, id, revision, hash}` — and the Improve-prompt project is made by
// `POST /api/build-on-brand/project`.
import { describe, expect, it } from 'vitest';

import { buildOnBrandProjectRequestSchema, buildOnBrandRequestSchema } from '../src/api/build-on-brand.js';

const HASH = 'a'.repeat(64);
const base = { brief: 'Bright Smile Family Dentistry, Portland.', designSystemId: 'neutral-product' };

describe('build-on-brand design brief binding', () => {
  it('accepts an accepted-brief binding with its project', () => {
    const parsed = buildOnBrandRequestSchema.parse({ ...base, designBrief: { projectId: 'bob-1', id: 'brief_1', revision: 2, hash: HASH } });
    expect(parsed.designBrief).toEqual({ projectId: 'bob-1', id: 'brief_1', revision: 2, hash: HASH });
  });

  it('refuses a binding without its project, revision or a sha256 hash', () => {
    for (const designBrief of [
      { id: 'brief_1', revision: 2, hash: HASH },
      { projectId: 'bob-1', id: 'brief_1', hash: HASH },
      { projectId: 'bob-1', id: 'brief_1', revision: 2, hash: 'nope' },
      { projectId: 'bob-1', id: 'brief_1', revision: 2, hash: HASH, renderedPrompt: 'smuggled' },
    ]) {
      expect(buildOnBrandRequestSchema.safeParse({ ...base, designBrief }).success, JSON.stringify(designBrief)).toBe(false);
    }
  });

  it('makes the Improve-prompt project from a kit id', () => {
    expect(buildOnBrandProjectRequestSchema.safeParse({ designSystemId: 'neutral-product', brief: base.brief }).success).toBe(true);
    expect(buildOnBrandProjectRequestSchema.safeParse({ brief: base.brief }).success).toBe(false);
  });
});
