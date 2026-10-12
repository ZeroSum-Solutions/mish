import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every `@media (prefers-reduced-motion: reduce) { … }` block. */
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  const marker = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(css)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push(css.slice(start, index - 1));
  }
  return blocks;
}

/** Declarations of every top-level rule whose selector list includes `selector`. */
function declarations(css: string, selector: string): string {
  const found: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.replace(/\s+/g, ' ').trim());
    if (selectors.includes(selector)) found.push(match[2] ?? '');
  }
  return found.join('\n');
}

describe('design systems busy actions', () => {
  const css = read('components/DesignSystemsTab.module.css');

  it('stops the busy-action spinner glyphs under reduced motion', () => {
    const stopped = reducedMotionBlocks(css).some((block) => {
      const busyAction = declarations(block, ".actionButton[aria-busy='true'] svg");
      const busyToggle = declarations(block, ".statusToggle[aria-busy='true'] svg");
      return /animation:\s*none/.test(busyAction) && /animation:\s*none/.test(busyToggle);
    });
    expect(stopped).toBe(true);
  });
});

describe('home hero aspect-ratio chips', () => {
  const css = read('styles/home/home-hero.css');

  it('colors the aspect-ratio glyph chips and select hovers with tokens, not raw hues', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      /home-hero__ratio-option-icon|\[data-field-name='designSystem'\] \.home-hero__footer-select-item/.test(selector!),
    );
    expect(rules.length).toBeGreaterThan(5);
    const rawColors = rules.flatMap(([, selector, body]) =>
      (body!.match(/#[0-9a-f]{3,8}\b|\bwhite\b|\bblack\b/gi) ?? []).map((hit) => `${selector!.trim()}: ${hit}`),
    );
    expect(rawColors).toEqual([]);
  });
});

describe('nav rail edge-reveal surface', () => {
  const css = read('styles/home/entry-layout.css');
  const selector = '.entry:not(.entry--rail-open) .entry-nav-rail.is-peek .entry-nav-rail__panel';

  it('mixes the thick glass toward the solid fill so dark imagery underneath does not smear', () => {
    // At 85% the light thick glass let a black card behind the peek blur into a grey blob
    // across the empty half of the panel. The peek keeps its blur but sits on a denser fill.
    const body = declarations(css, selector);
    expect(body).toMatch(/background:\s*var\(--rail-peek-surface\)/);
    expect(body).toMatch(/--rail-peek-surface:\s*color-mix\(in srgb, var\(--glass-surface\) \d+%, var\(--bg-elevated\)\)/);
    expect(body).toMatch(/backdrop-filter:\s*var\(--glass-backdrop\)/);
  });
});

describe('message center panel focus', () => {
  it('draws no ring on the programmatically focused panel container, in either scope', () => {
    const css = read('styles/message-center.css');
    expect(declarations(css, '.message-center-panel:focus-visible')).toMatch(/outline:\s*none/);
    expect(
      declarations(css, "html[data-ui-system='workspace'] .message-center-panel.message-center-panel:focus-visible"),
    ).toMatch(/outline:\s*none/);
  });
});
