import { describe, expect, it } from 'vitest';
import { isSelectableDesignSystem } from '../../src/runtime/design-system-selection';

describe('project design-system eligibility', () => {
  it('refuses stale approval and published unreviewed kits', () => {
    expect(isSelectableDesignSystem({ title: 'Kit', status: 'published' })).toBe(false);
    expect(isSelectableDesignSystem({ title: 'Kit', status: 'published', approval: { status: 'approved', revision: 'r2', approvedRevision: 'r1' } })).toBe(false);
  });
  it('keeps unpublished personal systems out of all project selectors', () => {
    expect(isSelectableDesignSystem({ title: 'Draft', source: 'user' })).toBe(false);
    expect(isSelectableDesignSystem({ title: 'Draft', isEditable: true })).toBe(false);
    expect(isSelectableDesignSystem({ title: 'Draft', status: 'draft' })).toBe(false);
    expect(isSelectableDesignSystem({ title: 'Ready', source: 'user', status: 'published', approval: { status: 'approved', revision: 'r1', approvedRevision: 'r1' } })).toBe(true);
    expect(isSelectableDesignSystem({ title: 'Bundled', source: 'built-in', approval: { status: 'approved', revision: 'r1', approvedRevision: 'r1' } })).toBe(true);
    expect(isSelectableDesignSystem({ title: '' , status: 'published' })).toBe(false);
  });
});
