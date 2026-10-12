import { DESIGN_BRIEF_LIMITS, type DesignBriefReference, type DesignBriefReferenceChange, type ResourceRef } from '@open-design/contracts';
import { contrastRatio } from '../review/color.js';
import type { Rgba } from '../review/types.js';
import { looksLikeHostInstruction } from './intent.js';

/**
 * A reviewed reference document (AC-R08.4, e.g. an attributed Awesome
 * DESIGN.md entry). Only reviewed excerpts and typed reviewed tokens reach the
 * transformer; raw documents, front matter and agent instructions never do.
 */
export interface DesignReferenceDocument {
  ref: ResourceRef;
  title: string;
  attribution: string;
  review: 'reviewed' | 'unreviewed';
  /** R15 model input from a third-party reference requires the derive-from-reference grant. */
  deriveFromReference: 'permitted' | 'unknown' | 'blocked';
  /** Set for a project-private reference; another project's request is refused. */
  projectId: string | null;
  excerpt: string;
  tokens: { colors: Array<{ role: string; value: string }>; fonts: Array<{ role: string; family: string }> };
}

export type DesignReferenceResolution =
  | { kind: 'found'; document: DesignReferenceDocument }
  | { kind: 'unknown' } | { kind: 'stale' } | { kind: 'forbidden' };

export interface DesignReferenceSource {
  resolve(ref: ResourceRef, context: { principalId: string; projectId: string }): Promise<DesignReferenceResolution>;
}

/** No reviewed reference corpus is installed: every selection is refused as unreviewed, never guessed. */
export const NO_REVIEWED_REFERENCES: DesignReferenceSource = { async resolve() { return { kind: 'unknown' }; } };

export class ReferenceSelectionError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422 | 503, readonly code: string, message: string) { super(message); }
}

export interface SelectedReference { index: number; document: DesignReferenceDocument; excerptOmitted: boolean }

/**
 * Resolves the user's selection to exact reviewed revisions, deduplicated by
 * identity and digest, and fits reviewed excerpts into one shared budget.
 * Any unknown, stale, foreign, unreviewed or underivable reference refuses the
 * whole request so the user can fix the selection; nothing is dropped silently.
 */
export async function selectReferences(refs: readonly ResourceRef[], context: { principalId: string; projectId: string }, source: DesignReferenceSource, maxChars: number): Promise<SelectedReference[]> {
  const seen = new Set<string>();
  const documents: DesignReferenceDocument[] = [];
  for (const ref of refs) {
    const identity = `${ref.sourceType}:${ref.sourceId}:${ref.itemId}`;
    if (seen.has(identity) || seen.has(`digest:${ref.revisionOrDigest}`)) continue;
    const resolved = await source.resolve(ref, context);
    if (resolved.kind === 'unknown') throw new ReferenceSelectionError(404, 'reference-unknown', 'A selected reference does not exist; search again and reselect it');
    if (resolved.kind === 'stale') throw new ReferenceSelectionError(409, 'reference-stale', 'A selected reference changed since it was selected; reselect its current revision');
    if (resolved.kind === 'forbidden') throw new ReferenceSelectionError(403, 'reference-forbidden', 'A selected reference belongs to another project');
    const doc = resolved.document;
    if (doc.review !== 'reviewed') throw new ReferenceSelectionError(422, 'reference-unreviewed', 'A selected reference has no reviewed excerpt yet');
    if (doc.deriveFromReference !== 'permitted') throw new ReferenceSelectionError(422, 'reference-derive-not-permitted', 'A selected reference does not permit derived model input');
    seen.add(identity); seen.add(`digest:${ref.revisionOrDigest}`);
    documents.push(doc);
  }
  const budget = Math.min(maxChars, DESIGN_BRIEF_LIMITS.referenceExcerptTokens * 4);
  let used = 0;
  return documents.map((document, index) => {
    const fits = used + document.excerpt.length <= budget;
    if (fits) used += document.excerpt.length;
    return { index, document, excerptOmitted: !fits };
  });
}

export function referenceRecords(selected: readonly SelectedReference[]): DesignBriefReference[] {
  return selected.map(item => ({ ref: item.document.ref, title: item.document.title.slice(0, 200), attribution: item.document.attribution.slice(0, 500), excerptOmitted: item.excerptOmitted }));
}

function parseColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value.trim());
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map(d => d + d).join('') : hex[1]!;
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16), 1];
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/iu.exec(value.trim());
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (channels.every(c => c <= 255)) return [channels[0]!, channels[1]!, channels[2]!, 1];
  }
  return null;
}

const FOREGROUND = /^(?:text|foreground|on-|body|heading|ink)/iu;
const BACKGROUND = /^(?:background|surface|canvas|bg|page)/iu;

export interface ChangeEvidenceDeps { resolveFont(family: string): Promise<ResourceRef | null> }

/** Contrast for proposed palette pairs and resolution of proposed fonts; invalid tokens stay named gaps. */
async function evidenceFor(path: DesignBriefReferenceChange['path'], docs: DesignReferenceDocument[], deps: ChangeEvidenceDeps): Promise<Pick<DesignBriefReferenceChange, 'contrast' | 'tokenGaps' | 'fonts'>> {
  const out: Pick<DesignBriefReferenceChange, 'contrast' | 'tokenGaps' | 'fonts'> = {};
  if (path === 'design.color') {
    const contrast: NonNullable<DesignBriefReferenceChange['contrast']> = [];
    const gaps: string[] = [];
    for (const doc of docs) {
      const colors = doc.tokens.colors.map(token => ({ ...token, rgba: parseColor(token.value) }));
      for (const token of colors) if (!token.rgba) gaps.push(`${doc.title}: ${token.role} = ${token.value} is not a resolvable color`.slice(0, 300));
      for (const fg of colors.filter(token => token.rgba && FOREGROUND.test(token.role))) {
        for (const bg of colors.filter(token => token.rgba && BACKGROUND.test(token.role))) {
          const ratio = Math.round(contrastRatio(fg.rgba!, bg.rgba!) * 100) / 100;
          contrast.push({ foreground: fg.value.slice(0, 64), background: bg.value.slice(0, 64), ratio, passesAA: ratio >= 4.5 });
        }
      }
    }
    if (contrast.length) out.contrast = contrast.slice(0, 24);
    if (gaps.length) out.tokenGaps = gaps.slice(0, 24);
  }
  if (path === 'design.typography') {
    const families = [...new Set(docs.flatMap(doc => doc.tokens.fonts.map(font => font.family.trim()).filter(Boolean)))].slice(0, 12);
    const fonts: NonNullable<DesignBriefReferenceChange['fonts']> = [];
    for (const family of families) {
      const resolvedRef = await deps.resolveFont(family).catch(() => null);
      fonts.push({ family: family.slice(0, 200), resolvedRef, gap: resolvedRef === null });
    }
    if (fonts.length) out.fonts = fonts;
  }
  return out;
}

export interface ProposedChange { path: DesignBriefReferenceChange['path']; proposedValue: string; rationale: string; referenceIndexes: number[] }

/**
 * Turns the model's proposals into reviewable, attributed field diffs. A
 * proposal is dropped when it cites no usable reference, reads like a host
 * instruction, or names a referenced brand the user did not ask for.
 * Conflicts with user, description or project values are marked; nothing is
 * applied until the user accepts it.
 */
export async function buildReferenceChanges(
  proposals: readonly ProposedChange[],
  selected: readonly SelectedReference[],
  current: (path: DesignBriefReferenceChange['path']) => { value: string | null; basis: string },
  originalText: string,
  deps: ChangeEvidenceDeps,
): Promise<DesignBriefReferenceChange[]> {
  const usable = new Map(selected.filter(item => !item.excerptOmitted).map(item => [item.index, item.document]));
  const original = originalText.toLowerCase();
  const changes: DesignBriefReferenceChange[] = [];
  for (const proposal of proposals) {
    const docs = [...new Set(proposal.referenceIndexes)].map(index => usable.get(index)).filter((doc): doc is DesignReferenceDocument => Boolean(doc));
    if (!docs.length) continue;
    if (looksLikeHostInstruction(proposal.proposedValue) || looksLikeHostInstruction(proposal.rationale)) continue;
    const proposed = proposal.proposedValue.toLowerCase();
    if (selected.some(item => proposed.includes(item.document.title.toLowerCase()) && !original.includes(item.document.title.toLowerCase()))) continue;
    const existing = current(proposal.path);
    changes.push({
      id: `chg_${changes.length + 1}`, path: proposal.path, oldValue: existing.value,
      proposedValue: proposal.proposedValue, rationale: proposal.rationale, refs: docs.map(doc => doc.ref),
      conflict: existing.value !== null && ['stated', 'unverified', 'user', 'context'].includes(existing.basis),
      status: 'proposed', ...await evidenceFor(proposal.path, docs, deps),
    });
  }
  return changes;
}
