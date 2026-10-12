/**
 * Pins the PR #188 review findings on the library and balance dialogs:
 * - the library panels stay 16px in every scope (`--radius-xl` is 20px under
 *   workspace-ui.css, so no token keeps the old size there);
 * - a disabled sign-in pill action neither lifts on hover nor presses;
 * - the CTA press rule outranks Button's own `:active:not(:disabled)`;
 * - preview nav arrows do not travel sideways under reduced motion;
 * - the dropzone keeps the shared 2px focus offset in the workspace scope.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const componentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'components');
const read = (name: string) => readFileSync(join(componentsDir, `${name}.module.css`), 'utf8');

function ruleBody(css: string, selectorPattern: RegExp): string | undefined {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorPattern.test(match[1] ?? '')) return match[2];
  }
  return undefined;
}

describe('library and balance dialog review fixes', () => {
  it.each(['LibraryPreviewModal', 'LibraryUploadModal'])('%s panel keeps a 16px radius', (name) => {
    const body = ruleBody(read(name), /^\s*\.modal\s*$/);
    expect(body).toMatch(/border-radius:\s*16px/);
  });

  it('guards the sign-in pill hover and press with :not(:disabled)', () => {
    const css = read('AmrBalanceDialog');
    expect(css).not.toMatch(/amr-account-control__action:(hover|active)\)/);
    expect(css).toMatch(/amr-account-control__action:hover:not\(:disabled\)\)/);
    expect(css).toMatch(/amr-account-control__action:active:not\(:disabled\)\)/);
  });

  it('scopes the CTA press so it outranks the shared Button press rule', () => {
    const css = read('AmrBalanceDialog');
    expect(ruleBody(css, /^\s*\.actions \.cta:active:not\(:disabled\)\s*$/)).toMatch(/var\(--motion-press\)/);
  });

  it('drops nav arrow travel under reduced motion', () => {
    const css = read('LibraryPreviewModal');
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    for (const selector of ['.navPrev:hover', '.navNext:hover', '.navPrev:active', '.navNext:active']) {
      expect(block).toContain(selector);
    }
    expect(block).toMatch(/transform:\s*translateY\(-50%\);/);
  });

  it('keeps the dropzone focus offset on the shared token in the workspace scope', () => {
    const body = ruleBody(read('LibraryUploadModal'), /data-ui-system='workspace'\]\) \.modal \.dropzone:focus-visible/);
    expect(body).toMatch(/outline-offset:\s*var\(--focus-offset\)/);
  });
});
