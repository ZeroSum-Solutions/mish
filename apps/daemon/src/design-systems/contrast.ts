/** Readable presentation colors; recorded source tokens remain unchanged. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const rgb = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const channels = [0, 2, 4].map((i) => {
    const n = parseInt(rgb.slice(i, i + 2), 16) / 255;
    return n <= .04045 ? n / 12.92 : Math.pow((n + .055) / 1.055, 2.4);
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function readableColor(candidate: string, background: string): string {
  if (contrastRatio(candidate, background) >= 4.5) return candidate;
  return contrastRatio('#111111', background) >= contrastRatio('#ffffff', background) ? '#111111' : '#ffffff';
}
