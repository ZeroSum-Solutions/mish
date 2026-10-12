import type { FontCheckResponse, ResourceResult } from '@mish/contracts';
import { parseFontCheckRequest } from '@mish/contracts';
import { parseUnicodeRanges, rangesContain, type FontCatalogueFamily } from './catalogue.js';
import { fontRights } from './licence.js';

type Request = ReturnType<typeof parseFontCheckRequest>;
/** What a check needs of a family, from the curated catalogue or a discovery listing. */
export type FontCheckFamily = Pick<FontCatalogueFamily, 'id' | 'family' | 'category' | 'weights' | 'styles' | 'subsets' | 'axes' | 'unicodeRanges' | 'localFiles'> & { licence: Pick<FontCatalogueFamily['licence'], 'type' | 'reservedFontNames'> };
const LIST_LIMIT = 100;
const GENERIC: Record<FontCatalogueFamily['category'], string> = {
  'sans-serif': "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  monospace: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  display: 'system-ui, sans-serif', handwriting: 'system-ui, sans-serif', other: 'system-ui, sans-serif',
};
export const FONT_SPECIMEN_ROUTE = '/api/workbench/fonts/specimen';
const codepointLabel = (codepoint: number) => `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;

/** The CSS fallback stack a project should declare after this family. */
export function fontFallbackStack(family: Pick<FontCatalogueFamily, 'family' | 'category'>): string {
  return `'${family.family.replace(/['"\\;{}<>]/gu, '')}', ${GENERIC[family.category]}`;
}

/**
 * AC-R11.2 checks for one font resource and one piece of user text. Declared coverage
 * uses the upstream subsets' unicode-range metadata; local coverage uses the cmap of
 * each admitted local file, measured with fontTools when the snapshot was made and
 * bound to the file by its sha256. The daemon itself never parses font bytes.
 */
export function checkFont(resource: ResourceResult, family: FontCheckFamily, request: Request): FontCheckResponse {
  const profile = resource.fontProfile;
  if (!profile || resource.ref.sourceId !== 'fonts' || resource.ref.itemId !== family.id) throw new Error('Font resource and catalogue entry disagree');
  const codepoints = [...new Set([...request.text].map(char => char.codePointAt(0)!))].filter(codepoint => !/[\s\p{Cc}\p{Cf}]/u.test(String.fromCodePoint(codepoint)));
  const declaredSources = family.subsets.flatMap(subset => family.unicodeRanges[subset] ? [family.unicodeRanges[subset]] : []);
  // A source that publishes no unicode-range metadata (Google METADATA.pb, Fontshare) cannot
  // be checked for declared coverage; say so instead of reporting every glyph missing.
  const declaredChecked = declaredSources.length > 0;
  const declaredRanges = parseUnicodeRanges(declaredSources.join(','));
  const availableShas = new Set(profile.localFiles.filter(file => file.state === 'available').map(file => file.sha256));
  const available = family.localFiles.filter(file => availableShas.has(file.sha256));
  // A face serves a codepoint only when it is in the file's cmap AND in the unicode-range the
  // face is declared with: the browser never consults a face outside its range.
  const faces = available.map(file => ({ file, cmap: parseUnicodeRanges(file.cmap), range: parseUnicodeRanges(family.unicodeRanges[file.subset] ?? '') }));
  const serves = (face: typeof faces[number], codepoint: number) => rangesContain(face.range, codepoint) && rangesContain(face.cmap, codepoint);
  const covers = (weight: number) => (face: typeof faces[number]) => face.file.weight.min <= weight && weight <= face.file.weight.max;
  const wantedStyles = request.styles?.length ? request.styles : [faces.some(face => face.file.style === 'normal') ? 'normal' as const : 'italic' as const];
  const wantedWeights = request.weights?.length ? request.weights : [null];
  // Strict local coverage: a real admitted face of each requested style and weight (no
  // synthesized italic, no substitute weight) must serve the glyph.
  const exactSets = wantedStyles.flatMap(style => wantedWeights.map(weight => faces.filter(face => face.file.style === style && (weight === null || covers(weight)(face)))));
  // What the browser would actually draw: CSS font matching narrows to the requested style
  // (else the other style) and the nearest weight, then falls back per character.
  const distance = (face: typeof faces[number], weight: number) => covers(weight)(face) ? 0 : Math.min(Math.abs(face.file.weight.min - weight), Math.abs(face.file.weight.max - weight));
  const matchedSets = wantedStyles.flatMap(style => {
    const styled = faces.some(face => face.file.style === style) ? faces.filter(face => face.file.style === style) : faces;
    return wantedWeights.map(weight => {
      const target = weight ?? 400;
      const best = Math.min(...styled.map(face => distance(face, target)));
      return styled.filter(face => distance(face, target) === best);
    });
  });
  const glyph = (codepoint: number) => ({ char: String.fromCodePoint(codepoint), codepoint: codepointLabel(codepoint) });
  const declaredMissing = declaredChecked ? codepoints.filter(codepoint => !rangesContain(declaredRanges, codepoint)) : [];
  const localMissing = available.length ? codepoints.filter(codepoint => exactSets.some(set => !set.some(face => serves(face, codepoint)))) : [];
  const fallbackGlyphs = available.length ? codepoints.filter(codepoint => matchedSets.some(set => !set.some(face => serves(face, codepoint)))).length : codepoints.length;
  const local = (has: boolean) => !available.length ? 'no-local-file' as const : has ? 'available' as const : 'missing' as const;
  const wght = family.axes.find(axis => axis.tag === 'wght');
  const weights = (request.weights ?? []).map(weight => ({
    weight, declared: family.weights.includes(weight) || (!!wght && wght.min <= weight && weight <= wght.max),
    local: local(available.some(file => file.weight.min <= weight && weight <= file.weight.max)),
  }));
  const styles = (request.styles ?? []).map(style => ({ style, declared: family.styles.includes(style), local: local(available.some(file => file.style === style)) }));
  const subsets = (request.subsets ?? []).map(subset => ({ subset, declared: family.subsets.includes(subset), local: local(available.some(file => file.subset === subset)) }));
  const rights = fontRights(family.licence.type);
  const notes = [
    declaredChecked
      ? 'Declared coverage uses the upstream subsets\' unicode-range metadata, not the font\'s own cmap.'
      : 'This source publishes no unicode-range metadata, so declared glyph coverage was not checked.',
    available.length
      ? 'Local coverage counts a glyph only when an admitted file of the requested style and weight serves it: in that file\'s cmap (measured once at snapshot time, bound by sha256) and inside its declared unicode-range. Synthesized italics and substitute weights do not count.'
      : 'No local file admitted: only source metadata is available (no font bytes are bundled), so only declared metadata was checked and nothing can render.',
    ...(family.licence.reservedFontNames.length ? [`Reserved Font Name ${family.licence.reservedFontNames.join(', ')}: use upstream-provided subsets only.`] : []),
    ...(rights === 'unknown' ? ['Licence unknown: reference-only viewing; redistribution is blocked.'] : rights === 'restricted' ? [`${family.licence.type} restricts byte operations; nothing is served.`] : []),
  ];
  const passed = available.length > 0 && declaredChecked && rights !== 'restricted' && !declaredMissing.length && !localMissing.length
    && [...weights, ...styles, ...subsets].every(entry => entry.declared && entry.local === 'available');
  return {
    schema: 'font-check/1', ref: resource.ref, refKey: resource.refKey, family: family.family,
    glyphs: {
      checked: codepoints.length,
      declared: { missing: declaredMissing.slice(0, LIST_LIMIT).map(glyph), missingCount: declaredMissing.length, ...(declaredChecked ? {} : { state: 'no-declared-ranges' as const }) },
      local: { state: available.length ? 'checked' : 'no-local-file', missing: localMissing.slice(0, LIST_LIMIT).map(glyph), missingCount: localMissing.length },
    },
    weights, styles, subsets,
    fallback: { stack: fontFallbackStack(family), glyphsRenderedByFallback: fallbackGlyphs },
    licence: profile.licence,
    specimenUrl: available.length && rights !== 'restricted' ? `${FONT_SPECIMEN_ROUTE}?ref=${encodeURIComponent(resource.refKey)}` : null,
    passed, notes,
  };
}
