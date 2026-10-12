/**
 * Modals whose backdrop and panel are `motion.div`s already get their entrance
 * and exit from Framer Motion (`modalOverlay` / `modalContent` in
 * `src/motion.ts`). A CSS `animation` on the same element fights the inline
 * transform/opacity Framer writes, so the panel double-animates on open.
 * The UI-system polish pass added exactly that to FigmaImportModal; this pins
 * every Framer-driven modal's backdrop/panel classes to "no CSS animation".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const componentsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'components');

const FRAMER_DRIVEN: ReadonlyArray<{ component: string; classes: readonly string[] }> = [
  { component: 'FigmaImportModal', classes: ['backdrop', 'modal'] },
  { component: 'LibraryPreviewModal', classes: ['backdrop', 'modal'] },
  { component: 'LibraryUploadModal', classes: ['backdrop', 'modal'] },
];

function ruleBodies(css: string, className: string): string[] {
  const bodies: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selector = match[1] ?? '';
    if (new RegExp(`\\.${className}(?![\\w-])`).test(selector) && !selector.includes('@')) {
      bodies.push(match[2] ?? '');
    }
  }
  return bodies;
}

describe('Framer-driven modals carry no CSS entrance animation', () => {
  it.each(FRAMER_DRIVEN)('$component backdrop and panel are motion elements without CSS animation', ({ component, classes }) => {
    const tsx = readFileSync(join(componentsDir, `${component}.tsx`), 'utf8');
    const css = readFileSync(join(componentsDir, `${component}.module.css`), 'utf8');
    for (const className of classes) {
      expect(tsx, `${component}.tsx no longer renders styles.${className} on a motion element`).toMatch(
        new RegExp(`<motion\\.\\w+[^>]*className=\\{styles\\.${className}\\}`),
      );
      for (const body of ruleBodies(css, className)) {
        expect(body, `.${className} in ${component}.module.css`).not.toMatch(/(^|\s)animation(-name)?\s*:\s*(?!none)/);
      }
    }
  });
});
