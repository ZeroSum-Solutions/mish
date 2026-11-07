// Cutting text to a limit without cutting a word. `clip` is the one place text is shortened.

const TRAILING = /[\s,;:.\-–—!?、，。：；…([{"'“‘‍️]+$/u;
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** Trims `s` to at most `max` UTF-16 units (the ellipsis included), at a word boundary where there is one. */
export function clip(s: string, max: number, opts: { ellipsis?: boolean } = {}): string {
  const text = s.trim();
  if (text.length <= max) return text;
  const mark = opts.ellipsis === false ? '' : '…';
  const budget = Math.max(0, max - mark.length);
  let cut = budget;
  if (cut > 0 && isHigh(text.charCodeAt(cut - 1))) cut -= 1; // never split a surrogate pair
  let head = text.slice(0, cut);
  // Mid-word unless the cut lands on whitespace: back up to the last whitespace.
  if (!/\s/.test(text.charAt(cut))) {
    const space = head.search(/\s\S*$/);
    if (space > 0) head = head.slice(0, space);
  }
  head = head.replace(TRAILING, '');
  if (!head && cut > 0) head = text.slice(0, cut).replace(TRAILING, '');
  return head ? head + mark : '';
}

/** A post title from a caption: its first sentence or first line, about 80 characters at most. */
export function captionTitle(caption: unknown, max = 80): string {
  const line = String(caption ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  const sentence = /^.+?[.!?。！？](?=\s|$)/u.exec(line)?.[0] ?? line;
  return clip(sentence, max);
}
