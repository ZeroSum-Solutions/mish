import { describe, expect, it } from 'vitest';
import { cultRefinedSlot, cultRefinedSourceCopy } from '../src/cult-copy-refinements.js';

describe('reviewed catalog copy', () => {
  it('removes invented social proof in slots and reusable source while leaving other designs intact', () => {
    const original = 'Trusted by 10,000+ companies worldwide';
    expect(cultRefinedSlot('marketing-cta-animated', 'body2', original)).toBe('Example projects and people');
    const code = `<p>${original}</p><KineticText text="Experience"/><KineticText text="the future"/>`;
    expect(cultRefinedSourceCopy(code, 'marketing-cta-animated')).toBe('<p>Example projects and people</p><KineticText text="Make the idea"/><KineticText text="real."/>');
    expect(cultRefinedSourceCopy(code, 'another-component')).toBe(code);
  });

  it('preserves changed upstream copy and unknown slots instead of overwriting new source', () => {
    expect(cultRefinedSlot('marketing-cta-animated', 'body2', 'New, reviewed upstream text')).toBe('New, reviewed upstream text');
    expect(cultRefinedSlot('marketing-cta-animated', 'other', 'Trusted by 10,000+ companies worldwide')).toBe('Trusted by 10,000+ companies worldwide');
  });
});
