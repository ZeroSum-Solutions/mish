import { describe, expect, it } from 'vitest';

import {
  AGENCY_BUILD_MAX_EFFECT_HINTS,
  AGENCY_EFFECT_COMPONENT_ID,
  AGENCY_EFFECT_PLACEMENT_IDS,
  agencyEffectHintsRefusal,
  isAgencyEffectPlacementId,
  parseAgencyEffectsInput,
  parseAgencyEffectsResult,
  parseAgencyFamilyEffectsResponse,
  type AgencyFamilyEffectsResponse,
} from '../src/api/agency-build';

// The effects DTO's runtime parsers (Sol ruling 2026-09-25). The daemon, `od agency build` and the
// web Build panel all go through these, so what they pin is the one shape the three share: a
// closed placement vocabulary, component ids only, fixed skip codes, and nothing extra passing.

const OFFER: AgencyFamilyEffectsResponse = {
  family: 'marketing-site',
  scriptPolicy: 'hash',
  maxEffects: 2,
  placements: [
    { placement: 'hero-title', host: 'marketing-site-hero-heading', allow: [{ id: 'shiny-text', name: 'Shiny Text', kind: 'css-only', bytes: { js: 0, css: 900 } }] },
    { placement: 'hero-background', host: 'marketing-site-hero', allow: [{ id: 'silk', name: 'Silk', kind: 'js', bytes: { js: 4100, css: 300 } }] },
  ],
};

describe('parseAgencyEffectsInput', () => {
  it('accepts auto, off, and a record of placement to id or none', () => {
    expect(parseAgencyEffectsInput(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseAgencyEffectsInput('auto')).toEqual({ ok: true, value: 'auto' });
    expect(parseAgencyEffectsInput('off')).toEqual({ ok: true, value: 'off' });
    expect(parseAgencyEffectsInput({ 'hero-title': 'shiny-text', cta: 'none' }))
      .toEqual({ ok: true, value: { 'hero-title': 'shiny-text', cta: 'none' } });
  });

  it('reads an empty record as omitted, so the build default applies', () => {
    expect(parseAgencyEffectsInput({})).toEqual({ ok: true, value: undefined });
  });

  it('refuses a bad shape, an unknown placement, a malformed id and too many entries', () => {
    for (const bad of [null, 'on', 3, ['hero-title'], { hero: 'shiny-text' }, { 'hero-title': 'Shiny Text' }, { 'hero-title': 7 }]) {
      expect(parseAgencyEffectsInput(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    // Eleven entries cannot be built from ten placement ids, so the cap is checked before keys.
    const many: Record<string, string> = {};
    for (let index = 0; index <= AGENCY_BUILD_MAX_EFFECT_HINTS; index += 1) many[`p${index}`] = 'none';
    const refused = parseAgencyEffectsInput(many);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(String(AGENCY_BUILD_MAX_EFFECT_HINTS));
  });

  it('never echoes the caller\'s own string in an error', () => {
    const refused = parseAgencyEffectsInput({ 'hero-title': 'ZZ<script>ZZ' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).not.toContain('ZZ');
    const unknown = parseAgencyEffectsInput({ 'ZZ-secret-ZZ': 'none' });
    if (!unknown.ok) expect(unknown.error).not.toContain('ZZ');
  });

  it('reserves none and every placement id from the component id pattern', () => {
    for (const id of ['none', ...AGENCY_EFFECT_PLACEMENT_IDS]) expect(AGENCY_EFFECT_COMPONENT_ID.test(id)).toBe(false);
    expect(AGENCY_EFFECT_COMPONENT_ID.test('shiny-text')).toBe(true);
    expect(AGENCY_EFFECT_COMPONENT_ID.test('hero-title-glow')).toBe(true);
  });

  it('knows exactly the ten placement ids', () => {
    expect(AGENCY_EFFECT_PLACEMENT_IDS).toHaveLength(10);
    expect(isAgencyEffectPlacementId('hero-title')).toBe(true);
    expect(isAgencyEffectPlacementId('footer')).toBe(false);
  });
});

describe('agencyEffectHintsRefusal', () => {
  it('passes allowed ids and none, and names the placement it refuses', () => {
    expect(agencyEffectHintsRefusal({ 'hero-title': 'shiny-text', 'hero-background': 'none', cta: 'none' }, OFFER)).toBeUndefined();
    expect(agencyEffectHintsRefusal({ 'hero-title': 'silk' }, OFFER)).toContain('hero-title');
    expect(agencyEffectHintsRefusal({ gallery: 'silk' }, OFFER)).toContain('offers no effect at placement gallery');
    expect(agencyEffectHintsRefusal({ 'hero-title': 'shiny-text' }, { ...OFFER, placements: [] })).toBeDefined();
  });
});

describe('parseAgencyEffectsResult', () => {
  const result = {
    mode: 'mixed',
    applied: [{ placement: 'hero-title', componentId: 'shiny-text', kind: 'css-only', source: 'hint' }],
    skipped: [{ placement: 'hero-background', componentId: 'silk', reason: 'byte-budget' }, { placement: 'cta', reason: 'none' }],
    jevSkipped: 'jev-timeout',
    bytesAdded: 1234,
  };

  it('keeps a well-formed result and drops extra keys', () => {
    const parsed = parseAgencyEffectsResult({ ...result, answers: ['prose'], applied: [{ ...result.applied[0], criteria: 'prose' }] });
    expect(parsed).toEqual(result);
    expect(JSON.stringify(parsed)).not.toContain('prose');
  });

  it('drops the whole result on any code outside the closed sets', () => {
    expect(parseAgencyEffectsResult({ ...result, mode: 'sometimes' })).toBeUndefined();
    expect(parseAgencyEffectsResult({ ...result, skipped: [{ placement: 'cta', reason: 'Jev said no because…' }] })).toBeUndefined();
    expect(parseAgencyEffectsResult({ ...result, jevSkipped: 'jev-said-hello' })).toBeUndefined();
    expect(parseAgencyEffectsResult({ ...result, applied: [{ ...result.applied[0], placement: 'footer' }] })).toBeUndefined();
    expect(parseAgencyEffectsResult({ ...result, bytesAdded: -1 })).toBeUndefined();
    expect(parseAgencyEffectsResult(null)).toBeUndefined();
  });

  it('accepts the repair source, and never none or a placement id as a component id', () => {
    const repaired = { ...result, applied: [{ ...result.applied[0], source: 'repair' }] };
    expect(parseAgencyEffectsResult(repaired)).toEqual(repaired);
    expect(parseAgencyEffectsResult({ ...result, applied: [{ ...result.applied[0], source: 'someone' }] })).toBeUndefined();
    for (const id of ['none', 'hero-title']) {
      expect(parseAgencyEffectsResult({ ...result, applied: [{ ...result.applied[0], componentId: id }] }), id).toBeUndefined();
      expect(parseAgencyEffectsInput({ cta: id }).ok, id).toBe(id === 'none'); // `none` only as the sentinel
    }
    expect(parseAgencyEffectsInput({ cta: 'cta' }).ok).toBe(false);
  });
});

describe('parseAgencyFamilyEffectsResponse', () => {
  it('accepts a populated and an empty family', () => {
    expect(parseAgencyFamilyEffectsResponse(OFFER)).toEqual({ ok: true, value: OFFER });
    const empty = { family: 'app-shell', scriptPolicy: 'none', maxEffects: 0, placements: [] };
    expect(parseAgencyFamilyEffectsResponse(empty)).toEqual({ ok: true, value: empty });
  });

  it('refuses a malformed answer with a reason', () => {
    const cases: unknown[] = [
      null,
      { ...OFFER, scriptPolicy: 'unsafe' },
      { ...OFFER, maxEffects: -1 },
      { ...OFFER, placements: [{ ...OFFER.placements[0], placement: 'footer' }] },
      { ...OFFER, placements: [{ ...OFFER.placements[0], allow: [{ id: 'x', name: 'X', kind: 'wasm', bytes: { js: 0, css: 0 } }] }] },
    ];
    for (const value of cases) {
      const parsed = parseAgencyFamilyEffectsResponse(value);
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
    }
  });
});
