import { describe, expect, it } from 'vitest';
import { shapeAtlas } from '@open-design/agency-fast-lane/data';
import { prototypeSpineChips } from '../src/components/home-hero/spine-chips';
import { subChipsForChip } from '../src/components/home-hero/sub-chips';
import { en } from '../src/i18n/locales/en';

describe('prototypeSpineChips', () => {
  it('is the atlas spines, in the atlas order', () => {
    const chips = prototypeSpineChips();
    expect(chips.map((chip) => chip.slug)).toEqual([
      'TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI',
    ]);
    // Same set AND same order as the data module the router reads, so a tab can
    // never name a spine the router does not know.
    expect(chips.map((chip) => chip.slug)).toEqual(shapeAtlas.spines.map((spine) => spine.code));
    expect(chips.map((chip) => chip.label)).toEqual(shapeAtlas.spines.map((spine) => spine.name));
  });

  it('labels every spine through a dictionary key whose English is the atlas name', () => {
    for (const chip of prototypeSpineChips()) {
      expect(chip.labelKey, chip.slug).toBe(`homeHero.spine.${chip.slug}`);
      expect(en[chip.labelKey!], chip.slug).toBe(chip.label);
    }
  });

  it('gives every spine a deterministic icon', () => {
    const first = prototypeSpineChips().map((chip) => chip.icon);
    expect(first).toEqual(prototypeSpineChips().map((chip) => chip.icon));
    expect(first.every((icon) => typeof icon === 'string' && icon.length > 0)).toBe(true);
  });

  it('leaves the legacy keyword registry untouched', () => {
    // The scenes are not rendered under Prototype any more, but they still
    // resolve: persisted drafts, queued intents and the placeholder carousel
    // read them (see tests/home-hero-sub-chips.test.ts).
    const legacy = subChipsForChip('prototype', []).map((chip) => chip.slug);
    expect(legacy).toHaveLength(8);
    expect(legacy).toContain('mobile');
    expect(legacy).toContain('wireframe');
    for (const chip of prototypeSpineChips()) {
      expect(legacy, chip.slug).not.toContain(chip.slug);
    }
  });
});
