/**
 * The check behind the faithfulness gate's `x-mock` exclusion (jev.ts, spine.ts `mockPathsFor`):
 * a family page may show an unverified sample value only under its fixed, template-owned caption.
 * The same helper is duplicated in the four families' own `render.test.ts` (plugins cannot import
 * package test code); keep the two copies in step.
 */

import assert from 'node:assert/strict';

/** A recipe path label (`sections[3].items[0].price`) as segments. */
const pathSegments = (label: string): (string | number)[] => (label.match(/[^.[\]]+/g) ?? []).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
/** The first letter or digit of a value, changed; the length and the format (email, phone) hold. */
function perturb(value: string): string {
  const at = value.search(/[A-Za-z0-9]/);
  assert.ok(at >= 0, `"${value}" has a letter or digit to change`);
  const char = value[at]!;
  const next = /[0-9]/.test(char) ? String((Number(char) + 1) % 10) : /[a-z]/.test(char) ? (char === 'a' ? 'b' : 'a') : (char === 'A' ? 'B' : 'A');
  return value.slice(0, at) + next + value.slice(at + 1);
}
/** A copy of the recipe with the one string at `label` perturbed. */
function withPerturbed(recipe: unknown, label: string): unknown {
  const copy = structuredClone(recipe) as Record<string | number, unknown>;
  const segments = pathSegments(label);
  let parent = copy;
  for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string | number, unknown>;
  const last = segments.at(-1)!;
  assert.equal(typeof parent[last], 'string', `${label} is a string in the recipe`);
  parent[last] = perturb(parent[last] as string);
  return copy;
}
/** Where `after` differs from `before` (same length): the first and the last changed index. */
function changedSpan(before: string, after: string): [number, number] {
  let first = 0;
  while (first < before.length && before[first] === after[first]) first += 1;
  let tail = 0;
  while (tail < before.length - first && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return [first, after.length - 1 - tail];
}
/** The index of the tag closing the element that opens at `start`. */
function closingTagAt(html: string, tag: string, start: number): number {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return html.length;
}
/** The innermost element carrying a sample-data region mark (any `data-od-mock` but the caption) around `at`. */
function sampleRegionAt(html: string, at: number): { start: number; end: number } | undefined {
  let found: { start: number; end: number } | undefined;
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\sdata-od-mock="(?!caption")[^"]*"[^>]*>/g)) {
    const start = match.index!;
    const end = closingTagAt(html, match[1]!, start);
    if (start < at && at < end && (!found || start > found.start)) found = { start, end };
  }
  return found;
}
const CAPTION_ELEMENT = /<p\b[^>]*\sdata-od-mock="caption"[^>]*>([^<]*)<\/p>/g;
const escapeText = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
/**
 * The proof behind the fast lane's x-mock exclusion. Every caption on the page is the fixed
 * template sentence with no edit target; and for each x-mock path, changing that one value
 * changes the page only inside one sample-data region, after that region's fixed caption, and
 * inside an element that follows the caption (the value's `data-od-id` element).
 */
export function assertCaptionBacksEveryMockValue(recipe: unknown, paths: string[], render: (recipe: unknown) => string, caption: string): void {
  const html = render(recipe);
  const captions = [...html.matchAll(CAPTION_ELEMENT)];
  assert.ok(captions.length > 0, 'the page shows a caption');
  for (const match of captions) {
    assert.equal(match[1], escapeText(caption), 'every caption is the fixed template sentence');
    assert.ok(!match[0].includes('data-od-id'), 'a caption is never an edit target');
  }
  for (const label of paths) {
    const changed = render(withPerturbed(recipe, label));
    assert.notEqual(changed, html, `${label}: the value renders`);
    const [first, last] = changedSpan(html, changed);
    const region = sampleRegionAt(changed, first);
    assert.ok(region, `${label}: the value sits inside a data-od-mock sample-data region`);
    assert.ok(last < region.end, `${label}: every rendering of the value stays inside that one region`);
    const before = changed.slice(region.start, first);
    const captionMatches = [...before.matchAll(CAPTION_ELEMENT)];
    assert.ok(captionMatches.some((match) => match[1] === escapeText(caption)), `${label}: the region's fixed caption precedes the value`);
    const captionEnd = region.start + before.lastIndexOf(captionMatches.at(-1)![0]) + captionMatches.at(-1)![0].length;
    const idAt = changed.lastIndexOf('data-od-id="', first);
    const owner = changed.lastIndexOf('<', idAt);
    assert.ok(owner >= captionEnd, `${label}: its data-od-id element (${/data-od-id="([^"]+)"/.exec(changed.slice(idAt))?.[1]}) follows the caption`);
  }
}
