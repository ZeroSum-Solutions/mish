import { z } from 'zod';
import { runDesignBriefBindingSchema } from './workbench-brief.js';

// Build on brand / flagship "client brief → working first draft"
// (docs/plans/2026-10-09-build-on-brand/spec.md, docs/plans/2026-10-09-flagship/plan.md).
//
// One request turns a brief (and optionally a reference URL, read for structure only) into a
// 3–5 page static site on an installed design kit, built by one agent run. The daemon computes
// the reference digest and the plan; a caller can never supply either.

export const BUILD_ON_BRAND_PAGE_COUNT_MIN = 3;
export const BUILD_ON_BRAND_PAGE_COUNT_MAX = 5;
export const BUILD_ON_BRAND_PAGE_COUNT_DEFAULT = 4;
export const BUILD_ON_BRAND_BRIEF_MAX_CHARS = 16_000;
export const BUILD_ON_BRAND_ROUTE_ENTRY_MAX = 8;

export const BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA = 'od.build-on-brand.reference-digest/1';

export const BUILD_ON_BRAND_TARGETS = ['static-html'] as const;
export type BuildOnBrandTarget = (typeof BUILD_ON_BRAND_TARGETS)[number];

/** Page roles. Every page of a plan and every page of a reference digest is one of these. */
export const BUILD_ON_BRAND_PAGE_ROLES = [
  'home',
  'about',
  'services',
  'work',
  'pricing',
  'team',
  'faq',
  'booking',
  'contact',
] as const;
export type BuildOnBrandPageRole = (typeof BUILD_ON_BRAND_PAGE_ROLES)[number];

/** Section roles: what a section is for, never what it says. */
export const BUILD_ON_BRAND_SECTION_ROLES = [
  'nav',
  'hero',
  'logos',
  'features',
  'services',
  'stats',
  'process',
  'testimonials',
  'team',
  'gallery',
  'pricing',
  'faq',
  'cta',
  'booking',
  'contact',
  'map',
  'newsletter',
  'blog',
  'content',
  'footer',
] as const;
export type BuildOnBrandSectionRole = (typeof BUILD_ON_BRAND_SECTION_ROLES)[number];

/** Section layouts, as seen in a reference page. */
export const BUILD_ON_BRAND_SECTION_LAYOUTS = [
  'single-column',
  'centered',
  'split',
  'grid-2',
  'grid-3',
  'grid-4',
  'bento',
  'carousel',
  'list',
  'marquee',
  'form',
] as const;
export type BuildOnBrandSectionLayout = (typeof BUILD_ON_BRAND_SECTION_LAYOUTS)[number];

export const BUILD_ON_BRAND_SECTION_SOURCES = ['kit', 'catalog', 'library'] as const;
export type BuildOnBrandSectionSource = (typeof BUILD_ON_BRAND_SECTION_SOURCES)[number];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;
const id = z.string().trim().min(1).max(200).regex(ID_PATTERN);
const designSystemId = z.string().trim().min(1).max(200);
const pageFile = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}\.html$/u, 'Expected a root-level .html file name');
const pageCount = z.number().int().min(BUILD_ON_BRAND_PAGE_COUNT_MIN).max(BUILD_ON_BRAND_PAGE_COUNT_MAX);

/** True for an absolute http(s) URL without credentials. Pure: uses only the WHATWG URL global. */
export function isBuildOnBrandReferenceUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return parsed.hostname.length > 0;
}

const referenceUrl = z.string().trim().max(2000).refine(isBuildOnBrandReferenceUrl, {
  message: 'Expected an http(s) URL without credentials',
});

/**
 * What the Design Index route chose, as ids only: the routed spine and family, the person's
 * keep/drop choice for the family's optional sections, and the insertable section-catalogue
 * entries they picked. The daemon re-resolves every id; unknown ones are dropped with a warning.
 */
export const buildOnBrandRouteSchema = z
  .object({
    spine: z.string().regex(/^[A-Z]{2}$/u).optional(),
    family: id.optional(),
    sections: z.record(id, z.enum(['keep', 'drop'])).optional(),
    catalogEntryIds: z.array(id).max(BUILD_ON_BRAND_ROUTE_ENTRY_MAX).optional(),
  })
  .strict();
export type BuildOnBrandRoute = z.infer<typeof buildOnBrandRouteSchema>;

/**
 * Step 4, Improve prompt (B8-1): the accepted design brief this build binds to. A brief belongs to a
 * project, so the build runs in that project (made by `POST /api/build-on-brand/project`) instead
 * of a new one. `{id, revision, hash}` is the same run binding `POST /api/runs` takes.
 */
export const buildOnBrandDesignBriefSchema = runDesignBriefBindingSchema
  .extend({ projectId: z.string().trim().min(1).max(200).regex(ID_PATTERN) })
  .strict();
export type BuildOnBrandDesignBrief = z.infer<typeof buildOnBrandDesignBriefSchema>;

export const buildOnBrandRequestSchema = z
  .object({
    brief: z.string().max(BUILD_ON_BRAND_BRIEF_MAX_CHARS).optional(),
    referenceUrl: referenceUrl.optional(),
    designSystemId,
    useLibrary: z.boolean().default(true),
    pageCount: pageCount.default(BUILD_ON_BRAND_PAGE_COUNT_DEFAULT),
    target: z.enum(BUILD_ON_BRAND_TARGETS).default(BUILD_ON_BRAND_TARGETS[0]),
    name: z.string().trim().min(1).max(120).optional(),
    agentId: id.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    route: buildOnBrandRouteSchema.optional(),
    designBrief: buildOnBrandDesignBriefSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.brief?.trim()) || Boolean(value.referenceUrl), {
    message: 'A brief or a reference URL is required',
    path: ['brief'],
  });
export type BuildOnBrandRequest = z.input<typeof buildOnBrandRequestSchema>;
export type BuildOnBrandParsedRequest = z.output<typeof buildOnBrandRequestSchema>;

const digestSectionSchema = z
  .object({
    role: z.enum(BUILD_ON_BRAND_SECTION_ROLES),
    layout: z.enum(BUILD_ON_BRAND_SECTION_LAYOUTS),
    itemCount: z.number().int().min(0).max(64).optional(),
  })
  .strict();

/** Structure only: every string leaf is a fixed enum value, so no copy can travel in it. */
export const buildOnBrandReferenceDigestSchema = z
  .object({
    schema: z.literal(BUILD_ON_BRAND_REFERENCE_DIGEST_SCHEMA),
    nav: z
      .object({
        itemCount: z.number().int().min(0).max(32),
        hasCta: z.boolean(),
      })
      .strict(),
    pages: z
      .array(
        z
          .object({
            role: z.enum(BUILD_ON_BRAND_PAGE_ROLES),
            sections: z.array(digestSectionSchema).max(40),
          })
          .strict(),
      )
      .max(BUILD_ON_BRAND_PAGE_COUNT_MAX),
  })
  .strict();
export type BuildOnBrandReferenceDigest = z.infer<typeof buildOnBrandReferenceDigestSchema>;

const planSectionSchema = z
  .object({
    role: z.enum(BUILD_ON_BRAND_SECTION_ROLES),
    source: z.enum(BUILD_ON_BRAND_SECTION_SOURCES),
    ref: id.optional(),
  })
  .strict();
export type BuildOnBrandPlanSection = z.infer<typeof planSectionSchema>;

const planPageSchema = z
  .object({
    role: z.enum(BUILD_ON_BRAND_PAGE_ROLES),
    file: pageFile,
    sections: z.array(planSectionSchema).min(1).max(16),
  })
  .strict();
export type BuildOnBrandPlanPage = z.infer<typeof planPageSchema>;

const libraryInsertSchema = z
  .object({
    itemId: id,
    page: pageFile,
    role: z.enum(BUILD_ON_BRAND_SECTION_ROLES),
  })
  .strict();

export const buildOnBrandPlanSchema = z
  .object({
    pageCount,
    useLibrary: z.boolean(),
    target: z.enum(BUILD_ON_BRAND_TARGETS),
    designSystem: z
      .object({
        id: designSystemId,
        title: z.string().max(200).optional(),
        binding: z
          .object({
            tokensStylesheet: z.literal('tokens.css'),
            componentsManifest: z.string().max(200).optional(),
          })
          .strict(),
      })
      .strict(),
    pages: z.array(planPageSchema).min(BUILD_ON_BRAND_PAGE_COUNT_MIN).max(BUILD_ON_BRAND_PAGE_COUNT_MAX),
    libraryInserts: z.array(libraryInsertSchema).max(16),
    reference: z.object({ digest: buildOnBrandReferenceDigestSchema }).strict().optional(),
    route: buildOnBrandRouteSchema.optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.pages.length !== plan.pageCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pages must hold exactly pageCount pages', path: ['pages'] });
    }
    if (plan.pages[0] && plan.pages[0].file !== 'index.html') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the first page must be index.html', path: ['pages', 0, 'file'] });
    }
    const files = new Set(plan.pages.map((page) => page.file));
    if (files.size !== plan.pages.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'page files must be unique', path: ['pages'] });
    }
    if (!plan.useLibrary) {
      if (plan.libraryInserts.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'library inserts need useLibrary', path: ['libraryInserts'] });
      }
      plan.pages.forEach((page, pageIndex) => {
        page.sections.forEach((section, sectionIndex) => {
          if (section.source === 'library') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'library sections need useLibrary',
              path: ['pages', pageIndex, 'sections', sectionIndex, 'source'],
            });
          }
        });
      });
    }
    plan.libraryInserts.forEach((insert, index) => {
      if (!files.has(insert.page)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'library insert names a page the plan does not have', path: ['libraryInserts', index, 'page'] });
      }
    });
  });
export type BuildOnBrandPlan = z.infer<typeof buildOnBrandPlanSchema>;

export const buildOnBrandResultSchema = z
  .object({
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    runId: z.string().min(1),
    plan: buildOnBrandPlanSchema,
    warnings: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();
export type BuildOnBrandResult = z.infer<typeof buildOnBrandResultSchema>;

export const buildOnBrandPlanResponseSchema = z
  .object({
    plan: buildOnBrandPlanSchema,
    warnings: z.array(z.string().max(500)).max(20).optional(),
  })
  .strict();
export type BuildOnBrandPlanResponse = z.infer<typeof buildOnBrandPlanResponseSchema>;

/** Rules the post-build site check runs, in display order. */
export const SITE_CHECK_RULE_IDS = [
  'pages-present',
  'nav-links-resolve',
  'viewport-meta',
  'reduced-motion',
  'kit-tokens-linked',
  'stand-ins-labelled',
  'no-remote-images',
] as const;
export type SiteCheckRuleId = (typeof SITE_CHECK_RULE_IDS)[number];

export const siteCheckResultSchema = z
  .object({
    pages: z.array(z.string()),
    rules: z.array(
      z
        .object({
          id: z.enum(SITE_CHECK_RULE_IDS),
          ok: z.boolean(),
          detail: z.string().max(2000),
        })
        .strict(),
    ),
    ok: z.boolean(),
  })
  .strict();
export type SiteCheckResult = z.infer<typeof siteCheckResultSchema>;

/** Why a design system cannot carry a build (`DESIGN_SYSTEM_NOT_INSTALLED` details.reason). */
export const BUILD_ON_BRAND_KIT_REFUSAL_REASONS = ['not-installed', 'draft', 'unreviewed', 'design-md-missing'] as const;
export type BuildOnBrandKitRefusalReason = (typeof BUILD_ON_BRAND_KIT_REFUSAL_REASONS)[number];

/** `POST /api/build-on-brand/project`: the empty project an Improve-prompt brief is written into. */
export const buildOnBrandProjectRequestSchema = z
  .object({
    designSystemId,
    name: z.string().trim().min(1).max(120).optional(),
    brief: z.string().max(BUILD_ON_BRAND_BRIEF_MAX_CHARS).optional(),
  })
  .strict();
export type BuildOnBrandProjectRequest = z.infer<typeof buildOnBrandProjectRequestSchema>;
export interface BuildOnBrandProjectResponse {
  projectId: string;
}
