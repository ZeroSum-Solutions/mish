import { describe, expect, it, vi } from 'vitest';
import { cultRefinedSlot, cultRefinedSourceCopy } from '../src/cult-copy-refinements.js';

// Owned literal data exercises the mechanism without importing removed private copy.
vi.mock('@mish/cult-ui-catalog/catalog-copy-refinements.json', () => ({
  default: { replacements: [{ item: 'fixture-card', slot: 'body', from: 'Claim not supplied by the brief', to: 'Example projects' }] },
}));

describe('reviewed catalog copy', () => {
  it('replaces a reviewed exact slot and source literal while leaving other designs intact', () => {
    const original = 'Claim not supplied by the brief';
    expect(cultRefinedSlot('fixture-card', 'body', original)).toBe('Example projects');
    const code = `<p>${original}</p>`;
    expect(cultRefinedSourceCopy(code, 'fixture-card')).toBe('<p>Example projects</p>');
    expect(cultRefinedSourceCopy(code, 'another-component')).toBe(code);
  });

  it('preserves changed copy and unknown slots instead of overwriting new source', () => {
    expect(cultRefinedSlot('fixture-card', 'body', 'New reviewed text')).toBe('New reviewed text');
    expect(cultRefinedSlot('fixture-card', 'other', 'Claim not supplied by the brief')).toBe('Claim not supplied by the brief');
  });

  it('retains source-only kinetic text refinements', () => {
    expect(cultRefinedSourceCopy('<KineticText text="Experience"/><KineticText text="the future"/>', 'marketing-cta-animated'))
      .toBe('<KineticText text="Make the idea"/><KineticText text="real."/>');
  });
});
