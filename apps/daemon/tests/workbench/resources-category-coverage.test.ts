import { describe, expect, it } from 'vitest';
import { RESOURCE_CATEGORIES } from '@mish/contracts';
import { localInventorySources, searchEveryPage, skillPlugin } from './resources-inventory-fixture.js';

/** The categories AC-R04.2 names, as RESOURCE_CATEGORIES values. */
const AC_R04_2_CATEGORIES = ['image', 'font', 'color-palette', 'type-scale', 'spacing-scale', 'motion', 'cta-pattern', 'layout', 'section', 'block', 'component', 'skill', 'design-system'] as const;
/** Named gaps: no local adapter produces these yet. A new adapter that starts
 * producing one must move it out of this list, so the claim stays truthful. */
const NOT_YET_PRODUCED = ['image', 'cta-pattern', 'block'] as const;

describe('AC-R04.2 category coverage', () => {
  it('produces real local items for every AC-R04.2 category except the named gaps', async () => {
    const { results } = await searchEveryPage(localInventorySources([skillPlugin()]));
    const produced = new Set(results.map(item => item.category));
    for (const category of AC_R04_2_CATEGORIES) {
      if ((NOT_YET_PRODUCED as readonly string[]).includes(category)) expect(produced.has(category), `${category} is listed as a gap but is now produced`).toBe(false);
      else expect(produced.has(category), `${category} has no local item`).toBe(true);
    }
    expect(AC_R04_2_CATEGORIES.every(category => (RESOURCE_CATEGORIES as readonly string[]).includes(category))).toBe(true);
  });

  it('derives the token categories from the design-systems source only', async () => {
    const { results } = await searchEveryPage(localInventorySources());
    for (const category of ['design-system', 'color-palette', 'type-scale', 'spacing-scale', 'motion'] as const) {
      const items = results.filter(item => item.category === category);
      expect(items.length, category).toBeGreaterThan(0);
      expect(items.every(item => item.ref.sourceId === 'design-systems')).toBe(true);
    }
  });
});
