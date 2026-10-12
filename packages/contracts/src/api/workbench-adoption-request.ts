import { z } from 'zod';
import { parsePrepareAdoptionResponse, type PreparedAdoptionPlan } from './workbench-adoption-plan.js';

// U6 AC-R04.3/AC-R04.4 (additive; captain-approved in batch 2): apply from the catalogue.
// Kept in this sibling file so workbench-adoption-plan.ts (U5) stays frozen. The client
// names a catalogue reference and a target; the daemon resolves the source, checks rights,
// notices and declared dependencies, and prepares a PreparedAdoptionPlan. A replacement of
// differing project bytes needs `acceptReplacement` equal to the digest of the reviewed
// diff. Apply, readback and undo reuse the operation wire in workbench-adoption-plan.ts.

// Same lexical rules as the private primitives in workbench-adoption-plan.ts.
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(200).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
const path = z.string().min(1).max(1000).refine(v => !/[\p{Cc}\p{Cf}\\]/u.test(v) && !v.startsWith('/') && !/^[A-Za-z]:/u.test(v)
  && v.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Expected normalized project-relative path');
const writeRole = z.enum(['source', 'entry', 'asset', 'style', 'notice', 'package', 'lock']);
const refKey = z.string().min(1).max(20000).regex(/^[A-Za-z0-9_-]+$/u);

const catalogueRequestSchema = z.object({
  projectId: id, refKey, entryPath: path, targetDir: path.optional(), acceptReplacement: hash.optional(),
  // W4 (additive): prepare from a privately saved unit of the same reference instead of the catalogue bytes.
  savedUnitId: hash.optional(),
}).strict();
// G02 (additive; batch 6): the target adapter a catalogue plan landed through. `html-artifact/v1`
// is a standalone editable HTML unit (any project kind); `react-source/v1` is an editable TSX
// unit admitted only into a project whose own manifest declares React 17+ and react-dom. The
// report records what the manifest said; it never carries an install command.
export const CATALOGUE_TARGET_ADAPTERS = ['html-artifact/v1', 'react-source/v1'] as const;
const catalogueTargetSchema = z.object({
  adapter: z.enum(CATALOGUE_TARGET_ADAPTERS), framework: text, reactMajor: z.number().int().nonnegative().max(1000).nullable(),
  typescript: z.boolean(), styleRuntime: z.enum(['css', 'tailwind4', 'styled-components', 'unknown']), dependencyDigest: hash,
}).strict().superRefine((value, ctx) => {
  if (value.adapter === 'react-source/v1' && value.reactMajor === null) ctx.addIssue({ code: 'custom', path: ['reactMajor'], message: 'A React source target names its React major' });
});
export type CatalogueTargetReport = z.infer<typeof catalogueTargetSchema>;
/** Every typed reason a target adapter refuses a project with (422 `target-incompatible`). */
export const CATALOGUE_TARGET_REASONS = [
  'package-manifest-missing', 'target-not-react', 'target-ambiguous', 'react-version-unsupported',
  'react-version-unreadable', 'react-dom-missing', 'react-dom-mismatch', 'typescript-missing',
  /** Sol B5/6: the installed react or react-dom could not be resolved inside the project root. */
  'react-version-unresolved',
] as const;
/** Refusal details (422 `target-incompatible`): the project is not a target for this unit; nothing was converted or written. */
export interface CatalogueTargetRefusal {
  adapter: CatalogueTargetReport['adapter'];
  targetReason: typeof CATALOGUE_TARGET_REASONS[number];
  detected: { framework: string; reactMajor: number | null };
}
export const parseCatalogueTargetReport = (input: unknown): CatalogueTargetReport => catalogueTargetSchema.parse(input);
const catalogueReportSchema = z.object({
  refKey,
  identity: z.object({ sourceId: text, itemId: text, title: text, packageName: text, sourceUrl: z.string().url().max(2000), licence: text }).strict(),
  files: z.array(z.object({ path, role: writeRole }).strict()).min(1).max(256),
  notices: z.array(path).min(1).max(256),
  dependencies: z.object({ satisfied: z.array(z.object({ name: text, range: text, installed: text }).strict()).max(256) }).strict(),
  target: catalogueTargetSchema.optional(),
}).strict();
export type CatalogueAdoptionRequest = z.infer<typeof catalogueRequestSchema>;
export type CatalogueAdoptionReport = z.infer<typeof catalogueReportSchema>;
export interface CatalogueAdoptionResponse { plan: PreparedAdoptionPlan; catalogue: CatalogueAdoptionReport }
/** Refusal details (422 `dependencies-unsatisfied`): nothing was prepared or written. */
export interface CatalogueDependencyReport { missing: { name: string; range: string }[]; incompatible: { name: string; required: string; installed: string }[] }
/** Refusal details (409 `replacement-review-required`): the diff to review before replacing project bytes. */
export interface CatalogueReplacementReview { replacementDigest: string; files: { path: string; currentSha256: string; incomingSha256: string; diff: string }[] }
export const parseCatalogueAdoptionRequest = (input: unknown): CatalogueAdoptionRequest => catalogueRequestSchema.parse(input);
export const parseCatalogueAdoptionResponse = (input: unknown): CatalogueAdoptionResponse => {
  const { plan, catalogue } = z.object({ plan: z.unknown(), catalogue: catalogueReportSchema }).strict().parse(input);
  return { plan: parsePrepareAdoptionResponse({ plan }).plan, catalogue };
};

// W4 (additive; batch 6): a private, principal-scoped snapshot of an applied catalogue unit as
// edited in its project, reused in another project through catalogue prepare (`savedUnitId`).
// Only unit files are saved (source, style, asset); notices and the entry are regenerated.
const catalogueSaveRequestSchema = z.object({ projectId: id, operationId: id }).strict();
const savedUnitSchema = z.object({
  id: hash, refKey, title: text, target: z.enum(CATALOGUE_TARGET_ADAPTERS).optional(), sourceProjectId: id, sourceOperationId: id,
  files: z.array(z.object({ path, role: z.enum(['source', 'asset', 'style']), sha256: hash, bytes: z.number().int().nonnegative().max(32 * 1024 * 1024) }).strict()).min(1).max(256),
}).strict();
export type CatalogueSaveRequest = z.infer<typeof catalogueSaveRequestSchema>;
export type CatalogueSavedUnit = z.infer<typeof savedUnitSchema>;
export const parseCatalogueSaveRequest = (input: unknown): CatalogueSaveRequest => catalogueSaveRequestSchema.parse(input);
export const parseCatalogueSavedUnitResponse = (input: unknown): { savedUnit: CatalogueSavedUnit } => z.object({ savedUnit: savedUnitSchema }).strict().parse(input);
export const parseCatalogueSavedUnitsResponse = (input: unknown): { savedUnits: CatalogueSavedUnit[] } => z.object({ savedUnits: z.array(savedUnitSchema).max(500) }).strict().parse(input);
/** DELETE /api/workbench/adoption/catalogue/saved/:id — the removed saved unit's ID (owner only; anything else is 404). */
export const parseCatalogueSavedUnitDeleteResponse = (input: unknown): { deleted: string } => z.object({ deleted: hash }).strict().parse(input);
