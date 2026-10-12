/**
 * The Build on brand plan: which pages, which sections on each page, and where each section
 * comes from (`kit` | `catalog` | `library`). Pure and deterministic: the same request, kit,
 * digest and catalogue always give the same plan.
 *
 * Page roles come from the reference digest when there is one, then from the default role order.
 * Home-page sections come from the digest's home page, then the Design Index route's keep/drop
 * hints and picked catalogue entries, then the per-role defaults. A catalogue section is used only
 * when an insertable adapter exists for that role (route picks first, then a spine match, then id).
 */
import {
  buildOnBrandPlanSchema,
  type BuildOnBrandPageRole,
  type BuildOnBrandParsedRequest,
  type BuildOnBrandPlan,
  type BuildOnBrandPlanPage,
  type BuildOnBrandPlanSection,
  type BuildOnBrandReferenceDigest,
  type BuildOnBrandSectionRole,
} from '@mish/contracts';
import type { SectionCatalogEntry, SectionCatalogSectionKind } from '@mish/contracts/api/section-catalog';

export interface PlanKit {
  id: string;
  title?: string;
  hasComponentsManifest: boolean;
}

export interface PlanInput {
  request: BuildOnBrandParsedRequest;
  kit: PlanKit;
  digest?: BuildOnBrandReferenceDigest;
  /** Insertable section-catalogue entries the daemon can render (already filtered). */
  catalog: readonly SectionCatalogEntry[];
}

export interface PlanOutput {
  plan: BuildOnBrandPlan;
  warnings: string[];
}

/** Default page roles, in order of preference, for each page count. */
const DEFAULT_PAGES: Record<3 | 4 | 5, BuildOnBrandPageRole[]> = {
  3: ['home', 'services', 'contact'],
  4: ['home', 'services', 'about', 'contact'],
  5: ['home', 'services', 'about', 'pricing', 'contact'],
};
const FALLBACK_ROLES: BuildOnBrandPageRole[] = ['home', 'services', 'about', 'pricing', 'contact', 'team', 'faq', 'booking', 'work'];

const PAGE_FILE: Record<BuildOnBrandPageRole, string> = {
  home: 'index.html',
  about: 'about.html',
  services: 'services.html',
  work: 'work.html',
  pricing: 'pricing.html',
  team: 'team.html',
  faq: 'faq.html',
  booking: 'booking.html',
  contact: 'contact.html',
};

const PAGE_SECTIONS: Record<BuildOnBrandPageRole, BuildOnBrandSectionRole[]> = {
  home: ['hero', 'services', 'features', 'testimonials', 'cta', 'footer'],
  about: ['hero', 'content', 'team', 'stats', 'cta', 'footer'],
  services: ['hero', 'services', 'process', 'faq', 'cta', 'footer'],
  work: ['hero', 'gallery', 'testimonials', 'cta', 'footer'],
  pricing: ['hero', 'pricing', 'faq', 'cta', 'footer'],
  team: ['hero', 'team', 'cta', 'footer'],
  faq: ['hero', 'faq', 'cta', 'footer'],
  booking: ['hero', 'booking', 'faq', 'footer'],
  contact: ['hero', 'contact', 'map', 'footer'],
};

/** Catalogue section kind → plan section role. `page-composition`/`unclassified` never map. */
const KIND_ROLE: Partial<Record<SectionCatalogSectionKind, BuildOnBrandSectionRole>> = {
  navigation: 'nav',
  hero: 'hero',
  features: 'features',
  services: 'services',
  benefits: 'features',
  'process-steps': 'process',
  'proof-gallery': 'gallery',
  'product-grid': 'gallery',
  pricing: 'pricing',
  'plan-comparison': 'pricing',
  testimonials: 'testimonials',
  'reviews-ratings': 'testimonials',
  'stats-metrics': 'stats',
  'logo-wall': 'logos',
  team: 'team',
  'about-story': 'content',
  'manifesto-statement': 'content',
  faq: 'faq',
  'blog-articles': 'blog',
  'newsletter-waitlist': 'newsletter',
  'contact-form': 'contact',
  'booking-availability': 'booking',
  'location-map-hours': 'map',
  'cta-band': 'cta',
  footer: 'footer',
  'timeline-roadmap': 'process',
  integrations: 'logos',
  specifications: 'features',
};

/** Family optional-section id keyword → role, for the route's keep/drop hints. */
const FAMILY_SECTION_ROLE: ReadonlyArray<[RegExp, BuildOnBrandSectionRole]> = [
  [/review|testimonial|voices|community/u, 'testimonials'],
  [/pric|membership|plans?|insurance/u, 'pricing'],
  [/hours|location|map|directions/u, 'map'],
  [/faq|support|questions/u, 'faq'],
  [/team|authors|people|staff/u, 'team'],
  [/work|projects|portfolio|gallery|stories/u, 'gallery'],
  [/impact|proof|trust|stats/u, 'stats'],
  [/about|story/u, 'content'],
  [/events|booking|appointment/u, 'booking'],
];

/** The most catalogue sections the planner adds on its own (route picks are not capped here). */
const AUTO_CATALOG_MAX = 3;
// Hero and feature blocks are left to the kit on purpose: the catalogue's bento and hero blocks
// carry product-style art that reads off-brand on a service business (dentistry proof, 2026-10-09).
const AUTO_CATALOG_ROLES: ReadonlySet<BuildOnBrandSectionRole> = new Set(['testimonials', 'pricing', 'faq', 'cta']);

export function catalogRoleOf(entry: Pick<SectionCatalogEntry, 'sectionKind'>): BuildOnBrandSectionRole | null {
  return KIND_ROLE[entry.sectionKind] ?? null;
}

export function familySectionRole(sectionId: string): BuildOnBrandSectionRole | null {
  const id = sectionId.toLowerCase();
  for (const [pattern, role] of FAMILY_SECTION_ROLE) if (pattern.test(id)) return role;
  return null;
}

function pageRoles(count: 3 | 4 | 5, digest: BuildOnBrandReferenceDigest | undefined): BuildOnBrandPageRole[] {
  const roles: BuildOnBrandPageRole[] = ['home'];
  const push = (role: BuildOnBrandPageRole) => {
    if (roles.length < count && !roles.includes(role)) roles.push(role);
  };
  for (const page of digest?.pages ?? []) push(page.role);
  for (const role of DEFAULT_PAGES[count]) push(role);
  for (const role of FALLBACK_ROLES) push(role);
  // Contact is the page a client site cannot do without: keep it, replacing the last extra.
  if (!roles.includes('contact')) roles[roles.length - 1] = 'contact';
  return roles;
}

function uniqueRoles(roles: BuildOnBrandSectionRole[]): BuildOnBrandSectionRole[] {
  const seen = new Set<BuildOnBrandSectionRole>();
  const out: BuildOnBrandSectionRole[] = [];
  for (const role of roles) {
    if (role === 'nav' || seen.has(role)) continue;
    seen.add(role);
    out.push(role);
  }
  // Footer always closes a page.
  return [...out.filter((role) => role !== 'footer'), 'footer'];
}

/**
 * Home-page section roles. A kept family section joins the home page unless another page already
 * carries that role; a dropped one leaves the home page (other pages are filtered by the caller).
 */
function homeRoles(input: PlanInput, warnings: string[], elsewhere: ReadonlySet<BuildOnBrandSectionRole>): BuildOnBrandSectionRole[] {
  const fromDigest = input.digest?.pages.find((page) => page.role === 'home')?.sections.map((section) => section.role) ?? [];
  let roles = fromDigest.length >= 2 ? [...fromDigest] : [...PAGE_SECTIONS.home];
  const hints = input.request.route?.sections ?? {};
  for (const [sectionId, choice] of Object.entries(hints)) {
    const role = familySectionRole(sectionId);
    if (!role) {
      warnings.push(`Route section "${sectionId}" has no matching site section; it is passed to the build as a note only.`);
      continue;
    }
    if (choice === 'drop') roles = roles.filter((existing) => existing !== role);
    else if (!roles.includes(role) && !elsewhere.has(role)) roles.splice(Math.max(1, roles.length - 2), 0, role);
  }
  if (!roles.includes('hero')) roles.unshift('hero');
  return uniqueRoles(roles);
}

function spineRank(entry: SectionCatalogEntry, spine: string | undefined): number {
  if (!spine) return 1;
  const affinities = entry.spineAffinities;
  if (Array.isArray(affinities) && (affinities as string[]).includes(spine)) return 0;
  if (affinities === 'any') return 1;
  return 2;
}

/** Build the plan. Never throws for a valid request; drops what it cannot place with a warning. */
export function planBuildOnBrand(input: PlanInput): PlanOutput {
  const { request, kit } = input;
  const warnings: string[] = [];
  const count = request.pageCount as 3 | 4 | 5;
  const roles = pageRoles(count, input.digest);

  const dropped = new Set(
    Object.entries(request.route?.sections ?? {})
      .filter(([, choice]) => choice === 'drop')
      .flatMap(([sectionId]) => familySectionRole(sectionId) ?? []),
  );
  const otherPageRoles = (role: BuildOnBrandPageRole) => uniqueRoles(PAGE_SECTIONS[role]).filter((sectionRole) => !dropped.has(sectionRole));
  const elsewhere = new Set(roles.filter((role) => role !== 'home').flatMap(otherPageRoles));
  const pages: BuildOnBrandPlanPage[] = roles.map((role) => ({
    role,
    file: PAGE_FILE[role],
    sections: (role === 'home' ? homeRoles(input, warnings, elsewhere) : otherPageRoles(role)).map(
      (sectionRole): BuildOnBrandPlanSection => ({ role: sectionRole, source: 'kit' }),
    ),
  }));

  if (request.useLibrary) {
    const byId = new Map(input.catalog.map((entry) => [entry.id, entry]));
    const used = new Set<string>();
    const place = (entry: SectionCatalogEntry, preferHome: boolean): boolean => {
      const role = catalogRoleOf(entry);
      if (!role || role === 'nav' || role === 'footer') return false;
      const ordered = preferHome ? pages : [...pages.slice(1), pages[0]!];
      for (const page of ordered) {
        const section = page.sections.find((candidate) => candidate.role === role && candidate.source === 'kit');
        if (section) {
          section.source = 'catalog';
          section.ref = entry.id;
          used.add(entry.id);
          return true;
        }
      }
      // A picked section whose role the plan does not have yet joins the home page before the footer.
      if (preferHome) {
        const home = pages[0]!;
        home.sections.splice(home.sections.length - 1, 0, { role, source: 'catalog', ref: entry.id });
        used.add(entry.id);
        return true;
      }
      return false;
    };

    for (const picked of request.route?.catalogEntryIds ?? []) {
      const entry = byId.get(picked);
      if (!entry) {
        warnings.push(`Section "${picked}" is not an insertable catalogue section; the kit covers that part instead.`);
        continue;
      }
      if (!place(entry, true)) warnings.push(`Section "${picked}" has no site role; it was left out.`);
    }

    // Auto picks only for an entry made for the routed spine: a generic catalogue block that
    // does not fit the client's industry reads worse than the kit's own components.
    const spine = request.route?.spine;
    let auto = spine ? 0 : AUTO_CATALOG_MAX;
    for (const page of pages) {
      for (const section of page.sections) {
        if (auto >= AUTO_CATALOG_MAX) break;
        if (section.source !== 'kit' || !AUTO_CATALOG_ROLES.has(section.role) || page.role !== 'home') continue;
        const candidates = input.catalog
          .filter((entry) => !used.has(entry.id) && catalogRoleOf(entry) === section.role)
          .sort((a, b) => spineRank(a, spine) - spineRank(b, spine) || a.id.localeCompare(b.id));
        const pick = candidates.find((entry) => spineRank(entry, spine) === 0);
        if (!pick) continue;
        section.source = 'catalog';
        section.ref = pick.id;
        used.add(pick.id);
        auto += 1;
      }
    }
  } else if ((request.route?.catalogEntryIds ?? []).length > 0) {
    warnings.push('"Use our components" is off, so the picked catalogue sections were left out.');
  }

  const plan = buildOnBrandPlanSchema.parse({
    pageCount: count,
    useLibrary: request.useLibrary,
    target: request.target,
    designSystem: {
      id: kit.id,
      ...(kit.title ? { title: kit.title.slice(0, 200) } : {}),
      binding: {
        tokensStylesheet: 'tokens.css',
        ...(kit.hasComponentsManifest ? { componentsManifest: 'components.manifest.json' } : {}),
      },
    },
    pages,
    libraryInserts: [],
    ...(input.digest && input.digest.pages.length > 0 ? { reference: { digest: input.digest } } : {}),
    ...(request.route ? { route: request.route } : {}),
  });
  return { plan, warnings };
}
