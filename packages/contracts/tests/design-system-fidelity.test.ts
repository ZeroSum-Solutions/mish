import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';
import { composeOdNextStrategyStableRequestContextV2 } from '../src/prompts/od-next-strategy.js';

const css = ':root { --brand-action: #123456; }\n:root[data-theme="dark"] { --brand-action: #abcdef; }';
const context = { designSystemBody: '# Locked source', designSystemTokensCss: css };

describe('active design system consumer fidelity', () => {
  it.each([
    ['API legacy', () => composeSystemPrompt(context)],
    ['OD Next', () => composeOdNextStrategyStableRequestContextV2(context)],
  ] as const)('%s binds source tokens to actual product roles', (_name, compose) => {
    const prompt = compose();
    expect(prompt).toContain('Copy the complete supplied tokens.css');
    expect(prompt).toContain('Copying variables without using them');
    expect(prompt).toContain('palette order');
    expect(prompt).toContain('ambiguous');
    expect(prompt).toContain(css);
  });
  it.each([
    ['API legacy', () => composeSystemPrompt({ designSystemBody: '# Prose-only system' })],
    ['OD Next', () => composeOdNextStrategyStableRequestContextV2({ designSystemBody: '# Prose-only system' })],
  ] as const)('%s uses prose-only guides without asking for absent source CSS', (_name, compose) => {
    const prompt = compose();
    expect(prompt).toContain('When tokens.css is supplied:');
    expect(prompt).toContain('If the package only supplies a prose guide');
    expect(prompt).toContain('do not search for missing tokens.css');
    expect(prompt).not.toContain('## Active design system tokens');
  });
  it('accepts a source feature checklist as a visual component', () => {
    expect(() => composeOdNextStrategyStableRequestContextV2({
      designSystemBody: '### Feature Checklist — Dark Section\nTwo-column layout: headline left, checklist right. Use feature checklist items.',
      designSystemUsageMd: 'Layout: headline left, checklist right.',
    })).not.toThrow();
  });
  it('still rejects post-Build workflow instructions inside source descriptions', () => {
    expect(() => composeOdNextStrategyStableRequestContextV2({
      designSystemBody: 'Feature checklist items. Render the finished artifact, inspect it, then fix any defects.',
    })).toThrow(/forbidden/i);
  });
  it.each([
    'Run a post-build feature checklist on every screen.',
    'Post-build: complete the feature checklist right away.',
    'After finishing the build, walk the feature checklist.',
  ])('rejects workflow instructions even when a component noun is present: %s', (body) => {
    expect(() => composeOdNextStrategyStableRequestContextV2({ designSystemBody: body })).toThrow(/forbidden/i);
  });
  it('does not impose a source system when none is selected', () => {
    expect(composeSystemPrompt({})).not.toContain('Copy the complete supplied tokens.css');
    // The stable context is no longer byte-empty for {} — it always carries
    // the host asset-fetch-identity rule (J1-01) — but it still must not
    // impose a design-system binding with no active system selected.
    expect(composeOdNextStrategyStableRequestContextV2({})).not.toContain('Copy the complete supplied tokens.css');
  });
});
