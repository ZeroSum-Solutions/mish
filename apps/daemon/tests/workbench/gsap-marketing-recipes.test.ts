import { describe, expect, it } from 'vitest';
import { GSAP_RECIPES, GSAP_RECIPE_IDS, createGsapRecipeMaterials, parseGsapItemId } from '../../src/workbench/recipes/gsap/index.js';
import { MARKETING_RECIPE_IDS } from '../../src/workbench/recipes/gsap/marketing.js';

describe('owned marketing recipe catalogue', () => {
  it('registers every marketing recipe exactly once in both existing adapters', () => {
    const materials = createGsapRecipeMaterials();
    for (const id of MARKETING_RECIPE_IDS) {
      expect(GSAP_RECIPE_IDS.filter(value => value === id)).toHaveLength(1);
      for (const target of ['html', 'react'] as const) {
        expect(materials.itemIds).toContain(`${id}-${target}`);
        expect(parseGsapItemId(`${id}-${target}`)).toEqual({ recipe: GSAP_RECIPES[id], target });
      }
    }
  });

  it.each(MARKETING_RECIPE_IDS)('%s has static content, local motion, scoped CSS in React and inspectable fallbacks', async id => {
    const recipe = GSAP_RECIPES[id];
    expect(recipe.html.markup).toContain(`data-od-gsap="${id}"`);
    expect(recipe.html.markup).toContain('data-od-action');
    expect(recipe.html.markup).not.toMatch(/style="[^"\n]*(?:opacity:\s*0|visibility:\s*hidden)/u);
    expect(recipe.html.script).toContain('prefers-reduced-motion: reduce');
    expect(recipe.react).toContain('prefers-reduced-motion: reduce');
    expect(recipe.react).toContain(`<style>{${JSON.stringify(recipe.html.css)}}</style>`);
    for (const source of [recipe.html.script, recipe.react]) {
      expect(source).not.toMatch(/scale(?:X|Y)?\s*:\s*0(?:\D|$)/u);
      expect(source).not.toContain('gsap/all');
      expect(source).not.toMatch(/fetch\(|https?:\/\/(?:cdn|unpkg|cdnjs)/u);
    }
    expect(recipe.trigger.length).toBeGreaterThan(10);
    expect(recipe.reducedMotion.length).toBeGreaterThan(10);
    const material = (await createGsapRecipeMaterials().materialize(`${id}-html`))!;
    const assets = material.files.filter(file => file.role === 'asset').map(file => file.path);
    expect(assets).toEqual(['gsap', ...recipe.plugins].map(plugin => `gsap-${id}.${plugin}.min.js`));
  });
});
