import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectDesignContext, ResourceCandidate, ResourceRef, ResourceRequestContext, ResourceSourceSnapshot, ResourceSourceStatus } from '@open-design/contracts';
import { CONTRAST_EVIDENCE_STYLE_TAG, resourceRefKey } from './context-ranking.js';
import {
  COHORT_LABELS, TEXT_CONTRAST_MINIMUM, UI_CONTRAST_MINIMUM, classifyToken, contrastEvidenceLines, contrastRatio, describeContrastPair, extractCustomProperties,
  hslHex, paletteContrastEvidence, parseCssColor,
  type ContrastPair, type DesignTokenValue, type TokenCohort, type TokenSpecimen,
} from './token-evidence.js';
import type { ResourceSourceAdapter } from './resources.js';

/**
 * AC-R04.1/R04.2 and AC-R05.2: the current project's own tokens and the
 * deterministic suggestions derived from its saved brief.
 *
 * Both sources are project-scoped: they list nothing without the request's
 * already-authorized project, and every item ID names that project, so a
 * reference minted for one project never resolves in another. Readiness stays
 * `unverified` (no per-item acceptance receipt exists) and adoption stays off.
 * The revision is a digest of the exact token bytes a preview serves.
 */
export type WorkspaceNavigation = { workspaceId: string; workspaceMemberId: string } | null;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ORDER: readonly TokenCohort[] = ['color-palette', 'type-scale', 'spacing-scale', 'motion'];

/** Same-origin preview URL for a token cohort; navigation scope rides in the query because iframes cannot set headers. */
export function tokenPreviewUrl(ref: ResourceRef, context: ResourceRequestContext, workspace: WorkspaceNavigation = null): string {
  const query = new URLSearchParams();
  if (context.projectId) query.set('projectId', context.projectId);
  if (workspace) { query.set('workspaceId', workspace.workspaceId); query.set('workspaceMemberId', workspace.workspaceMemberId); }
  const search = query.toString();
  return `/api/workbench/resources/${resourceRefKey(ref)}/preview${search ? `?${search}` : ''}`;
}
function emptyStatus(sourceId: ResourceSourceStatus['sourceId'], reason: string): ResourceSourceSnapshot {
  return { items: [], status: { sourceId, state: 'searched', reason, itemCount: 0, listingDigest: sha256(JSON.stringify([])) } };
}
function listingDigest(items: readonly ResourceCandidate[]): string {
  return sha256(JSON.stringify(items.map(item => [item.ref.itemId, item.ref.revisionOrDigest])));
}
function tokenCandidate(input: {
  ref: ResourceRef; title: string; category: TokenCohort; rights: ResourceCandidate['rightsStatus']; origin: string;
  attribution: string; fitReasons: string[]; contrastPassed: boolean; previewUrl: string;
}): ResourceCandidate {
  return {
    ref: input.ref, title: input.title, category: input.category, readiness: 'unverified',
    compatibility: { nativeFormat: 'css-custom-properties', targets: [], state: 'unverified', reason: 'Per-item acceptance evidence is pending' },
    rightsStatus: input.rights, fitReasons: input.fitReasons,
    previewCapability: { available: true, kind: 'html', url: input.previewUrl, reason: null },
    adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: input.attribution },
    implementationOrigin: input.origin, styleTags: [input.category, ...(input.contrastPassed ? [CONTRAST_EVIDENCE_STYLE_TAG] : [])],
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Project need is not assessed by token discovery',
  };
}
/** Adapter plus the specimen lookup the preview route uses. A preview runs ONE listing and
 * returns it with the matching specimen, so the authority/stale checks and the bytes served
 * come from the same read. */
type SpecimenSource = ResourceSourceAdapter & Required<Pick<ResourceSourceAdapter, 'preview'>>;
export function specimenFor(specimens: readonly TokenSpecimen[], ref: ResourceRef): TokenSpecimen | null {
  return specimens.find(entry => entry.itemId === ref.itemId && entry.revision === ref.revisionOrDigest) ?? null;
}
function withSpecimens(sourceId: ResourceSourceStatus['sourceId'], collect: (context: ResourceRequestContext) => Promise<{ snapshot: ResourceSourceSnapshot; specimens: TokenSpecimen[] }>): SpecimenSource {
  return {
    sourceId,
    async list(context) { return (await collect(context)).snapshot; },
    async preview(ref, context) {
      const { snapshot, specimens } = await collect(context);
      return { snapshot, specimen: specimenFor(specimens, ref) };
    },
  };
}

// ---------------------------------------------------------------------------
// Project tokens: CSS custom properties the project's own stylesheets declare.

/** Work budgets, not inventory quotas: exceeding one degrades the listing with a reason. */
export const PROJECT_TOKEN_LIMITS = Object.freeze({ files: 64, fileBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024, entries: 4096, depth: 6 });
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.git', '.next', '.od']);
type ProjectTokenLimits = typeof PROJECT_TOKEN_LIMITS;

/** Opens first with O_NOFOLLOW, proves the handle is the contained file, then reads at most `limit` bytes. */
async function readContainedFile(root: string, relative: string, limit: number): Promise<Buffer | 'too-large' | null> {
  const filename = path.join(root, relative);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) return null;
    if (opened.size > limit) return 'too-large';
    const real = await realpath(filename);
    if (!real.startsWith(root + path.sep)) return null;
    const checked = await stat(real);
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) return null;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length <= limit;) {
      ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, null));
      length += read;
    }
    return length > limit ? 'too-large' : buffer.subarray(0, length);
  } catch { return null; } finally { await handle?.close(); }
}
/** Stylesheet paths under the project root, without following symlinks or entering dot/build directories. */
async function stylesheetPaths(root: string, limits: ProjectTokenLimits, notes: Set<string>): Promise<string[]> {
  const found: string[] = [];
  let entries = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > limits.depth) { notes.add('depth-limit-exceeded'); return; }
    let listing: Dirent[];
    try { listing = await readdir(relative ? path.join(root, relative) : root, { withFileTypes: true }); } catch { notes.add('directory-unreadable'); return; }
    listing.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of listing) {
      if (++entries > limits.entries) { notes.add('entry-limit-exceeded'); return; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) await walk(next, depth + 1); }
      else if (entry.isFile() && /\.(css|scss)$/iu.test(entry.name)) found.push(next);
    }
  };
  await walk('', 0);
  return found;
}
export interface ProjectTokenSourceDeps {
  /** The authorized project's root directory, or null when the project does not exist. */
  projectRoot(projectId: string): string | null;
  workspace?: WorkspaceNavigation;
  limits?: Partial<ProjectTokenLimits>;
}
export function createProjectTokensSource(deps: ProjectTokenSourceDeps): SpecimenSource {
  const limits: ProjectTokenLimits = { ...PROJECT_TOKEN_LIMITS, ...deps.limits };
  return withSpecimens('project-tokens', async context => {
    const projectId = context.projectId;
    if (!projectId) return { snapshot: emptyStatus('project-tokens', 'project-scope-required'), specimens: [] };
    let root: string;
    try {
      const declared = deps.projectRoot(projectId);
      if (!declared) return { snapshot: emptyStatus('project-tokens', 'project-unavailable'), specimens: [] };
      root = await realpath(declared);
    } catch { return { snapshot: { items: [], status: { sourceId: 'project-tokens', state: 'degraded', reason: 'project-files-unavailable', itemCount: null, listingDigest: null } }, specimens: [] }; }
    const notes = new Set<string>();
    const files = await stylesheetPaths(root, limits, notes);
    if (files.length > limits.files) notes.add('file-limit-exceeded');
    let total = 0;
    const sources: Array<{ file: string; digest: string; tokens: DesignTokenValue[] }> = [];
    for (const file of files.slice(0, limits.files)) {
      const bytes = await readContainedFile(root, file, limits.fileBytes);
      if (bytes === 'too-large') { notes.add('file-byte-limit-exceeded'); continue; }
      if (!bytes) { notes.add('file-unreadable'); continue; }
      total += bytes.length;
      if (total > limits.totalBytes) { notes.add('total-byte-limit-exceeded'); break; }
      const tokens = extractCustomProperties(bytes.toString('utf8'));
      if (tokens.length) sources.push({ file, digest: sha256(bytes), tokens });
    }
    // First declaration of a name across files (sorted path order) wins, like one cascade origin.
    const all = new Map<string, { value: string; file: string }>();
    for (const source of sources) for (const token of source.tokens) if (!all.has(token.name)) all.set(token.name, { value: token.value, file: source.file });
    const values = new Map([...all].map(([name, entry]) => [name, entry.value]));
    const cohorts = new Map<TokenCohort, Array<DesignTokenValue & { file: string }>>();
    for (const [name, entry] of all) {
      const cohort = classifyToken(name, entry.value, values);
      if (cohort) cohorts.set(cohort, [...(cohorts.get(cohort) ?? []), { name, value: entry.value, file: entry.file }]);
    }
    // The revision binds the bytes of every contributing stylesheet, so any edit makes old refs stale.
    const revision = `sha256:${sha256(JSON.stringify(sources.map(source => [source.file, source.digest])))}`;
    const items: ResourceCandidate[] = [];
    const specimens: TokenSpecimen[] = [];
    for (const category of ORDER) {
      const tokens = cohorts.get(category);
      if (!tokens?.length) continue;
      const itemId = `${projectId}/${category}`;
      const ref: ResourceRef = { sourceType: 'library', sourceId: 'project-tokens', itemId, revisionOrDigest: revision };
      const declaredIn = [...new Set(tokens.map(token => token.file))].slice(0, 6);
      const fitReasons = [`${tokens.length} ${COHORT_LABELS[category]} token(s) declared in this project's stylesheets: ${declaredIn.join(', ')}`];
      let contrastPassed = false;
      const notesForSpecimen = [...fitReasons];
      if (category === 'color-palette') {
        const evidence = paletteContrastEvidence(tokens, values);
        contrastPassed = evidence.passed;
        const lines = contrastEvidenceLines(evidence);
        fitReasons.push(`Contrast evidence: ${evidence.reason}`, ...lines);
        notesForSpecimen.push(`Contrast evidence: ${evidence.reason}`, ...lines);
      }
      items.push(tokenCandidate({ ref, title: `Project ${COHORT_LABELS[category]} (${tokens.length} tokens)`, category, rights: 'permitted', origin: 'project-owned', attribution: 'This project’s stylesheets', fitReasons, contrastPassed, previewUrl: tokenPreviewUrl(ref, context, deps.workspace ?? null) }));
      specimens.push({ itemId, revision, title: `Project ${COHORT_LABELS[category]}`, category, tokens: tokens.map(({ name, value }) => ({ name, value })), notes: notesForSpecimen });
    }
    const reason = [...notes].sort().join('; ') || null;
    return { snapshot: { items, status: { sourceId: 'project-tokens', state: reason ? 'degraded' : 'searched', reason, itemCount: items.length, listingDigest: listingDigest(items) } }, specimens };
  });
}

// ---------------------------------------------------------------------------
// Brief-derived suggestions: a deterministic palette, type scale and spacing
// scale from the saved project brief, with WCAG contrast evidence.

export const BRIEF_TOKEN_DERIVATION = 'brief-tokens/1';
type HueRule = { pattern: RegExp; hue: number; cue: string };
/** Ordered: the first matching cue in the saved brief text picks the hue. */
const HUE_RULES: readonly HueRule[] = [
  { pattern: /\b(dent\w*|clinic\w*|medic\w*|health\w*|care|therap\w*|wellness|calm\w*)\b/iu, hue: 186, cue: 'calm clinical teal' },
  { pattern: /\b(financ\w*|bank\w*|legal|law|insur\w*|enterprise|trust\w*)\b/iu, hue: 214, cue: 'trustworthy blue' },
  { pattern: /\b(eco|green|garden\w*|organic|nature|natural|sustainab\w*)\b/iu, hue: 140, cue: 'natural green' },
  { pattern: /\b(food|restaurant|cafe|café|bakery|warm\w*)\b/iu, hue: 22, cue: 'warm terracotta' },
  { pattern: /\b(luxury|premium|elegant|refined)\b/iu, hue: 232, cue: 'refined indigo' },
  { pattern: /\b(kids?|child\w*|play\w*|fun|toy\w*)\b/iu, hue: 32, cue: 'playful amber' },
  { pattern: /\b(creative|art|music|bold|editorial)\b/iu, hue: 330, cue: 'bold magenta' },
];
const SPINE_HUES: Record<string, number> = { TL: 214, PA: 250, CO: 18, SM: 200, CS: 340, LM: 270, BA: 170, TU: 220, MI: 300 };
type BriefSignals = { text: string; fields: string[] };
function briefSignals(context: ProjectDesignContext): BriefSignals {
  const fields: Array<[string, string | null | undefined]> = [
    ['brandDirection', context.brandDirection], ['styleDirection', context.styleDirection], ['purpose', context.purpose],
    ...context.audience.map((value, index): [string, string] => [`audience/${index}`, value]),
    ...context.constraints.filter(constraint => constraint.kind === 'accessibility').map((constraint, index): [string, string] => [`constraints/accessibility/${index}`, constraint.value]),
  ];
  const present = fields.filter((entry): entry is [string, string] => !!entry[1]?.trim());
  return { text: present.map(([, value]) => value).join(' \n '), fields: present.map(([name]) => name) };
}
function darkenUntil(h: number, s: number, start: number, passes: (hex: string) => boolean): string {
  for (let l = start; l >= 0.05; l -= 0.01) { const hex = hslHex(h, s, l); if (passes(hex)) return hex; }
  return hslHex(h, s, 0.05);
}
export interface DerivedBriefTokens {
  palette: DesignTokenValue[]; typeScale: DesignTokenValue[]; spacingScale: DesignTokenValue[];
  contrast: ContrastPair[]; reasons: { palette: string[]; type: string[]; spacing: string[] };
}
/** Pure and deterministic: the same saved brief always yields the same tokens. */
export function deriveBriefTokens(context: ProjectDesignContext): DerivedBriefTokens {
  const { text } = briefSignals(context);
  const rule = HUE_RULES.find(candidate => candidate.pattern.test(text));
  const matched = rule ? text.match(rule.pattern)?.[0] ?? null : null;
  const hue = rule?.hue ?? (context.spineCode ? SPINE_HUES[context.spineCode] ?? 220 : 220);
  const bold = /\b(bold|playful|energetic|vibrant|loud)\b/iu.test(text);
  const quiet = /\b(calm\w*|premium|elegant|clinical|minimal\w*|refined|luxury)\b/iu.test(text);
  const saturation = bold ? 0.7 : quiet ? 0.45 : 0.55;
  const rgb = (hex: string) => parseCssColor(hex)!;
  const surface = hslHex(hue, 0.3, 0.98);
  const raised = hslHex(hue, 0.25, 0.94);
  const textColour = hslHex(hue, 0.3, 0.14);
  const meets = (fg: string, bg: string, minimum: number) => contrastRatio(rgb(fg), rgb(bg)) >= minimum;
  const muted = darkenUntil(hue, 0.15, 0.5, hex => meets(hex, surface, TEXT_CONTRAST_MINIMUM) && meets(hex, raised, TEXT_CONTRAST_MINIMUM));
  const onPrimary = '#ffffff';
  const primary = darkenUntil(hue, saturation, 0.5, hex => meets(onPrimary, hex, TEXT_CONTRAST_MINIMUM) && meets(hex, surface, UI_CONTRAST_MINIMUM));
  const accentHue = (hue + 40) % 360;
  const accent = darkenUntil(accentHue, saturation, 0.55, hex => meets(hex, surface, UI_CONTRAST_MINIMUM));
  const palette: DesignTokenValue[] = [
    { name: '--color-surface', value: surface }, { name: '--color-surface-raised', value: raised },
    { name: '--color-text', value: textColour }, { name: '--color-text-muted', value: muted },
    { name: '--color-primary', value: primary }, { name: '--color-on-primary', value: onPrimary }, { name: '--color-accent', value: accent },
  ];
  const pair = (foreground: string, fg: string, background: string, bg: string, minimum: number): ContrastPair => {
    const ratio = contrastRatio(rgb(fg), rgb(bg));
    return { foreground, background, ratio, minimum, passed: ratio >= minimum };
  };
  const contrast = [
    pair('--color-text', textColour, '--color-surface', surface, TEXT_CONTRAST_MINIMUM),
    pair('--color-text', textColour, '--color-surface-raised', raised, TEXT_CONTRAST_MINIMUM),
    pair('--color-text-muted', muted, '--color-surface', surface, TEXT_CONTRAST_MINIMUM),
    pair('--color-on-primary', onPrimary, '--color-primary', primary, TEXT_CONTRAST_MINIMUM),
    pair('--color-primary', primary, '--color-surface', surface, UI_CONTRAST_MINIMUM),
    pair('--color-accent', accent, '--color-surface', surface, UI_CONTRAST_MINIMUM),
  ];
  const largeText = /\b(older|senior\w*|elderly|aging|ageing|low vision|large text)\b/iu.test(text);
  const base = largeText ? 18 : 16;
  const ratio = quiet ? 1.2 : bold ? 1.333 : 1.25;
  const step = (power: number) => `${(Math.max(12, base * ratio ** power) / 16).toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')}rem`;
  const typeScale: DesignTokenValue[] = [
    { name: '--text-xs', value: step(-2) }, { name: '--text-sm', value: step(-1) }, { name: '--text-base', value: step(0) },
    { name: '--text-lg', value: step(1) }, { name: '--text-xl', value: step(2) }, { name: '--text-2xl', value: step(3) }, { name: '--text-3xl', value: step(4) },
    { name: '--leading-body', value: quiet ? '1.6' : '1.5' }, { name: '--leading-heading', value: '1.2' },
  ];
  const spacingScale: DesignTokenValue[] = [
    ...[1, 2, 3, 4, 6, 8, 12, 16].map(multiple => ({ name: `--space-${multiple}`, value: `${multiple * 4}px` })),
    { name: '--space-section', value: quiet ? '96px' : '64px' },
    { name: '--size-target-min', value: '44px' },
  ];
  const cue = rule && matched ? `saved brief mentions “${matched}”, so the hue follows the ${rule.cue} cue` : context.spineCode ? `no brand colour cue in the saved brief; hue follows saved spine ${context.spineCode}` : 'no brand colour cue or spine in the saved brief; neutral blue hue';
  return {
    palette, typeScale, spacingScale, contrast,
    reasons: {
      palette: [`Derived from the saved brief (${BRIEF_TOKEN_DERIVATION}): ${cue}`],
      type: [`Base ${base}px${largeText ? ' because the saved audience or accessibility constraint asks for larger text' : ''}; ${ratio} ratio for a ${quiet ? 'calm' : bold ? 'bold' : 'balanced'} direction in the saved brief`],
      spacing: [`4px rhythm; ${quiet ? '96px' : '64px'} section spacing for a ${quiet ? 'calm, spacious' : 'standard'} direction; 44px minimum targets`],
    },
  };
}
export interface BriefTokenSourceDeps {
  /** The saved context of the request's already-authorized project, or null when none is saved. */
  readContext(projectId: string): ProjectDesignContext | null;
  workspace?: WorkspaceNavigation;
}
export function createBriefTokensSource(deps: BriefTokenSourceDeps): SpecimenSource {
  return withSpecimens('brief-derived-tokens', async context => {
    const projectId = context.projectId;
    if (!projectId) return { snapshot: emptyStatus('brief-derived-tokens', 'project-scope-required'), specimens: [] };
    let saved: ProjectDesignContext | null;
    try { saved = deps.readContext(projectId); } catch { return { snapshot: { items: [], status: { sourceId: 'brief-derived-tokens', state: 'degraded', reason: 'saved-brief-unreadable', itemCount: null, listingDigest: null } }, specimens: [] }; }
    if (!saved || saved.projectId !== projectId) return { snapshot: emptyStatus('brief-derived-tokens', 'no-saved-brief'), specimens: [] };
    const derived = deriveBriefTokens(saved);
    const grounded = `Grounded in saved brief revision ${saved.revision} (${briefSignals(saved).fields.join(', ') || 'spine only'})`;
    const contrastPassed = derived.contrast.every(pair => pair.passed);
    const cohorts: Array<{ category: TokenCohort; tokens: DesignTokenValue[]; reasons: string[] }> = [
      { category: 'color-palette', tokens: derived.palette, reasons: [...derived.reasons.palette, `Contrast evidence: ${contrastPassed ? 'every pair passed' : 'a pair failed'}`, ...derived.contrast.map(describeContrastPair)] },
      { category: 'type-scale', tokens: derived.typeScale, reasons: derived.reasons.type },
      { category: 'spacing-scale', tokens: derived.spacingScale, reasons: derived.reasons.spacing },
    ];
    const items: ResourceCandidate[] = [];
    const specimens: TokenSpecimen[] = [];
    for (const cohort of cohorts) {
      // The revision binds exactly the token bytes the preview serves; a brief edit that
      // changes them makes the old reference stale.
      const revision = `sha256:${sha256(JSON.stringify([BRIEF_TOKEN_DERIVATION, cohort.category, cohort.tokens]))}`;
      const itemId = `${projectId}/${cohort.category}`;
      const ref: ResourceRef = { sourceType: 'library', sourceId: 'brief-derived-tokens', itemId, revisionOrDigest: revision };
      const fitReasons = [grounded, ...cohort.reasons, 'Newly derived suggestion for this project; not an external asset'];
      items.push(tokenCandidate({ ref, title: `Suggested ${COHORT_LABELS[cohort.category]} from the saved brief`, category: cohort.category, rights: 'permitted', origin: 'brief-derived-suggestion', attribution: 'Derived from this project’s saved brief', fitReasons, contrastPassed: cohort.category === 'color-palette' && contrastPassed, previewUrl: tokenPreviewUrl(ref, context, deps.workspace ?? null) }));
      specimens.push({ itemId, revision, title: `Suggested ${COHORT_LABELS[cohort.category]}`, category: cohort.category, tokens: cohort.tokens, notes: fitReasons });
    }
    return { snapshot: { items, status: { sourceId: 'brief-derived-tokens', state: 'searched', reason: null, itemCount: items.length, listingDigest: listingDigest(items) } }, specimens };
  });
}
