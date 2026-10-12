import { describe, expect, it } from 'vitest';
import { matchesDesignSystemQuery } from '@mish/contracts';

const system = {
  id: 'study-example', title: 'Élan', category: 'Trust to lead',
  summary: 'Dark editorial website. Fonts: Inter, Playfair Display.',
  swatches: ['#112233'],
};

describe('design-system discovery', () => {
  it('matches words across title, spine, font and visual description in any order', () => {
    expect(matchesDesignSystemQuery(system, 'inter dark trust')).toBe(true);
    expect(matchesDesignSystemQuery(system, 'elan playfair')).toBe(true);
    expect(matchesDesignSystemQuery(system, 'dark commerce')).toBe(false);
  });
  it('supports color search, empty queries and translated category labels', () => {
    expect(matchesDesignSystemQuery(system, '112233')).toBe(true);
    expect(matchesDesignSystemQuery(system, '   ')).toBe(true);
    expect(matchesDesignSystemQuery(system, 'confianza', 'Confianza y contacto')).toBe(true);
  });
});
