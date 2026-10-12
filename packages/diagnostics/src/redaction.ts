const SENSITIVE_KEY_RE = /token|password|secret|key|dsn|authorization|cookie/i;

// Leave leading whitespace, escapes and quotes for the fail-closed assignment scanner.
const URL_QUERY_SECRET_RE = /([?&#])(token|password|secret|key|dsn|api[_-]?key|auth|access_token|refresh_token|id_token)(=)(?![\\\s"'])((?:\[REDACTED\]|[^&\s#"'\[{])*)/gi;

// Scan complete bare identifiers once, without consuming public values that
// can themselves contain a credential assignment. Boundaries keep this linear
// even for long identifiers or whitespace runs; key policy is shared with JSON.
const BARE_ASSIGNMENT_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\s*[:=]\s*/g;
const BARE_VALUE_RE = /[^\s,;]+/y;
// Detect keys without consuming values: a public field can contain another
// encoded credential object. Malformed credential fragments are masked to end.
const QUOTED_KEY_RE = /["']([A-Za-z0-9_.-]+)\\*["']\s*:/g;

// Bearer / Token / Basic auth schemes embed the secret after the scheme
// keyword, so a bare scalar stops at the space before `Bearer` and
// leaves the actual credential exposed. This pattern matches the scheme +
// credential as one unit. Case-insensitive: HTTP auth schemes are
// case-insensitive per RFC 7235 §2.1, and we routinely see lowercase
// `authorization: bearer …` in proxy / curl-style logs.
// Character class covers RFC 6750 token68 (ALPHA / DIGIT / "-" / "." / "_"
// / "~" / "+" / "/" / "=") plus ":" for Basic credentials. Missing "~"
// previously left tokens like `Bearer abcd~efgh` partially exposed.
const HTTP_AUTH_SCHEME_RE = /\b(Bearer|Token|Basic)\s+([A-Za-z0-9._~\-+/=:]{4,})/gi;

const REDACTED = "[REDACTED]";
const MAX_JSON_STRING_DEPTH = 8;
const MAX_STRUCTURE_DEPTH = 64;

export interface RedactionOptions {
  username?: string | undefined;
}

// Scan @ (or URL-encoded %40) delimiters with fixed address-length bounds. Unlike an unanchored
// email regex, long identifier/domain near-misses cannot restart an unbounded
// search at each character. This covers ordinary ASCII mailbox addresses;
// arbitrary encodings and opaque payloads remain outside text redaction.
export function redactEmailAddresses(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  const separators = /@|%40/g;
  for (;;) {
    const separator = separators.exec(text);
    if (!separator) break;
    const at = separator.index;
    const domainStart = at + separator[0].length;
    let start = at;
    while (start > 0 && at - start < 64 && /[A-Za-z0-9._%+-]/.test(text[start - 1]!)) start--;
    if (start === at || (start > 0 && /[A-Za-z0-9._%+-]/.test(text[start - 1]!))) continue;
    let end = domainStart;
    while (end < text.length && end - domainStart < 254 && /[A-Za-z0-9.-]/.test(text[end]!)) end++;
    if (end - domainStart === 254 && /[A-Za-z0-9.-]/.test(text[end] ?? '')) continue;
    while (/[.-]/.test(text[end - 1] ?? '')) end--;
    if (end - domainStart > 253) continue;
    const domain = text.slice(domainStart, end);
    const labels = domain.split('.');
    if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) continue;
    // Package versions such as pnpm@10.33.2 are public diagnostic text.
    const finalLabel = labels[labels.length - 1]!;
    if (!/^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/i.test(finalLabel)) {
      // A filename/tag suffix can touch an ordinary alphabetic TLD. Keep the
      // suffix public without letting numeric package versions become addresses.
      const prefix = /^[A-Za-z]{2,63}(?=[0-9-])/.exec(finalLabel)?.[0];
      if (!prefix) continue;
      end -= finalLabel.length - prefix.length;
    }
    parts.push(text.slice(cursor, start), REDACTED);
    cursor = end;
    separators.lastIndex = end;
  }
  if (cursor === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function redactJsonValue(value: unknown, opts: RedactionOptions = {}): unknown {
  return redactJsonValueAtDepth(value, opts, 0);
}

function redactJsonValueAtDepth(value: unknown, opts: RedactionOptions, jsonStringDepth: number, sensitive = false, structureDepth = 0): unknown {
  if (value !== null && typeof value === "object" && structureDepth >= MAX_STRUCTURE_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactJsonValueAtDepth(entry, opts, jsonStringDepth, sensitive, structureDepth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    const reserved = new Set(entries.map(([key]) => key).filter((key) => redactEmailAddresses(key) === key));
    const nextConflict = new Map<string, number>();
    for (const [key, raw] of entries) {
      const safeKey = redactEmailAddresses(key);
      let outputKey = safeKey;
      if (safeKey !== key) {
        let conflict = nextConflict.get(safeKey) ?? 1;
        while (reserved.has(outputKey)) outputKey = `${safeKey}-${++conflict}`;
        nextConflict.set(safeKey, conflict);
        reserved.add(outputKey);
      }
      out[outputKey] = redactJsonValueAtDepth(raw, opts, jsonStringDepth, sensitive || SENSITIVE_KEY_RE.test(key), structureDepth + 1);
    }
    return out;
  }
  if (typeof value === "string") return sensitive && value.length > 0 ? REDACTED : redactTextAtDepth(value, opts, jsonStringDepth);
  return value;
}

export function redactText(text: string, opts: RedactionOptions = {}): string {
  return redactTextAtDepth(text, opts, 0);
}

function redactTextAtDepth(text: string, opts: RedactionOptions, jsonStringDepth: number): string {
  // Run events are JSONL text, and stderr chunks can themselves contain JSON.
  // Decode before redaction, then re-encode so quotes/backslashes remain valid.
  // Preserve line separators and stop decoding deeply nested JSON strings.
  const redactStructured = (candidate: string): string | null => {
    const start = candidate.search(/[\[{]/);
    if (start !== -1) {
      let parsed: unknown;
      try { parsed = JSON.parse(candidate.slice(start)); } catch { /* Ordinary text uses the patterns below. */ }
      if (parsed !== undefined) {
        const prefix = candidate.slice(0, start);
        const leading = redactPlainText(prefix, opts, true);
        // Parsing a suffix does not establish a new record boundary. If the prefix started
        // a credential value or was already cut, keep its entire remaining chunk masked.
        if (leading.maskedTail) return leading.text;
        const trailing = candidate.slice(candidate.trimEnd().length);
        const redacted = jsonStringDepth >= MAX_JSON_STRING_DEPTH
          ? REDACTED
          : JSON.stringify(redactJsonValueAtDepth(parsed, opts, jsonStringDepth + 1));
        return `${leading.text}${redacted}${trailing}`;
      }
    }
    return null;
  };
  // A chunk can be pretty-printed JSON; splitting it first loses key context.
  const structured = redactStructured(text);
  if (structured !== null) return structured;
  // Only a complete JSONL stream establishes independent record boundaries.
  // A stray suffix such as `tags: []` cannot reset malformed-chunk masking.
  const lines = text.split(/(\r\n|\r|\n)/).map((line) =>
    !line.trim() ? line : /^\s*[\[{]/.test(line) ? redactStructured(line) : null);
  return lines.every((line) => line !== null) ? lines.join("") : redactPlainText(text, opts).text;
}

function redactPlainText(text: string, opts: RedactionOptions, hasJsonSuffix = false): { text: string; maskedTail: boolean } {
  // Run the HTTP auth scheme replacement first so the credential after
  // `Bearer` / `Token` / `Basic` is captured before bare scalar masking swallows
  // the `Authorization: Bearer` prefix and stops at the space.
  let out = redactEmailAddresses(text).replace(HTTP_AUTH_SCHEME_RE, (_match, scheme) => `${scheme} ${REDACTED}`);
  out = out.replace(URL_QUERY_SECRET_RE, (_match, sep, name, eq) => `${sep}${name}${eq}${REDACTED}`);
  const username = opts.username;
  if (username && username.length > 1) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`/Users/${escaped}(?=[/"\\s])`, "g"), "/Users/<USER>");
    out = out.replace(new RegExp(`\\\\Users\\\\${escaped}(?=[\\\\"\\s])`, "g"), "\\Users\\<USER>");
    out = out.replace(new RegExp(`/home/${escaped}(?=[/"\\s])`, "g"), "/home/<USER>");
  }
  let cut = out.length;
  for (const match of out.matchAll(QUOTED_KEY_RE)) {
    if (SENSITIVE_KEY_RE.test(match[1]!)) { cut = match.index; break; }
  }
  let maskedTail = cut < out.length;
  const suffixBoundary = hasJsonSuffix ? out.trimEnd().length : -1;
  const parts: string[] = [];
  let cursor = 0;
  for (const match of out.matchAll(BARE_ASSIGNMENT_RE)) {
    const compoundHeader = /cookie|authorization/i.test(match[1]!) || match[1]!.toLowerCase() === "auth";
    // A colon header can extend beyond the scalar containing its first credential pair.
    if (match.index < cursor && match.index + match[0].length <= cursor
      && !(compoundHeader && match[0].includes(":"))) continue;
    // `auth` retains the existing bare-field alias; every other name uses the JSON rule.
    if (!SENSITIVE_KEY_RE.test(match[1]!) && match[1]!.toLowerCase() !== "auth") continue;
    if (match.index >= cut) break;
    const start = match.index + match[0].length;
    // The URL pass already masked this query value; its marker is not a container.
    const maskedEnd = start + REDACTED.length;
    const queryMarker = /[?&#]/.test(out[match.index - 1] ?? "") && out.startsWith(REDACTED, start);
    // Only a quote-wrapped HTTP URL proves this quote is a closer. The fixed window
    // bounds work per assignment; longer or malformed tokens safely lose their tail.
    const closesQuotedUrl = queryMarker && /["']/.test(out[maskedEnd] ?? "")
      && out.slice(Math.max(0, match.index - 512), match.index).match(/(?:^|\s)(["'])https?:\/\/[^\s"']*$/)?.[1] === out[maskedEnd];
    if (queryMarker && (maskedEnd === out.length || /[&#\s,;]/.test(out[maskedEnd]!) || closesQuotedUrl)
      && maskedEnd !== suffixBoundary) continue;
    if (compoundHeader || start === out.length || /[\[{"']/.test(out[start]!)) {
      // Cookie pairs and compound authorization schemes form one credential value;
      // scalar separators cannot make later pairs public.
      // A container or quoted value may be truncated. Mask its entire tail rather than
      // trying to find a closing delimiter, even when a JSON suffix happens to parse.
      cut = Math.min(cut, start);
      maskedTail = true;
      break;
    }
    if (start >= cut) break;
    BARE_VALUE_RE.lastIndex = start;
    const value = BARE_VALUE_RE.exec(out);
    if (!value) continue;
    if (/[\[{"']/.test(value[0]) || /^\\+$/.test(value[0]) || start + value[0].length === suffixBoundary) {
      // A final credential scalar in a prefix cannot make its attached JSON suffix public.
      cut = Math.min(cut, start);
      maskedTail = true;
      break;
    }
    parts.push(out.slice(cursor, start), REDACTED);
    cursor = start + value[0].length;
  }
  parts.push(out.slice(cursor, cut), maskedTail ? REDACTED : "");
  return { text: parts.join(""), maskedTail };
}

export function redactJsonText(text: string, opts: RedactionOptions = {}): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactText(text, opts);
  }
  return JSON.stringify(redactJsonValue(parsed, opts), null, 2);
}
