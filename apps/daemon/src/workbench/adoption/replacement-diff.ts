/** Lines past this bound are summarized instead of diffed, so a review never stalls the daemon. */
const MAX_DIFF_LINES = 2000;

const looksBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);

/**
 * A line diff of the project's current bytes against the incoming bytes, in
 * unified style (` ` kept, `-` current, `+` incoming). Binary or oversize
 * content gets a one-line summary with both sizes; the caller still shows
 * the digests.
 */
export function lineDiff(current: Buffer, incoming: Buffer): string {
  if (looksBinary(current) || looksBinary(incoming)) return `binary content differs (${current.length} → ${incoming.length} bytes)`;
  const a = current.toString('utf8').split('\n'), b = incoming.toString('utf8').split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return `content differs (${a.length} → ${b.length} lines; too large to show inline)`;
  // Longest common subsequence table, from the end, then one forward walk.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join('\n');
}
