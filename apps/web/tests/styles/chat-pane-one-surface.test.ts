import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The chat column is ONE surface (wave 2, Devin's feedback): the pane's
// material is the only paint; the header, transcript and composer dock are
// transparent over it, and the composer card floats on it. A solid
// `--bg-panel` on the transcript or the dock in dark mode drew a hard seam
// where the composer area began.
const routinesCss = readFileSync(new URL('../../src/styles/viewer/routines.css', import.meta.url), 'utf8');

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`, 'g'))];
  return matches.at(-1)?.[1]?.trim();
}

describe('chat pane is one continuous surface', () => {
  it('paints the pane from one named ground in both themes', () => {
    const pane = cssDeclarations(routinesCss, '.app .split-chat-slot > .pane');
    expect(ruleValue(pane, 'background')).toBe('var(--chat-pane-ground)');

    const dark = cssDeclarations(routinesCss, "[data-theme='dark'] .app .split-chat-slot > .pane");
    expect(ruleValue(dark, '--chat-pane-ground')).toBe('var(--material-regular)');
    expect(ruleValue(dark, 'background')).toBeUndefined();
  });

  it('never paints the transcript or the composer dock in dark mode', () => {
    for (const selector of [
      '[data-theme="dark"] .app .chat-log',
      '[data-theme="dark"] .chat-composer-fixed-layer .composer',
      '[data-theme="dark"] .chat-composer-fixed-layer .composer-shell',
    ]) {
      expect(cssDeclarations(routinesCss, selector), selector).toBe('');
    }
    expect(ruleValue(cssDeclarations(routinesCss, '.chat-composer-fixed-layer .composer'), 'background'))
      .toBe('transparent');
  });

  it('lets the header repeat the pane ground instead of a second glass tint', () => {
    expect(ruleValue(cssDeclarations(routinesCss, '.app .chat-project-header'), 'background'))
      .toBe('var(--chat-pane-ground, var(--glass-regular))');
    expect(ruleValue(cssDeclarations(routinesCss, '.app .chat-project-header::after'), 'background'))
      .toBe('linear-gradient(to bottom, var(--chat-pane-ground, var(--glass-regular)), transparent)');
  });

  it('floats the composer card at the dock inset with a radius under the pane radius', () => {
    const dock = cssDeclarations(routinesCss, '.chat-composer-fixed-layer .composer');
    const shell = cssDeclarations(routinesCss, '.chat-composer-fixed-layer .composer-shell');
    expect(ruleValue(dock, 'padding')).toBe('var(--space-2)');
    expect(ruleValue(shell, 'border-radius')).toBe('var(--radius-md)');
  });
});
