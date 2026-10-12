// Deterministic intent guards around the R15 transformer. The model proposes a
// brief; these checks keep what the user explicitly asked for (style, runtime,
// stated facts) from being dropped, modernized or invented.

const STYLE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bwin(?:dows)?\s*-?\s*95\b|\bwin95\b/iu, 'Windows 95'],
  [/\bwin(?:dows)?\s*-?\s*98\b|\bwin98\b/iu, 'Windows 98'],
  [/\bwindows\s*xp\b/iu, 'Windows XP'],
  [/\bmac\s*os\s*(?:9|classic)\b|\bclassic mac\b/iu, 'Classic Mac OS'],
  [/\by2k\b/iu, 'Y2K'],
  [/\bvaporwave\b/iu, 'Vaporwave'],
  [/\b(?:neo-?)?brutalis[mt]\b/iu, 'Brutalist'],
  [/\bpixel[- ]?art\b|\b8-?bit\b|\b16-?bit\b/iu, 'Pixel art'],
  [/\bskeuomorph(?:ic|ism)\b/iu, 'Skeuomorphic'],
  [/\bart deco\b/iu, 'Art Deco'],
  [/\b(?:crt|terminal|green[- ]screen)\s+(?:style|look|aesthetic)\b/iu, 'Terminal / CRT'],
  [/\bretro\b/iu, 'Retro'],
];

const RUNTIME_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bnext\.?js\b/iu, 'Next.js'],
  [/\breact\s+native\b/iu, 'React Native'],
  [/\breact\b/iu, 'React'],
  [/\bvue(?:\.js)?\b/iu, 'Vue'],
  [/\bsvelte(?:kit)?\b/iu, 'Svelte'],
  [/\bangular\b/iu, 'Angular'],
  [/\bastro\b/iu, 'Astro'],
  [/\bswiftui\b/iu, 'SwiftUI'],
  [/\bflutter\b/iu, 'Flutter'],
  [/\b(?:plain|vanilla|static)\s+html\b|\bhtml\s*(?:\/|,|and)\s*css\b/iu, 'HTML/CSS/JS'],
];

/** Explicit style directions in the user's own words, in first-mention order. */
export function detectStyleDirections(text: string): string[] {
  const found: Array<[number, string]> = [];
  for (const [pattern, label] of STYLE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && !found.some(([, existing]) => existing === label)) found.push([match.index, label]);
  }
  const labels = found.sort((a, b) => a[0] - b[0]).map(([, label]) => label);
  // "Retro" adds nothing when a specific retro style is already named.
  return labels.length > 1 ? labels.filter(label => label !== 'Retro') : labels;
}

/** The first explicitly named target runtime, or null. React Native and Next.js win over a bare React mention. */
export function detectTargetRuntime(text: string): string | null {
  for (const [pattern, label] of RUNTIME_PATTERNS) if (pattern.test(text)) return label;
  return null;
}

const MODERN_TERMS = /\b(modern|contemporary|minimalist|sleek|flat design|glassmorphism|neumorphism|frosted glass)\b/giu;

/** Generic-modern wording the model used that the user never wrote (a silent modernization of an explicit style). */
export function modernDrift(original: string, candidateTexts: readonly string[]): string[] {
  const originalLower = original.toLowerCase();
  const terms = new Set<string>();
  for (const value of candidateTexts) {
    for (const match of value.matchAll(MODERN_TERMS)) {
      const term = match[0]!.toLowerCase();
      if (!originalLower.includes(term)) terms.add(term);
    }
  }
  return [...terms];
}

const HOST_INSTRUCTION = /\b(?:ignore|disregard|override)\b[^.]{0,40}\b(?:instructions?|rules|prompt)\b|\bsystem prompt\b|\bdeveloper (?:message|prompt)\b|<\/?[a-z][a-z-]*[\s>]|\bapi[_ -]?keys?\b|\bpasswords?\b|\b(?:secret|access|auth|bearer) (?:keys?|tokens?)\b|\brm\s+-rf\b|\b(?:curl|wget)\s+https?:|\bexfiltrat|\b(?:run|execute)\s+(?:the\s+)?(?:shell|command|script)\b|\bwrite (?:files?|to)\s+\//iu;

/** Reference or provider text that tries to act as host authority. Such proposals are dropped, never rendered. */
export function looksLikeHostInstruction(value: string): boolean {
  return HOST_INSTRUCTION.test(value);
}

const NUMBER_TOKEN = /[$€£]?\d[\d,.]*(?:%|k|m)?/giu;

/** Number-like facts in `value` that the source text never contained (prices, counts, years, percentages). */
export function unsupportedNumbers(value: string, sourceText: string): string[] {
  const source = sourceText.toLowerCase();
  return [...new Set([...value.matchAll(NUMBER_TOKEN)].map(match => match[0]!.replace(/[.,]+$/u, '')).filter(token => token && !source.includes(token.toLowerCase())))];
}
