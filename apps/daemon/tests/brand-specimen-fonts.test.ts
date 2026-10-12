import { describe, expect, it } from 'vitest';
import { brandFromDesignMd } from '../src/brands/design-md-input.js';
import { buildBrandSystem } from '../src/brands/engine/index.js';
import { brandToDesignMd } from '../src/brands/design-md.js';

const brand = () => brandFromDesignMd({ sourceUrl: 'designmd://specimen-qa', markdown: '# Specimen QA\n\n## Typography\n| Role | Face |\n|---|---|\n| Display | Playfair Display |\n| Body | DM Sans |' })!;

describe('kit specimen font sources', () => {
  it('loads named Google faces without explicit stylesheet URLs, in both specimens and generation guide', () => {
    const kit = brand();
    const system = buildBrandSystem(kit);
    for (const name of ['kit.html', 'kit.dark.html']) {
      expect(system.files[name]).toContain('fonts.googleapis.com/css2?family=Playfair+Display');
      expect(system.files[name]).toContain('fonts.googleapis.com/css2?family=DM+Sans');
      expect(system.files[name]).toContain("'Playfair Display'");
    }
    expect(brandToDesignMd(kit)).toContain('load: https://fonts.googleapis.com/css2?family=Playfair+Display');
  });
  it('keeps proprietary families offline and preserves explicit sources', () => {
    const kit = brand();
    kit.typography.display.family = 'Custom Studio Serif';
    kit.typography.body.googleFontsUrl = 'https://fonts.bunny.net/css?family=dm-sans:400,700';
    const html = buildBrandSystem(kit).files['kit.html']!;
    expect(html).not.toContain('family=Custom');
    expect(html).toContain('fonts.bunny.net/css?family=dm-sans:400,700');
  });
});
