import { describe, expect, it } from 'vitest';
import { designSystemRunNotice, parseDesignSystemRunNotice } from '../src/api/design-system-selectability.js';

describe('revision-bound run refusals', () => {
  it('preserves the refused revision through persisted/SSE parsing', () => {
    const revision = 'a'.repeat(64);
    const notice = designSystemRunNotice({ designSystemId: 'user:atlas', hasBody: false,
      summary: { id: 'user:atlas', title: 'Atlas', status: 'published', approval: { status: 'unreviewed', revision } },
    });
    expect(notice.reason).toBe('unreviewed');
    expect(notice.revision).toBe(revision);
    expect(parseDesignSystemRunNotice(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
  });

  it.each([undefined, 'forged-revision'])('does not invent a usable approval revision for %s', revision => {
    const parsed = parseDesignSystemRunNotice({ reason: 'unreviewed', designSystemId: 'user:atlas', revision,
      title: 'Atlas', message: 'Approval required', resolveCommand: 'od design-system approve user:atlas' });
    expect(parsed?.reason).toBe('unreviewed');
    expect(parsed?.revision).toBeUndefined();
  });
});
