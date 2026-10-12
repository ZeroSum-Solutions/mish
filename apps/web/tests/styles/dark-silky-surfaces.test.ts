import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

const tokensCss = read('styles/tokens.css');
const materialCss = read('styles/material.css');
const entryCss = read('styles/home/entry-layout.css');
const designSystemsCss = read('components/DesignSystemsTab.module.css');
const pluginsCss = read('styles/home/plugin-marketplace-demo.css');
const routinesCss = read('styles/viewer/routines.css');
const designFilesCss = read('styles/workspace/design-files.css');
const drawerCss = read('styles/workspace/drawer.css');
const shellCss = read('styles/shell.css');
const chatCss = read('styles/chat.css');

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('silky-black dark appearance', () => {
  it('uses near-black material layers instead of the legacy gray glass', () => {
    const explicitDark = cssDeclarations(materialCss, "[data-theme='dark']");

    expect(ruleValue(explicitDark, '--material-ultrathin')).toBe('rgba(14, 14, 16, 0.58)');
    expect(ruleValue(explicitDark, '--material-thin')).toBe('rgba(14, 14, 16, 0.72)');
    expect(ruleValue(explicitDark, '--material-regular')).toBe('rgba(14, 14, 16, 0.84)');
    expect(ruleValue(explicitDark, '--material-thick')).toBe('rgba(18, 18, 20, 0.92)');

    for (const value of [
      'rgba(14, 14, 16, 0.58)',
      'rgba(14, 14, 16, 0.72)',
      'rgba(14, 14, 16, 0.84)',
      'rgba(18, 18, 20, 0.92)',
    ]) {
      expect(materialCss.match(new RegExp(value.replace(/[().]/g, '\\$&'), 'g'))).toHaveLength(2);
    }
  });

  it('gives selection ink a readable dark-theme value in explicit and system dark mode', () => {
    const explicitDark = cssDeclarations(tokensCss, '[data-theme="dark"]');

    expect(ruleValue(explicitDark, '--select-ink')).toBe('var(--text-strong)');
    expect(ruleValue(explicitDark, '--selected')).toBe('var(--text-strong)');
    expect(tokensCss.match(/--select-ink:\s*var\(--text-strong\);/g)).toHaveLength(2);
    expect(tokensCss.match(/--selected:\s*var\(--text-strong\);/g)).toHaveLength(2);
  });

  it('keeps the navigation rail black and its selected rows theme-aware', () => {
    expect(ruleValue(cssDeclarations(entryCss, '.entry-nav-rail__panel'), '--rail-surface'))
      .toBe('var(--glass-regular)');

    const moduleSelected = cssDeclarations(designSystemsCss, '.itemRowActive');
    expect(ruleValue(moduleSelected, 'background')).toBe('var(--bg-elevated)');
    expect(ruleValue(moduleSelected, 'border-color')).toBe('var(--border-strong)');

    const legacySelected = cssDeclarations(
      entryCss,
      '[data-testid="design-systems-tab"] > aside div:has(> [data-testid^="design-system-card-"][aria-pressed="true"])',
    );
    expect(ruleValue(legacySelected, 'background')).toBe('var(--bg-elevated)');
    expect(ruleValue(legacySelected, 'border-color')).toBe('var(--border-strong)');
  });

  it('uses theme surfaces for every plugin segmented-control selection', () => {
    for (const selector of [
      '.plugin-marketplace__switch button.is-active',
      '.plugin-marketplace__filters button.is-active',
      '.plugin-marketplace__category-tags button.is-active',
      '.plugin-marketplace__create-tabs button.is-active',
    ]) {
      const selected = cssDeclarations(pluginsCss, selector);
      // The segmented-thumb recipe, not a raw colour: `--segmented-thumb`
      // resolves to `--bg-muted` in dark theme (see styles/tokens.css), which
      // is distinct from (and darker than) `--bg-elevated` — the previous
      // pin asserted the wrong theme surface for a selected segment.
      expect(ruleValue(selected, 'background'), selector).toBe('var(--segmented-thumb)');
      expect(ruleValue(selected, 'box-shadow'), selector).toBe('var(--segmented-thumb-shadow)');
    }
  });

  it('keeps project navigation and Design Files chrome on dark theme surfaces', () => {
    for (const selector of [
      '.split-chat-collapse',
      '.workspace-tabs-dropdown__trigger',
      '.workspace-tabs-dropdown__menu',
      '.workspace-shell .workspace-tab.is-active',
    ]) {
      expect(ruleValue(cssDeclarations(routinesCss, selector), 'background'), selector)
        .toBe('var(--bg-elevated)');
    }

    for (const selector of ['.app .df-panel', '.app .df-main', '.app .df-body']) {
      expect(ruleValue(cssDeclarations(routinesCss, selector), 'background'), selector)
        .toBe('var(--bg)');
    }
    expect(ruleValue(cssDeclarations(designFilesCss, '.df-empty'), 'background-color'))
      .toBe('var(--bg)');
    expect(ruleValue(cssDeclarations(designFilesCss, '.df-card'), 'background'))
      .toBe('var(--bg-elevated)');
    expect(ruleValue(cssDeclarations(shellCss, '.avatar-static-value'), 'background'))
      .toBe('var(--bg-elevated)');
  });

  it('marks the active file-workspace tab with the segmented-thumb recipe and no double highlight', () => {
    const active = cssDeclarations(drawerCss, '.ws-tab.active');
    expect(ruleValue(active, 'background')).toBe('var(--segmented-thumb)');
    expect(ruleValue(active, 'box-shadow')).toBe('var(--segmented-thumb-shadow)');
    expect(ruleValue(active, 'color')).toBe('var(--text-strong)');

    // The hover fill must be guarded against the active tab (one highlight
    // per tab at any time), not left to rely on selector source order.
    expect(drawerCss).toMatch(/\.ws-tab:hover:not\(\.active\)\s*\{/);
  });

  it('keeps user messages as a readable dark-on-dark layer instead of a white card', () => {
    const base = cssDeclarations(chatCss, '.msg.user');
    const dark = cssDeclarations(chatCss, '[data-theme="dark"] .msg.user');
    const bubble = cssDeclarations(chatCss, '.msg.user .user-text');

    expect(ruleValue(base, '--chat-user-bubble-ink')).toBe('var(--bg)');
    expect(ruleValue(dark, '--chat-user-bubble-ground')).toBe('var(--bg-muted)');
    expect(ruleValue(dark, '--chat-user-bubble-ink')).toBe('var(--text-strong)');
    expect(ruleValue(bubble, 'color')).toBe('var(--chat-user-bubble-ink)');
  });
});
