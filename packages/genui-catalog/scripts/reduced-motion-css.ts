/**
 * Derive the forced-preview stylesheet for a component: every rule inside a
 * `@media (prefers-reduced-motion: reduce)` block, re-emitted under a root class.
 *
 * The catalog view's "reduced motion" toggle cannot change the browser's media state inside the
 * demo iframe. `demoDocument(id, { reducedMotion: true })` therefore (1) answers the media query
 * as matching for the component's script and (2) adds `FORCED_REDUCED_MOTION_CLASS` to `<html>`
 * and inlines this derived CSS, so the component's own reduced-motion rules apply as well.
 * Deriving it from the built CSS keeps one source of truth: a porter writes the `@media` block
 * once, in styles.css.
 */

export const FORCED_REDUCED_MOTION_CLASS = 'genui-reduced-motion';

const REDUCE_MEDIA = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;

/** Index just past the `}` that closes the block whose `{` sits at `open - 1`. */
function blockEnd(css: string, open: number): number {
  let depth = 1;
  let index = open;
  for (; index < css.length && depth > 0; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') depth -= 1;
  }
  if (depth !== 0) throw new Error('reduced-motion-css: unbalanced braces');
  return index;
}

/** Split a selector list on top-level commas (not inside `:is(a, b)` or `[x=","]`). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index]!;
    if (quote) { if (char === quote && list[index - 1] !== '\\') quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) { out.push(list.slice(start, index).trim()); start = index + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

function prefixRules(block: string, rootClass: string): string {
  let out = '';
  let index = 0;
  while (index < block.length) {
    const open = block.indexOf('{', index);
    if (open < 0) break;
    const prelude = block.slice(index, open).trim();
    const end = blockEnd(block, open + 1);
    const body = block.slice(open + 1, end - 1);
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) out += `${prelude}{${body}}`;
    else if (prelude.startsWith('@')) out += `${prelude}{${prefixRules(body, rootClass)}}`;
    else out += `${splitSelectors(prelude).map((selector) => `.${rootClass} ${selector}`).join(',')}{${body}}`;
    index = end;
  }
  return out;
}

export function forcedReducedMotionCss(css: string, rootClass = FORCED_REDUCED_MOTION_CLASS): string {
  let out = '';
  for (const match of css.matchAll(REDUCE_MEDIA)) {
    const start = match.index + match[0].length;
    out += prefixRules(css.slice(start, blockEnd(css, start) - 1), rootClass);
  }
  return out;
}
