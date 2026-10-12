/**
 * Pure naming stage shared by publication and its generator; it never loads generated data.
 * Swap the adapter's exact internal name for its reviewed public slug in `cult-`/`sym-` tokens
 * and element-id references. Longer unrelated names and external hrefs stay unchanged.
 * The caller supplies the public id, so generating the remaining public names never needs to
 * import the JSON file it is creating.
 */
export function publicAdapterNamesForId(adapterId: string, text: string, publicId: string): string {
  if (!adapterId.startsWith('cult:') || publicId === adapterId) return text;
  const name = adapterId.slice('cult:'.length).replace(/[^a-z0-9-]/g, '');
  const slug = publicId.slice('cult:'.length);
  // The name as a whole token: not inside a longer word, and followed by the end, a separator or a
  // `-…` suffix (`-name`, `-work-email`). The text is this adapter's own output, so an id there
  // that starts with its name is its own.
  const token = `(?<![a-z0-9-])${name}(?=-[a-z0-9]|[^a-z0-9-]|$)`;
  const prefixed = text.replace(new RegExp(`(?<![a-z0-9-])(cult|sym)-${name}(?=-\\d|[^a-z0-9-]|$)`, 'g'), `$1-${slug}`);
  return prefixed.replace(/(\s(?:id|for|aria-[a-z-]+|href)=")([^"]*)"/g, (_match, lead: string, value: string) => {
    if (lead.includes('href') && !value.startsWith('#')) return `${lead}${value}"`;
    return `${lead}${value.replace(new RegExp(token, 'g'), slug)}"`;
  });
}

/** The attributes whose value is prose a person reads or hears, not an identifier. */
export const PROSE_ATTRIBUTES: readonly string[] = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'alt', 'placeholder'];
