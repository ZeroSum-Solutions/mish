import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { cultPreviewPresentationCss } from '../src/cult-preview-presentation.js';

const converted = [
  'marketing-integrations-2',
  'marketing-integrations-vertical',
  'marketing-model-comparison-table-1',
  'marketing-hero-ribbon',
];
const harness = ['ai-artifact-chart', 'feature-sticky-section', 'feature-sticky-section-demo'];

describe('Cult preview presentation isolation', () => {
  it.each([...converted, ...harness])('%s repairs are phone-only and scoped to that source composition', (name) => {
    const css = postcss.parse(cultPreviewPresentationCss(name));
    expect(css.nodes).toHaveLength(1);
    const media = css.first!;
    expect(media.type).toBe('atrule');
    expect(media).toMatchObject({ name: 'media', params: '(width < 40rem)' });
    const prefix = converted.includes(name)
      ? `#od-live-preview .cult-${name} `
      : `body[data-cult-item="${name}"] #root `;
    let rules = 0;
    css.walkRules((rule) => {
      rules += 1;
      for (const selector of rule.selectors) expect(selector.startsWith(prefix)).toBe(true);
    });
    expect(rules).toBeGreaterThan(0);
    css.walkDecls((declaration) => {
      // Clipping the entire document could conceal the regression and remove usable content.
      expect(declaration.prop).not.toMatch(/^overflow/);
      expect(declaration.prop).not.toBe('display');
    });
  });

  it.each(['marketing-integrations-3', 'feature-sticky-section-other', 'ai-artifact-table', '', 'hero-ribbon'])('leaves unreviewed source %s alone', (name) => {
    expect(cultPreviewPresentationCss(name)).toBe('');
  });

  it('repairs the comparison scroll viewport without changing the table minimum width or removing columns', () => {
    const css = postcss.parse(cultPreviewPresentationCss('marketing-model-comparison-table-1'));
    const selectors: string[] = [];
    css.walkRules((rule) => { selectors.push(rule.selector); });
    expect(selectors).toEqual(['#od-live-preview .cult-marketing-model-comparison-table-1 .c2s.c2u']);
    expect(css.toString()).toContain('margin-inline:0');
    css.walkDecls((declaration) => {
      expect(declaration.prop).not.toMatch(/^overflow/);
      expect(declaration.prop).not.toBe('width');
    });
  });
});
