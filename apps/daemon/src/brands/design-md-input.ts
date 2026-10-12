import type { Brand, BrandColor, BrandColorRole, BrandFontSpec } from '@open-design/contracts';

import { luminance, normalizeHex, saturation } from './seed.js';
import { validateBrand } from './validate.js';

export interface BrandFromDesignMdInput {
  markdown: string;
  sourceUrl: string;
  description?: string | undefined;
  fallbackName?: string;
}

interface DesignMdColor {
  key: string;
  hex: string;
}

interface FontCandidate {
  key: string;
  family: string;
}

interface ParsedDesignMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

const DEFAULT_BACKGROUND = '#ffffff';
const DEFAULT_FOREGROUND = '#111111';
const DEFAULT_ACCENT = '#1677ff';
const SANS_FALLBACKS = ['system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'];

export function sourceUrlForDesignMd(markdown: string, fallbackName = 'Design System'): string {
  const parsed = parseDesignMd(markdown);
  const name =
    scalarString(parsed.frontmatter.name) ??
    markdownH1(parsed.body) ??
    fallbackName;
  const slug = slugify(name) || 'design-md';
  return `designmd://${slug}`;
}

export function brandFromDesignMd(input: BrandFromDesignMdInput): Brand | null {
  const markdown = input.markdown.trim();
  if (!markdown) return null;

  const parsed = parseDesignMd(markdown);
  const name =
    scalarString(parsed.frontmatter.name) ??
    markdownH1(parsed.body) ??
    input.fallbackName ??
    'Design System';
  const overview = firstSection(parsed.body, ['overview', 'brand & style', 'brand and style']) ?? firstParagraph(parsed.body);
  const description = input.description?.trim() || scalarString(parsed.frontmatter.description) || overview || '';
  const tagline = firstSentence(overview || description);
  const colors = resolveColors(collectColors(parsed));
  const typography = resolveTypography(parsed);
  const componentNames = collectComponentNames(parsed.frontmatter, parsed.body);
  const radius = firstDimension(parsed.frontmatter.rounded) ?? firstDimension(parsed.frontmatter.radius) ?? '8px';
  const spacing = firstDimension(parsed.frontmatter.spacing) ?? '8px baseline grid';

  const rawBrand = {
    name,
    tagline,
    description,
    sourceUrl: input.sourceUrl,
    logo: {
      primary: null,
      alternates: [],
      notes: 'No logo supplied in pasted DESIGN.md.',
    },
    colors,
    typography,
    voice: {
      adjectives: [],
      tone: description ? firstSentence(description) : '',
      messagingPillars: [description, overview].filter((value, index, arr): value is string =>
        Boolean(value && arr.indexOf(value) === index),
      ),
      vocabulary: { use: [], avoid: [] },
    },
    imagery: {
      style: '',
      subjects: [],
      treatment: '',
      avoid: [],
    },
    layout: {
      radius,
      borderWeight: '1px',
      spacing,
      postureRules: componentNames.length
        ? [`Component kit should cover: ${componentNames.slice(0, 12).join(', ')}.`]
        : [],
    },
  };

  return validateBrand(rawBrand, input.sourceUrl);
}

function parseDesignMd(markdown: string): ParsedDesignMd {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const frontmatterText = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  return { frontmatter: parseSimpleYaml(frontmatterText), body };
}

function parseSimpleYaml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; target: Record<string, unknown> }> = [{ indent: -1, target: root }];

  for (const rawLine of source.split('\n')) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const key = match[2] ?? '';
    const rest = match[3] ?? '';
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.target;
    if (!rest.trim()) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, target: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((part) => scalarString(parseScalar(part)) ?? '')
      .filter(Boolean);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function scalarString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function collectColors(parsed: ParsedDesignMd): DesignMdColor[] {
  const out: DesignMdColor[] = [];
  const seen = new Set<string>();
  const add = (key: string, raw: string) => {
    const hex = normalizeHex(raw);
    if (!hex || seen.has(hex)) return;
    seen.add(hex);
    out.push({ key, hex });
  };
  collectHexValues(parsed.frontmatter, [], add);
  for (const line of parsed.body.split('\n')) {
    for (const match of line.matchAll(/#(?:[0-9a-fA-F]{3,8})\b/g)) {
      const hex = match[0] ?? '';
      const key = line.slice(0, match.index).replace(/[`*_|\-[\]()]/g, ' ').trim() || 'body';
      add(key, hex);
    }
  }
  return out;
}

function collectHexValues(value: unknown, path: string[], add: (key: string, raw: string) => void): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g)) {
      add(path.join('.'), match[0] ?? '');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectHexValues(child, [...path, key], add);
  }
}

function resolveColors(candidates: DesignMdColor[]): BrandColor[] {
  const colors = candidates.filter((item) => /^#[0-9a-f]{6}$/.test(item.hex));
  const used = new Set<string>();
  const picked: BrandColor[] = [];
  const addRole = (role: BrandColorRole, color: DesignMdColor | null, fallback: string, name: string, usage: string) => {
    const hex = color?.hex ?? fallback;
    picked.push({
      role,
      hex,
      oklch: '',
      name: color ? titleFromKey(color.key, name) : name,
      usage,
    });
    used.add(hex);
  };
  const pick = (pattern: RegExp, predicate?: (hex: string) => boolean): DesignMdColor | null =>
    colors.find((item) => !used.has(item.hex) && pattern.test(item.key) && (!predicate || predicate(item.hex))) ?? null;
  const lightest = colors.reduce<DesignMdColor | null>(
    (best, item) => (!best || luminance(item.hex) > luminance(best.hex) ? item : best),
    null,
  );
  const darkest = colors.reduce<DesignMdColor | null>(
    (best, item) => (!best || luminance(item.hex) < luminance(best.hex) ? item : best),
    null,
  );
  const chromatic = (): DesignMdColor | null =>
    colors.find((item) => !used.has(item.hex) && saturation(item.hex) >= 0.16 && luminance(item.hex) > 0.08 && luminance(item.hex) < 0.9) ??
    colors.find((item) => !used.has(item.hex)) ??
    null;

  const background = pick(/background|bg|canvas|neutral|paper|limestone|base/i, (hex) => luminance(hex) > 0.55) ?? (lightest && luminance(lightest.hex) > 0.55 ? lightest : null);
  addRole('background', background, DEFAULT_BACKGROUND, 'Background', 'page canvas');
  addRole('foreground', pick(/foreground|text|ink|black|primary/i, (hex) => luminance(hex) < 0.55) ?? darkest, DEFAULT_FOREGROUND, 'Foreground', 'body text and headings');
  addRole('accent', pick(/accent|brand|cta|tertiary|interactive|button|link/i) ?? chromatic(), DEFAULT_ACCENT, 'Accent', 'primary actions and emphasis');
  addRole('surface', pick(/surface|card|panel|raised/i), mixHex(picked[0]?.hex ?? DEFAULT_BACKGROUND, picked[1]?.hex ?? DEFAULT_FOREGROUND, 0.04), 'Surface', 'cards and panels');
  addRole('muted', pick(/muted|secondary|caption|slate|subtle|gray|grey/i), mixHex(picked[0]?.hex ?? DEFAULT_BACKGROUND, picked[1]?.hex ?? DEFAULT_FOREGROUND, 0.45), 'Muted', 'secondary text and metadata');
  addRole('border', pick(/border|line|hairline|divider|stroke/i), mixHex(picked[0]?.hex ?? DEFAULT_BACKGROUND, picked[1]?.hex ?? DEFAULT_FOREGROUND, 0.14), 'Border', 'rules and dividers');
  const secondary = pick(/accent-secondary|secondary|success|link/i);
  if (secondary) addRole('accent-secondary', secondary, secondary.hex, 'Accent secondary', 'secondary actions and links');

  return picked;
}

function collectFonts(frontmatter: Record<string, unknown>, body: string): FontCandidate[] {
  const out: FontCandidate[] = [];
  const seen = new Set<string>();
  const add = (key: string, family: string) => {
    const clean = cleanFontFamily(family);
    if (!clean || seen.has(`${key}:${clean}`)) return;
    seen.add(`${key}:${clean}`);
    out.push({ key, family: clean });
  };
  collectFontValues(frontmatter.typography ?? frontmatter.fonts ?? frontmatter.type, [], add);
  for (const line of body.split('\n')) {
    const familyMatch =
      /(?:font-family|fontFamily|family)\s*[:=-]\s*`?["']?([^`"',;()]+(?:\s+[^`"',;()]+){0,3})/i.exec(line) ??
      /\b([A-Z][A-Za-z0-9]+(?:Sans|Serif|Mono|Display|Text|Grotesk|Gothic|Humanist|Roman|UI)\b(?:\s+[A-Z][A-Za-z0-9]+)*)/.exec(line);
    // The key is the line without its font stack (the family and every
    // fallback, up to `;`), so no family value ("Monoton", "ui-monospace")
    // decides the line's role. Parenthesised notes after the family, as in
    // `font-family: "Inter" (body)`, are role annotations and stay.
    if (familyMatch?.[1]) {
      const at = familyMatch.index;
      const end = line.indexOf(';', at);
      const stack = line.slice(at + familyMatch[0].length, end === -1 ? undefined : end);
      const notes = [...stack.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(' ');
      const after = end === -1 ? '' : line.slice(end + 1);
      add(`${line.slice(0, at)} ${notes} ${after}`.trim().slice(0, 48), familyMatch[1]);
    }
  }
  return out;
}

function collectFontValues(value: unknown, path: string[], add: (key: string, family: string) => void): void {
  if (typeof value === 'string') {
    if (/font|family|type|body|display|heading|mono/i.test(path.join('.'))) add(path.join('.'), value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  const family = scalarString(o.fontFamily) ?? scalarString(o.family);
  if (family) add(path.join('.'), family);
  for (const [key, child] of Object.entries(o)) collectFontValues(child, [...path, key], add);
}

function fontSpec(family: string, fallbacks = SANS_FALLBACKS): BrandFontSpec {
  return { family, fallbacks, weights: [400, 700] };
}

interface TypeRole {
  role: string;
  token: string | null;
  family: string;
  face: string;
  weights: number[];
  fallbacks: string[];
  usage: string;
}

const MONO_FALLBACKS = ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'];
const SERIF_FALLBACKS = ['Georgia', 'Times New Roman', 'serif'];
const FONT_TOKEN_RE = /--font-[a-z0-9-]+/i;
const MONO_ROLE_RE = /mono|code/i;
const WEIGHT_WORD_RE =
  /\s+(?:thin|hairline|extra\s*light|ultra\s*light|light|regular|normal|book|medium|semi\s*bold|demi\s*bold|bold|extra\s*bold|ultra\s*bold|black|heavy|italic|oblique|uppercase|lowercase|caps)\b.*$/i;

/**
 * Resolve the kit's type roles into the brand's display / body / mono slots.
 *
 * Invariant: every face a pasted DESIGN.md names in a type-role table or a
 * `--font-*` declaration reaches the registered design system, the same way
 * its colours do. The distinctive face (a statement serif, a display face)
 * takes the display slot when the kit's own display role reuses the body
 * face; every role with its token is kept in the matching slot's notes; and
 * a Google Fonts stylesheet the markdown names travels as the slot's
 * `googleFontsUrl`, so the face can be loaded, not only named.
 */
function resolveTypography(parsed: ParsedDesignMd): Brand['typography'] {
  const sources = collectGoogleFontsUrls(parsed.body);
  // Machine-readable frontmatter typography stays authoritative when present.
  const frontmatterTypography = parsed.frontmatter.typography ?? parsed.frontmatter.fonts ?? parsed.frontmatter.type;
  if (frontmatterTypography) return withSources(typographyFromLooseFonts(parsed), sources);
  const loose = looseFontSlots(parsed);
  const roles = collectTypeRoles(parsed.body, knownFamilies(parsed, sources));
  if (roles.length === 0) return withSources(typographyFromLooseFonts(parsed), sources);

  // A slot takes the kit's own role first, then a loose `font-family:` line
  // keyed to that slot, then a generic role, then any loose face. Roles add
  // to the loose declarations; they never erase a slot the roles leave empty.
  // Every mono or code role belongs to the mono slot, never display or body.
  const label = (role: TypeRole) => `${role.role} ${role.token ?? ''}`;
  const monoRoles = roles.filter((role) => MONO_ROLE_RE.test(label(role)));
  const textRoles = roles.filter((role) => !monoRoles.includes(role));
  const bodyRole = textRoles.find((role) => /body|text|paragraph|copy/i.test(label(role)));
  const headingRoles = textRoles.filter((role) =>
    /display|heading|headline|h1|title|statement|serif|hero/i.test(label(role)),
  );
  const headingRole = headingRoles.find((role) => role.family !== bodyRole?.family) ?? headingRoles[0];
  const looseAnchor = (slot: string, family: string | undefined): TypeRole | undefined =>
    family ? { role: slot, token: null, family, face: family, weights: [], fallbacks: [], usage: '' } : undefined;

  const displayAnchor =
    headingRole ??
    looseAnchor('display', loose.display) ??
    bodyRole ??
    textRoles[0] ??
    looseAnchor('display', loose.first) ??
    looseAnchor('display', 'Inter')!;
  const bodyAnchor =
    bodyRole ??
    looseAnchor('body', loose.body) ??
    textRoles.find((role) => role !== headingRole) ??
    textRoles[0] ??
    looseAnchor('body', loose.first) ??
    displayAnchor;
  const monoAnchor = monoRoles[0] ?? looseAnchor('mono', loose.mono);

  // A role whose face fills no slot is described under the slot of its kind:
  // text faces under display, extra mono/code faces under mono.
  const slotFamilies = new Set([displayAnchor.family, bodyAnchor.family, monoAnchor?.family]);
  const orphans = (pool: TypeRole[]) => pool.filter((role) => !slotFamilies.has(role.family));
  const specFor = (anchor: TypeRole, extra: TypeRole[]): BrandFontSpec => {
    const sameFace = roles.filter((role) => role.family === anchor.family);
    const described = roles.filter((role) => role.family === anchor.family || extra.includes(role));
    const weights = [...new Set(sameFace.flatMap((role) => role.weights))].sort((a, b) => a - b);
    return {
      family: anchor.family,
      fallbacks: sameFace.find((role) => role.fallbacks.length > 0)?.fallbacks ?? fallbacksFor(anchor),
      weights: weights.length > 0 ? weights : [400, 700],
      ...(described.length > 0 ? { notes: `type roles: ${described.map(describeRole).join('; ')}` } : {}),
    };
  };

  return withSources(
    {
      display: specFor(displayAnchor, orphans(textRoles)),
      body: specFor(bodyAnchor, []),
      ...(monoAnchor ? { mono: specFor(monoAnchor, orphans(monoRoles)) } : {}),
    },
    sources,
  );
}

interface LooseFontSlots {
  display: string | undefined;
  body: string | undefined;
  mono: string | undefined;
  first: string | undefined;
}

/** Loose `font-family:` lines keyed to a slot, for slots the roles leave empty. */
function looseFontSlots(parsed: ParsedDesignMd): LooseFontSlots {
  const fonts = collectFonts(parsed.frontmatter, parsed.body).filter((font) => isFamilyName(font.family));
  const text = fonts.filter((font) => !MONO_ROLE_RE.test(font.key));
  return {
    display: text.find((font) => /display|heading|headline|h1|title/i.test(font.key))?.family,
    body: text.find((font) => /body|text|paragraph|copy/i.test(font.key))?.family,
    mono: fonts.find((font) => MONO_ROLE_RE.test(font.key))?.family,
    first: text[0]?.family,
  };
}

/**
 * The font listing a kit carries: families its Google Fonts stylesheets name,
 * its loose `font-family:` lines, and its `--font-<role>` declarations. Used
 * to tell a face annotation ("Fraunces Light") from a family name that ends
 * in a weight word ("Archivo Black").
 */
function knownFamilies(parsed: ParsedDesignMd, urls: string[]): Map<string, string> {
  const known = new Map<string, string>();
  const add = (family: string) => {
    const clean = family.trim();
    if (isFamilyName(clean)) known.set(clean.toLowerCase(), clean);
  };
  for (const url of urls) {
    for (const match of url.matchAll(/family=([^:&]+)/gi)) add(safeDecode(match[1] ?? '').replace(/\+/g, ' '));
  }
  for (const font of collectFonts(parsed.frontmatter, parsed.body)) add(font.family);
  for (const declaration of fontFamilyDeclarations(parsed.body)) add(declaration.stack[0]!);
  return known;
}

/** Pre-table behaviour: frontmatter typography and loose `font-family:` lines. */
function typographyFromLooseFonts(parsed: ParsedDesignMd): Brand['typography'] {
  const fonts = collectFonts(parsed.frontmatter, parsed.body);
  const display = fontSpec(
    fonts.find((font) => /display|heading|headline|h1|title/i.test(font.key))?.family ??
      fonts[0]?.family ??
      'Inter',
  );
  const body = fontSpec(
    fonts.find((font) => /body|text|paragraph|copy/i.test(font.key))?.family ??
      fonts[0]?.family ??
      display.family,
  );
  const mono = fonts.find((font) => /mono|code/i.test(font.key));
  return {
    display,
    body,
    ...(mono ? { mono: fontSpec(mono.family, MONO_FALLBACKS) } : {}),
  };
}

function fallbacksFor(role: TypeRole): string[] {
  const hint = `${role.role} ${role.token ?? ''} ${role.family}`.replace(/sans[\s-]*serif/gi, '');
  if (/mono|code/i.test(hint)) return MONO_FALLBACKS;
  if (/serif/i.test(hint)) return SERIF_FALLBACKS;
  return SANS_FALLBACKS;
}

function describeRole(role: TypeRole): string {
  const token = role.token ? ` (\`${role.token}\`)` : '';
  const usage = role.usage ? ` — ${role.usage}` : '';
  return `${role.role}${token}: ${role.face}${usage}`;
}

/**
 * Type roles from markdown tables (a face / font / family column, optionally
 * a token column) and from `--font-*: "Family", fallback…;` declarations. A
 * declaration fills the fallback stack of the table row sharing its token.
 */
function collectTypeRoles(body: string, known: ReadonlyMap<string, string>): TypeRole[] {
  const roles: TypeRole[] = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableRow(lines[i]) || !isTableSeparator(lines[i + 1])) continue;
    const header = tableCells(lines[i]!).map((cell) => cell.toLowerCase());
    const faceCol = header.findIndex(
      (cell) =>
        /\b(face|font|family|typeface)\b/.test(cell) &&
        !/token|var|size|weight|height|scale|tracking|leading|spacing/.test(cell),
    );
    let j = i + 2;
    while (j < lines.length && isTableRow(lines[j])) j += 1;
    if (faceCol !== -1) {
      const tokenCol = header.findIndex((cell) => /token|variable|\bvar\b/.test(cell));
      const useCol = header.findIndex((cell) => /\b(use|usage|used|applies|where)\b/.test(cell));
      const roleCol = header.findIndex((_, index) => index !== faceCol && index !== tokenCol && index !== useCol);
      for (const line of lines.slice(i + 2, j)) {
        const cells = tableCells(line);
        // Face, role and usage text is copied into the slot notes, so a row
        // carrying control or bidi characters in any of them is refused whole.
        // A horizontal tab is plain spacing that stripMarkup normalises.
        if (cells.some((cell) => UNSAFE_TEXT_RE.test(cell.replace(/\t/g, ' ')))) continue;
        const face = stripMarkup(cells[faceCol] ?? '');
        const family = familyFromFace(face, known);
        if (!family) continue;
        const token =
          FONT_TOKEN_RE.exec(tokenCol >= 0 ? (cells[tokenCol] ?? '') : '')?.[0] ??
          FONT_TOKEN_RE.exec(cells.join(' '))?.[0] ??
          null;
        roles.push({
          role: stripMarkup(roleCol >= 0 ? (cells[roleCol] ?? '') : '') || token || 'Type',
          token,
          family,
          face,
          weights: weightsFromFace(face),
          fallbacks: [],
          usage: useCol >= 0 ? stripMarkup(cells[useCol] ?? '') : '',
        });
      }
    }
    i = j - 1;
  }

  for (const { token, stack } of fontFamilyDeclarations(body)) {
    const family = stack[0]!;
    const sameToken = roles.filter((role) => role.token?.toLowerCase() === token.toLowerCase());
    if (sameToken.length > 0) {
      for (const role of sameToken) if (role.fallbacks.length === 0) role.fallbacks = stack.slice(1);
      continue;
    }
    roles.push({
      role: token.replace(/^--font-/i, ''),
      token,
      family,
      face: family,
      weights: [],
      fallbacks: stack.slice(1),
      usage: '',
    });
  }
  return roles;
}

const NON_FAMILY_TOKEN_RE =
  /^--font-(?:.*-)?(?:size|sizes|weight|weights|line-height|lh|leading|tracking|letter-spacing|ls|spacing|scale|style|stretch|variant|feature-settings|features|variation-settings|optical-sizing|smoothing|kerning|synthesis)(?:-|$)/i;
const CSS_FONT_KEYWORD_RE =
  /^(?:normal|bold|bolder|lighter|italic|oblique|inherit|initial|unset|revert|revert-layer|none|auto|small|medium|large|x-small|x-large|xx-small|xx-large|smaller|larger)$/i;

/**
 * A value that can be a font family name: letters in any script, then letters,
 * marks, digits, spaces, `_` or `-`. Numbers, lengths, keywords, functions,
 * markdown (`#`, `|`, `*`), control characters and line breaks never qualify,
 * so a family cannot break out of its DESIGN.md line.
 */
function isFamilyName(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return /^\p{L}[\p{L}\p{M}\p{N} _-]*$/u.test(trimmed) && !CSS_FONT_KEYWORD_RE.test(trimmed);
}

/**
 * A fallback is a CSS family name, so it may carry punctuation a primary slot
 * family may not (".SFNSText-Regular", "M+ 1p"); it only has to stay inert in
 * a DESIGN.md line: no control or bidi characters and no markdown or CSS
 * structure characters.
 */
function isFallbackFamily(value: string): boolean {
  return value.length <= 64 && /\S/.test(value) && !UNSAFE_TEXT_RE.test(value) && !/[#|`*<>[\]{}\\;:!]/.test(value);
}

/** Control, format (bidi, zero-width) and line/paragraph separator characters. */
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * `--font-<role>: "Family", fallback…;` declarations whose value parses as a
 * family list. Size, weight, line-height and similar `--font-*` tokens, and
 * values that are numbers, lengths, keywords or `var()`, are not families.
 */
function fontFamilyDeclarations(body: string): Array<{ token: string; stack: string[] }> {
  const out: Array<{ token: string; stack: string[] }> = [];
  for (const match of body.matchAll(/(--font-[a-z0-9-]+)\s*:\s*([^;\n]+);/gi)) {
    const token = match[1]!;
    if (NON_FAMILY_TOKEN_RE.test(token)) continue;
    const stack = (match[2] ?? '')
      .replace(/\/\*.*$/, '')
      .split(',')
      .map((part) => part.replace(/[`"']/g, '').trim())
      .filter(Boolean);
    if (!isFamilyName(stack[0])) continue;
    // Fallbacks reach DESIGN.md too: keep only entries that are family names
    // (or a vendor-prefixed system family such as `-apple-system`).
    out.push({ token, stack: [stack[0]!, ...stack.slice(1).filter(isFallbackFamily)] });
  }
  return out;
}

function collectGoogleFontsUrls(body: string): string[] {
  return [...new Set([...body.matchAll(/https:\/\/fonts\.googleapis\.com\/[^\s'"`)<>]+/gi)].map((m) => m[0]))];
}

/** Attach the Google Fonts stylesheet whose `family=` names each slot's face. */
function withSources(typography: Brand['typography'], urls: string[]): Brand['typography'] {
  if (urls.length === 0) return typography;
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const attach = (spec: BrandFontSpec): BrandFontSpec => {
    if (spec.googleFontsUrl) return spec;
    const url = urls.find((candidate) =>
      [...candidate.matchAll(/family=([^:&]+)/gi)].some(
        (m) => slug(safeDecode(m[1] ?? '').replace(/\+/g, ' ')) === slug(spec.family),
      ),
    );
    return url ? { ...spec, googleFontsUrl: url } : spec;
  };
  return {
    display: attach(typography.display),
    body: attach(typography.body),
    ...(typography.mono ? { mono: attach(typography.mono) } : {}),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isTableRow(line: string | undefined): boolean {
  return Boolean(line && /^\s*\|.*\|\s*$/.test(line));
}

function isTableSeparator(line: string | undefined): boolean {
  return Boolean(line && /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(line));
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function stripMarkup(cell: string): string {
  return cell.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * "Fraunces 300, opsz 144" → "Fraunces"; "Inter 500 uppercase" → "Inter";
 * "Inter (Bold)" → "Inter". A trailing weight word is a face annotation only
 * when it is clearly separate (lowercase, as in "Inter uppercase") or the
 * name without it is a family the kit lists; otherwise it belongs to the
 * family ("Archivo Black").
 */
function familyFromFace(face: string, known: ReadonlyMap<string, string>): string {
  const family = cleanFontFamily(face)
    .replace(/\s*\(.*$/, '')
    .replace(/\s+(?:\d{3}\b|\d+(?:\.\d+)?(?:px|rem|em|pt|%)).*$/i, '')
    .trim();
  if (!isFamilyName(family) || /^(?:none|n\/a)$/i.test(family)) return '';
  return stripFaceAnnotation(family, known);
}

function stripFaceAnnotation(family: string, known: ReadonlyMap<string, string>): string {
  const match = WEIGHT_WORD_RE.exec(family);
  if (!match) return family;
  const base = family.slice(0, match.index).trim();
  const lower = family.toLowerCase();
  // The longest listed family the cell starts with, when it outruns the base.
  const listed = [...known.entries()]
    .filter(([key]) => key.length > base.length && (lower === key || lower.startsWith(`${key} `)))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (listed) return listed[1];
  const annotation = match[0].trim();
  if (annotation === annotation.toLowerCase()) return base;
  if (known.has(base.toLowerCase())) return base;
  return family;
}

/** CSS weights named in a face cell (100–900 and the x50 steps). */
function weightsFromFace(face: string): number[] {
  return [...face.matchAll(/\b([1-9](?:00|50))\b/g)].map((m) => Number(m[1]));
}

function cleanFontFamily(raw: string): string {
  return raw
    .split(',')[0]!
    .split(':')[0]!
    .replace(/[`"']/g, '')
    .replace(/\s+\d+(?:px|rem|em|%)?.*$/i, '')
    .trim();
}

function collectComponentNames(frontmatter: Record<string, unknown>, body: string): string[] {
  const names = new Set<string>();
  const components = frontmatter.components;
  if (components && typeof components === 'object' && !Array.isArray(components)) {
    for (const key of Object.keys(components)) names.add(key);
  }
  const componentSection = firstSection(body, ['components']);
  if (componentSection) {
    for (const line of componentSection.split('\n')) {
      const match = /^\s*[-*]\s+`?([A-Za-z][A-Za-z0-9_-]{1,48})`?/.exec(line);
      if (match?.[1]) names.add(match[1]);
    }
  }
  return Array.from(names);
}

function firstDimension(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === 'string' && child.trim()) return child.trim();
    if (typeof child === 'number') return `${child}px`;
  }
  return null;
}

function markdownH1(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() || null;
}

function firstSection(body: string, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)];
  for (let i = 0; i < matches.length; i += 1) {
    const title = matches[i]?.[1]?.trim().toLowerCase();
    if (!title || !wanted.has(title)) continue;
    const start = (matches[i]?.index ?? 0) + (matches[i]?.[0].length ?? 0);
    const end = matches[i + 1]?.index ?? body.length;
    const section = body.slice(start, end).trim();
    return section || null;
  }
  return null;
}

function firstParagraph(body: string): string | null {
  for (const part of body.split(/\n\s*\n/)) {
    const trimmed = part
      .split('\n')
      .filter((line) => !/^#{1,6}\s/.test(line.trim()) && !line.trim().startsWith('|'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
}

function titleFromKey(key: string, fallback: string): string {
  const leaf = key.split('.').filter(Boolean).at(-1) ?? fallback;
  const words = leaf.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback;
}

function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const ch = (i: number): string =>
    Math.round(ca[i]! + (cb[i]! - ca[i]!) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const n = parseInt(match[1] ?? '', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
