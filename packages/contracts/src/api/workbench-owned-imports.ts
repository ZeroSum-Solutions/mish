import { z } from 'zod';

/**
 * AC-R12.4 (Q7 A): an owner-provided prototype export (Magic Patterns first) imported
 * from local files. No provider account, MCP or generation is involved; the record
 * keeps exact file and artifact hashes and labels placeholder data and actions.
 * Endpoints: POST/GET /api/workbench/imports, GET /api/workbench/imports/:id and
 * /:id/files/<path>; `od workbench import create|list|show`.
 */
export const OWNED_IMPORT_PROVIDERS = ['magic-patterns'] as const;
export const OWNED_IMPORT_LIMITS = Object.freeze({ files: 64, bytes: 4 * 1024 * 1024 });

const clean = (max: number) => z.string().min(1).max(max).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), 'Invalid control or format character');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const importId = z.string().regex(/^import-[a-f0-9]{16}$/u);
const relativePath = z.string().min(1).max(500).refine(value =>
  !/[\p{Cc}\p{Cf}\\]/u.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.')), 'Expected a normalized relative path without hidden segments');
const base64 = z.string().max(Math.ceil(OWNED_IMPORT_LIMITS.bytes / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'Expected base64 content');
const httpsUrl = z.string().max(500).regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[^\s?#\\@]*)?$/u);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

const ownershipSchema = z.object({
  /** The owner states these are their own exported files (creator owns output, terms 2025-04-01). */
  declaration: z.literal('owner-provided-export'),
  exportedFrom: httpsUrl.nullable(),
}).strict();

const requestSchema = z.object({
  provider: z.enum(OWNED_IMPORT_PROVIDERS), name: clean(120), entryPath: relativePath, ownership: ownershipSchema,
  files: z.array(z.object({ path: relativePath, contentBase64: base64 }).strict()).min(1).max(OWNED_IMPORT_LIMITS.files),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.files.map(file => file.path))) ctx.addIssue({ code: 'custom', path: ['files'], message: 'Duplicate file path' });
  if (!value.files.some(file => file.path === value.entryPath)) ctx.addIssue({ code: 'custom', path: ['entryPath'], message: 'The entry must be one of the imported files' });
  const paths = new Set(value.files.map(file => file.path));
  for (const path of paths) {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++) if (paths.has(parts.slice(0, count).join('/'))) ctx.addIssue({ code: 'custom', path: ['files'], message: 'File and descendant paths overlap' });
  }
});

export const PLACEHOLDER_KINDS = ['placeholder-link', 'placeholder-action', 'placeholder-text', 'placeholder-media'] as const;
const recordSchema = z.object({
  schema: z.literal('owned-import/1'), id: importId, revision: z.literal(1),
  provider: z.enum(OWNED_IMPORT_PROVIDERS), name: clean(120), principalId: clean(200),
  entryPath: relativePath,
  /** SHA-256 over the sorted (path, sha256) list: the exact imported artifact. */
  artifactSha256: sha256,
  files: z.array(z.object({ path: relativePath, sha256, bytes: z.number().int().nonnegative(), role: z.enum(['source', 'asset', 'style']) }).strict()).min(1).max(OWNED_IMPORT_LIMITS.files),
  placeholders: z.array(z.object({ path: relativePath, line: z.number().int().positive(), kind: z.enum(PLACEHOLDER_KINDS), excerpt: clean(160) }).strict()).max(500),
  provenance: z.object({
    origin: z.literal('owned'), acquisition: z.literal('owner-provided-local-file'),
    declaration: z.literal('owner-provided-export'), exportedFrom: httpsUrl.nullable(),
    providerAccountUsed: z.literal(false), providerMcpUsed: z.literal(false),
    termsVersion: clean(40), evidenceRef: clean(300),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (!value.files.some(file => file.path === value.entryPath)) ctx.addIssue({ code: 'custom', path: ['entryPath'], message: 'The entry must be one of the imported files' });
  if (!unique(value.files.map(file => file.path))) ctx.addIssue({ code: 'custom', path: ['files'], message: 'Duplicate file path' });
});
const listSchema = z.object({ imports: z.array(recordSchema).max(500) }).strict();

export type OwnedImportRequest = z.infer<typeof requestSchema>;
export type OwnedImportRecord = z.infer<typeof recordSchema>;
export type OwnedImportList = z.infer<typeof listSchema>;
export const parseOwnedImportRequest = (input: unknown): OwnedImportRequest => requestSchema.parse(input);
export const parseOwnedImportRecord = (input: unknown): OwnedImportRecord => recordSchema.parse(input);
export const parseOwnedImportList = (input: unknown): OwnedImportList => listSchema.parse(input);
