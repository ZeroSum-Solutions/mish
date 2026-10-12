import { describe, expect, it } from 'vitest';
import { compactCardStyle, compactCardTitle } from '../../src/components/home-hero/card-labels';

describe('Home card captions', () => {
  it('shows brand names without generator descriptions or leading draft status', () => {
    expect(compactCardTitle('DRAFT — Watson Trust to Lead', 'watson')).toBe('Watson');
    expect(compactCardTitle('Fervor — Advertising & Creative Agency Showcase', 'fervor')).toBe('Fervor');
    expect(compactCardTitle('Wrenfield — Remodeling & Home Services Lead-Gen', 'wrenfield')).toBe('Wrenfield');
    expect(compactCardTitle('Maren Maker Studio', 'maren')).toBe('Maren');
  });

  it('preserves multiword names, acronyms, hyphens, and localized labels', () => {
    expect(compactCardTitle('DRAFT — STRATUM Build', 'maben')).toBe('STRATUM Build');
    expect(compactCardTitle('  North-West Studio  — Portfolio ')).toBe('North-West Studio');
    expect(compactCardTitle('CRM Dashboard', 'crm-dashboard')).toBe('CRM Dashboard');
    expect(compactCardTitle('Estudio de arquitectura')).toBe('Estudio de arquitectura');
    expect(compactCardTitle('')).toBe('');
  });

  it('keeps style and draft status concise without inventing a style for unknown families', () => {
    expect(compactCardStyle('Editorial', 'DRAFT — Watson Trust to Lead')).toBe('DRAFT · Editorial');
    expect(compactCardStyle('Cinematic and immersive', 'Fervor')).toBe('Cinematic');
    expect(compactCardStyle('Heritage and craft', 'Wrenfield')).toBe('Heritage');
    expect(compactCardStyle('', 'Custom example')).toBeNull();
  });
});
