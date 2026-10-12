// Output scope: a working site, or a static prototype whose controls are not wired. Shared:
// edit plugins/_official/shared/agency-compiler, then sync. Rationale: that folder's README.md.

export type OutputScope = 'site' | 'static-prototype';

/** What `renderFamily` supplies to every family render. */
export type FamilyRenderOptions = { readonly outputScope: OutputScope };

/** The attribute that marks the note, and the value a static prototype carries. */
export const OUTPUT_SCOPE_ATTRIBUTE = 'data-od-output-scope';

/** The note's text. Family pages render in English only (`<html lang="en">`). */
export const STATIC_PROTOTYPE_NOTE = 'Static prototype: navigation and controls are not wired.';

/** The static-prototype footer note. `className` must use utilities the family CSS carries. */
export function staticPrototypeNote(className: string): string {
  return `<footer class="${className}"><p role="note" class="text-xs text-gray-700" ${OUTPUT_SCOPE_ATTRIBUTE}="static-prototype">${STATIC_PROTOTYPE_NOTE}</p></footer>`;
}

/** The note for the supplied scope: the static-prototype footer, or nothing for a site. */
export function outputScopeNote(options: FamilyRenderOptions, className: string): string {
  return options.outputScope === 'static-prototype' ? staticPrototypeNote(className) : '';
}

/** Throws unless the page carries exactly one note for a static prototype and none for a site. */
export function assertRenderedOutputScope(html: string, supplied: OutputScope, family: string): void {
  const notes = html.split(`${OUTPUT_SCOPE_ATTRIBUTE}="static-prototype"`).length - 1;
  const expected = supplied === 'static-prototype' ? 1 : 0;
  if (notes !== expected) {
    throw new Error(`${family}: output scope ${supplied} was supplied, but the rendered page carries ${notes} static-prototype note(s); expected ${expected}`);
  }
}
