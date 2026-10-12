// R03 evidence detail: what a mechanical check measured at one width, pass or
// fail, and the visual facts of the rendered page. Reviewers verify a pass from
// these facts instead of a bare "pass at N px", and a text-only reviewer judges
// a declared look from measured colours, fonts, borders and boxes.
//
// Same taint rules as evaluate.ts: every value is a number, a colour, a closed
// vocabulary value, a structural selector, a reduced location or a page-text
// token. Page-chosen strings (font names, lang, selectors) pass only through a
// vocabulary or evidenceSelector; anything else becomes its token.
import { REVIEW_FONT_FAMILIES, REVIEW_LANGUAGES, type VerificationEvidence } from '@open-design/contracts';
import { composite, contrastRatio, isLargeText } from './color.js';
import { ctaActionsInScope, ctaKindAllowed, inScope } from './evaluate.js';
import { ev, evidenceKey, evidenceSelector, list, num, PageText, readPageText, rubricKey, vocab, type EvidenceParam, type EvidenceText } from './evidence.js';
import type { PlannedCheck } from './plan.js';
import type { ActionProbe, Rgba, ViewportCapture } from './types.js';

/** Contract limit for an evidence item's detail list. */
const MAX_DETAIL = 24;
const MAX_ACTIONS = 6;
const MAX_CONTRAST_SAMPLES = 3;
const MAX_SWATCHES = 6;
const MAX_FONTS = 6;
const MAX_BOXES = 6;
/**
 * Visual facts are `visual-<width>`. Check evidence is always `<checkId>@<width>` (it contains `@`)
 * and run-level ids are fixed words, so no rubric check id can collide with a visual-facts id.
 */
export const visualFactsId = (width: number) => `visual-${width}`;
export const isVisualFactsId = (id: string) => /^visual-\d+$/u.test(id);
const WHITE: Rgba = [255, 255, 255, 1];

/** A finite number (page-reported counts and sizes may be anything); non-finite is 0. */
const finite = (value: number) => (Number.isFinite(value) ? value : 0);
const count = (value: number) => Math.max(0, Math.round(finite(value)));
const percent = (share: number) => Math.round(Math.min(1, Math.max(0, finite(share))) * 100);
const flag = (value: boolean) => vocab('flag', value ? 'yes' : 'no');
const channelHex = (value: number) => Math.min(255, Math.max(0, Math.round(finite(value)))).toString(16).padStart(2, '0');
/** An opaque colour as `#rrggbb` (channels clamped; alpha composited over white). */
export function colorParam(color: Rgba): EvidenceParam {
  const opaque = composite([finite(color[0]), finite(color[1]), finite(color[2]), Number.isFinite(color[3]) ? color[3] : 1], WHITE);
  return { kind: 'color', value: `#${channelHex(opaque[0])}${channelHex(opaque[1])}${channelHex(opaque[2])}` };
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const ratioParam = (ratio: number) => num(Number(ratio.toFixed(2)), 2);

const FONT_BY_NAME = new Map(REVIEW_FONT_FAMILIES.map(name => [name.toLowerCase(), name]));
/** A declared font-family value: its first family by vocabulary name, otherwise the page-text token. */
export function fontFamilyParam(family: PageText): EvidenceParam {
  const first = readPageText(family).split(',')[0]!.trim().replace(/^["']|["']$/gu, '').trim();
  const known = FONT_BY_NAME.get(first.toLowerCase());
  return known ? vocab('fontFamily', known) : PageText.of(first).token();
}
const LANGUAGES: ReadonlySet<string> = new Set(REVIEW_LANGUAGES);
/** A `lang` attribute: its ISO 639-1 primary subtag by vocabulary, the token for anything else, or none. */
function languageParam(lang: PageText | null): EvidenceValueParam {
  if (!lang || lang.isBlank()) return ev('common.none');
  const primary = readPageText(lang).trim().split(/[-_]/u)[0]!.toLowerCase();
  return LANGUAGES.has(primary) ? vocab('language', primary) : lang.token();
}
type EvidenceValueParam = EvidenceParam | EvidenceText;

function ctaOutcome(action: ActionProbe): EvidenceText {
  if (action.kind === 'link') {
    const destination = action.destination;
    if (!destination) return ev('detail.notChecked');
    if (destination.kind === 'fragment') return ev('detail.cta.fragment', vocab('presence', destination.found ? 'found' : 'missing'));
    const status = typeof destination.status === 'number' ? destination.status : destination.kind === 'same-origin' ? ev('common.noResponse') : ev('detail.notChecked');
    return ev('detail.cta.dest', vocab('destinationKind', destination.kind), action.href ?? ev('common.none'), status);
  }
  const effect = action.clickEffect;
  // Only an activation on the element the capture saw says anything about this action.
  if (!effect || effect.target !== 'same') return ev('detail.cta.notActivated');
  return ev('detail.cta.effect', count(effect.domMutations), flag(effect.navigated), flag(effect.submissionCaptured));
}

function ctaDetail(check: PlannedCheck, actionType: Extract<PlannedCheck['parameters'], { type: 'cta' }>['actionType'], capture: ViewportCapture): EvidenceText[] {
  const actions = ctaActionsInScope(check, actionType, capture);
  const kinds = (kind: ActionProbe['kind']) => actions.filter(action => action.kind === kind).length;
  const detail = [ev('detail.cta.count', actions.length, kinds('link'), kinds('button'), kinds('form'))];
  if (actionType !== 'all') {
    for (const target of check.targets ?? []) {
      detail.push(ev('detail.cta.matched', vocab('actionType', actionType), rubricKey(target.key), capture.actions.filter(action => action.targetKeys.includes(target.key) && ctaKindAllowed(actionType, action)).length));
    }
  }
  for (const action of actions.slice(0, MAX_ACTIONS)) {
    detail.push(ev('detail.cta.action', evidenceSelector(action.selector), vocab('actionKind', action.kind), count(action.width), count(action.height), action.inline ? ev('detail.cta.inline') : ev('common.nothing'), ctaOutcome(action)));
  }
  return detail;
}

function contrastDetail(check: PlannedCheck, parameters: Extract<PlannedCheck['parameters'], { type: 'contrast' }>, capture: ViewportCapture): EvidenceText[] {
  const texts = capture.texts.filter(sample => inScope(sample.targetKeys, check.targets));
  const measured = texts.flatMap(sample => sample.background ? [{ sample, background: sample.background, ratio: contrastRatio(sample.color, sample.background), large: isLargeText(sample.fontSizePx, sample.fontWeight) }] : []);
  const detail: EvidenceText[] = [];
  if (measured.length) {
    const ratios = measured.map(item => item.ratio);
    detail.push(ev('detail.contrast.summary', texts.length, ratioParam(Math.min(...ratios)), ratioParam(median(ratios)), measured.filter(item => item.large).length, parameters.normalTextMinRatio, parameters.largeTextMinRatio));
    for (const item of [...measured].sort((a, b) => a.ratio - b.ratio).slice(0, MAX_CONTRAST_SAMPLES)) {
      detail.push(ev('detail.contrast.sample', evidenceSelector(item.sample.selector), ratioParam(item.ratio), colorParam(composite(item.sample.color, item.background)), colorParam(item.background), num(Math.round(finite(item.sample.fontSizePx) * 10) / 10), count(item.sample.fontWeight), vocab('textSize', item.large ? 'large' : 'normal')));
    }
  }
  const unmeasured = texts.length - measured.length;
  if (unmeasured > 0) detail.push(ev('detail.contrast.unmeasured', unmeasured));
  return detail;
}

function consoleDetail(capture: ViewportCapture): EvidenceText[] {
  const occurrences = capture.console.reduce((sum, record) => sum + count(record.count), 0);
  const fonts = (status: string) => capture.fonts.filter(font => font.status === status).length;
  return [
    ev('detail.console.summary', capture.console.length, occurrences, capture.resources.length, capture.blockedRequests.length),
    ev('detail.console.fonts', fonts('loaded'), fonts('error'), capture.fonts.length - fonts('loaded') - fonts('error')),
  ];
}

function keyboardDetail(capture: ViewportCapture): EvidenceText[] {
  // The same walk evaluateKeyboard reads: distinct stops until focus returns to the first one or repeats.
  const visited: string[] = []; const visible = new Set<string>(); let wrapped = false;
  for (const step of capture.keyboard.steps) {
    const raw = step.selector === null ? null : readPageText(step.selector);
    if (raw === null || raw === visited[0]) { wrapped = visited.length > 0; if (wrapped) break; continue; }
    if (visited.includes(raw)) break;
    visited.push(raw);
    if (step.focusVisible) visible.add(raw);
  }
  return [ev('detail.keyboard.walk', count(capture.keyboard.focusableCount), visited.length, visible.size, flag(wrapped || count(capture.keyboard.focusableCount) === 0))];
}

function semanticsDetail(capture: ViewportCapture): EvidenceText[] {
  const levels = [...new Set(capture.headings.map(heading => count(heading.level)))].sort((a, b) => a - b);
  return [ev('detail.semantics.document',
    languageParam(capture.document.lang), flag(!capture.document.title.isBlank()), capture.headings.length, capture.headings.filter(heading => heading.level === 1).length,
    levels.length ? list(levels) : ev('common.none'), capture.controls.filter(control => !control.name.isBlank()).length, capture.controls.length)];
}

/** What one check measured at one width, whatever its outcome (empty for motion, whose notes already say it). */
export function detailAtWidth(check: PlannedCheck, capture: ViewportCapture): EvidenceText[] {
  const parameters = check.parameters;
  const detail = (() => {
    switch (parameters.type) {
      case 'cta': return ctaDetail(check, parameters.actionType, capture);
      case 'contrast': return contrastDetail(check, parameters, capture);
      case 'console-resources': return consoleDetail(capture);
      case 'overflow': return [ev('detail.overflow.metrics', capture.width, count(capture.document.scrollWidth), count(capture.document.clientWidth), count(capture.document.layoutWidth), capture.clipped.length, capture.outsideViewport.length)];
      case 'keyboard-focus': return keyboardDetail(capture);
      case 'document-semantics': return semanticsDetail(capture);
      case 'motion': return [];
    }
  })();
  return detail.slice(0, MAX_DETAIL);
}

/** Shares of a weighted list merged by evidence key, largest first, as `<param> N%` messages. */
function shares(entries: { param: EvidenceParam; weight: number }[], template: 'visual.swatch' | 'visual.font', limit: number): EvidenceValueParam {
  const merged = new Map<string, { param: EvidenceParam; weight: number }>();
  for (const entry of entries) {
    const weight = Math.max(0, finite(entry.weight));
    if (!weight) continue;
    const key = evidenceKey(entry.param);
    const seen = merged.get(key);
    if (seen) seen.weight += weight; else merged.set(key, { param: entry.param, weight });
  }
  const total = [...merged.values()].reduce((sum, entry) => sum + entry.weight, 0);
  const top = [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
  return top.length ? list(top.map(entry => ev(template, entry.param, Math.round((entry.weight / total) * 100)))) : ev('common.none');
}

/**
 * The visual-<width> item: the rendered first viewport described from
 * measurements (painted colours, text colours, declared fonts, type scale,
 * borders, shadows, gradients, layout boxes, page height). Null when the
 * capture has no visual measurements.
 */
export function visualFactsEvidence(capture: ViewportCapture): VerificationEvidence | null {
  const visual = capture.visual;
  if (!visual) return null;
  const detail: EvidenceText[] = [];
  // Surfaces: shares are of the grid, so they are clamped and kept as measured rather than renormalized.
  const surfaces = new Map<string, { param: EvidenceParam; share: number }>();
  for (const surface of visual.surfaces) {
    const param = colorParam(surface.color); const key = evidenceKey(param);
    const share = Math.min(1, Math.max(0, finite(surface.share)));
    surfaces.set(key, { param, share: Math.min(1, (surfaces.get(key)?.share ?? 0) + share) });
  }
  const swatches = [...surfaces.values()].filter(entry => percent(entry.share) > 0).sort((a, b) => b.share - a.share).slice(0, MAX_SWATCHES);
  detail.push(ev('visual.palette', swatches.length ? list(swatches.map(entry => ev('visual.swatch', entry.param, percent(entry.share)))) : ev('common.none'), percent(visual.mediaShare)));
  detail.push(ev('visual.textColors', shares(capture.texts.map(sample => ({ param: colorParam(composite(sample.color, sample.background ?? WHITE)), weight: 1 })), 'visual.swatch', MAX_SWATCHES)));
  detail.push(ev('visual.fonts', shares(visual.fonts.map(font => ({ param: fontFamilyParam(font.family), weight: count(font.count) })), 'visual.font', MAX_FONTS)));
  const sizes = capture.texts.map(sample => finite(sample.fontSizePx)).filter(size => size > 0);
  if (sizes.length) {
    const round = (value: number) => Math.round(value * 10) / 10;
    detail.push(ev('visual.type', round(Math.min(...sizes)), round(Math.max(...sizes)), round(median(sizes)), list([...new Set(capture.texts.map(sample => count(sample.fontWeight)))].sort((a, b) => a - b))));
  }
  detail.push(ev('visual.borders', count(visual.borders.bevel), count(visual.borders.other), count(visual.borders.rounded), count(visual.borders.maxRadiusPx)));
  detail.push(ev('visual.effects', count(visual.effects.shadows), count(visual.effects.hardShadows), count(visual.effects.insetShadows), count(visual.effects.gradients), count(visual.effects.backgroundImages)));
  const boxes = visual.boxes
    .map(box => ({ box, area: count(box.width) * count(box.height) }))
    .sort((a, b) => b.area - a.area).slice(0, MAX_BOXES)
    .map(({ box }) => ev('visual.box', evidenceSelector(box.selector), Math.round(finite(box.x)), Math.round(finite(box.y)), count(box.width), count(box.height), box.background ? colorParam(box.background) : ev('visual.transparent')));
  detail.push(ev('visual.layout', boxes.length ? list(boxes) : ev('common.none')));
  const height = count(visual.documentHeight);
  detail.push(ev('visual.page', height, num(capture.height > 0 ? height / capture.height : 0, 1)));
  return { id: visualFactsId(capture.width), viewport: capture.width, type: 'computed-style', summary: ev('visual.summary', capture.width, capture.height), observations: [], detail };
}
