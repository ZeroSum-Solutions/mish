// Optional sections: a section the schema marks `x-optional` is dropped as `null` in its slot and
// renders nothing. Shared file: edit plugins/_official/shared/agency-compiler, then sync.

export function presentSections<S>(list: ReadonlyArray<S | null>): S[] {
  return list.filter((section): section is S => section !== null);
}

/** `undefined` when the recipe dropped that section. */
export function sectionOfType<S extends { type: string }>(recipe: { sections: ReadonlyArray<S | null> }, type: string): S | undefined {
  return recipe.sections.find((section): section is S => section !== null && section.type === type);
}

/** `html` (a link to `section`) when the section renders, else `''`. */
export function linkTo(section: { id: string } | null | undefined, html: string): string {
  return section ? html : '';
}

/** `null` in a slot whose type the family marks optional: a legal drop. */
export function isDroppedOptional(raw: unknown, type: string | undefined, optional: ReadonlySet<string>): boolean {
  return raw === null && type !== undefined && optional.has(type);
}

/**
 * A shared, family-agnostic link-honesty check on a FULLY RENDERED page: every `<a href="...">`
 * must resolve to something real — an in-page anchor (`#<id>`) whose target element actually
 * renders on this same page, or a real destination (`http://`, `https://`, `mailto:` or `tel:`).
 * Anything else — a bare `#`, a relative path like `/careers` or `/privacy-policy`, or any other
 * invented-looking destination that implies a page or document this compiler never builds — is
 * returned as an offending href. Every family composes its nav and footer links from the SAME
 * fixed spine (a fixed label pointing at a section id, or a model-authored label whose href the
 * family's own render.ts derives from a real supplied fact, never free text the model also
 * chooses the destination for), so this one structural check applies unchanged to every family
 * that ships at least one link: no per-family wiring is needed for the check itself, only for
 * calling it. Returns an empty array when every link is honest.
 */
/**
 * A sibling check to `dishonestLinks`, for a failure class that check cannot see: an `<a href>`
 * whose target IS the section it already sits inside — `href="#restaurant-reservations"` on the
 * reservations section's own call-to-action button. `dishonestLinks` only asks whether the id
 * exists on the page; it exists here (the element is inside its own section), so a self-section
 * anchor passes that check while still being a dead button (clicking it, at best, scrolls to the
 * top of the block the visitor is already reading). A round of Grok audit found this shipped
 * across six families as a placeholder for "no real destination" — see the fixed families'
 * `render.ts` for the honest replacement (a real url/phone/email link, or plain text with no
 * button styling).
 *
 * Detection is structural, not per-family: every reconcilable slot's `data-od-id` is
 * `<sectionId>--<field>` (or deeper), so an anchor's own containing section id is the text before
 * its FIRST `--`. An anchor legitimately pointing at another section (a nav link, a header's buy
 * button) is never flagged; only `href="#<that same prefix>"` is.
 */
export function selfSectionAnchors(html: string): string[] {
  const offending: string[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = match[1]!;
    const hrefMatch = /\shref="([^"]*)"/.exec(attrs);
    const idMatch = /\sdata-od-id="([^"]+)"/.exec(attrs);
    if (!hrefMatch || !idMatch) continue;
    const href = hrefMatch[1]!;
    if (!href.startsWith('#')) continue;
    const target = href.slice(1);
    const ownSection = idMatch[1]!.split('--')[0]!;
    if (target.length > 0 && target === ownSection) offending.push(`${idMatch[1]} -> ${href}`);
  }
  return offending;
}

export function dishonestLinks(html: string): string[] {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
  const offending: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)) {
    const href = match[1]!;
    if (href.startsWith('#')) {
      const target = href.slice(1);
      if (target.length > 0 && ids.has(target)) continue;
      offending.push(href);
      continue;
    }
    // A scheme alone (bare "http:", "tel:", "mailto:" with nothing after it) is not a real
    // destination — require actual content following the scheme, not just its presence.
    if (/^https?:\/\/\S+/i.test(href) || /^mailto:\S+/i.test(href) || /^tel:\S+/i.test(href)) continue;
    offending.push(href);
  }
  return offending;
}
