/**
 * `GET /api/sections` and `GET /api/sections/:id` — the full selectable section catalog
 * (`sol-design.md` §1/§5, phase D "product surfaces" row): `@mish/section-catalog`'s
 * built-in, validated `catalog.json` (HyperUI blocks + the 13 agency families' own sections +
 * the catalogued, not-yet-insertable Cult UI Pro sections/pages, static, built at author time by `packages/section-catalog/scripts/build-catalog.ts`) merged
 * with the MotionSites bridge's own entries (`apps/daemon/src/motionsites/catalog.ts`'s
 * `fetchMotionSitesCatalogEntries` — bundled `local-corpus` plus the federated
 * `motionsites-mcp` source, phase C), plus the five built-in design directions
 * (`@mish/agency-fast-lane/section-overlay`'s `listDesignDirections`) a
 * `sectionSelection.directionId` may name. Static entries first, then the bridge's own (which
 * itself puts `local-corpus` before the federated half) — the same "local first" order
 * `motionsites/catalog.ts`'s own module doc fixes.
 *
 * `catalog.json` is imported as a JSON module (not read from disk at request time): it is a
 * small, build-time-validated manifest, and a static import survives the daemon's esbuild
 * prebundle the same way `genui-catalog.ts`'s `@mish/genui-catalog/data` import does —
 * unlike an `import.meta.dirname`-relative file read, which would resolve inside the prebundle
 * where the source tree does not exist.
 *
 * A missing/expired MotionSites connection never fails this route — same rule as
 * `routes/motionsites.ts`'s own `/api/motionsites/catalog`: it just means fewer
 * `motionsites-prompt` entries in the response, not an error. No local same-origin gate either
 * (unlike `agency-build.ts`'s build-starting routes): this is a read-only, public-safe catalog
 * listing, and nothing here ever fetches a MotionSites prompt BODY (`get_prompt`) — that stays
 * reserved for `POST /api/agency/build`'s `designReferenceId`.
 *
 * A `cult-pro` entry is served brand-free (`publicCultEntry`): its id is the public `cult:<slug>`,
 * never the internal inventory key, which can name the provider a style came from. `/:id` also
 * accepts the bare slug and the old internal id.
 *
 * `od sections list|get` and the web section picker (`DesignIndexView.tsx`) both read this route
 * — see the root `AGENTS.md`'s "Capability exposure (UI/CLI dual-track)" rule.
 */

import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import type {
  SectionCatalogEntry,
  SectionCatalogSectionKind,
  SectionCatalogSpineCode,
  SectionEntryResponse,
  SectionsListResponse,
} from '@mish/contracts/api/section-catalog';
import { listDesignDirections } from '@mish/agency-fast-lane/section-overlay';
import { cultDisplayText, cultLocalOnlyRefusal } from '@mish/contracts';
import { cultPublicId } from '../cult-public-ids.js';
import { mishPackGeneration } from '../mish-packs/overlay.js';
import { sectionCatalogData } from '../section-catalog-data.js';
import { fetchMotionSitesCatalogEntries } from '../motionsites/catalog.js';
import { renderSectionPreview, SECTION_PREVIEW_FRAME_CSP, type SectionPreviewRoots } from '../workbench/section-previews.js';

export interface RegisterSectionsRoutesDeps extends RouteDeps<'http' | 'paths'> {}

export interface SectionsRouteOptions {
  /** AC-R07 compiled-section previews (`GET /api/sections/:id/preview`); omitted, every preview is 404. */
  previewRoots?: SectionPreviewRoots;
}

/** The static half of the merged catalog: the bundled file plus any installed pack's entries,
 * built once per pack generation, never re-parsed per request. Only the MotionSites half needs a
 * live fetch. */
let staticCache: { generation: number; raw: readonly SectionCatalogEntry[]; served: readonly SectionCatalogEntry[] } | null = null;

function staticEntries(): { raw: readonly SectionCatalogEntry[]; served: readonly SectionCatalogEntry[] } {
  const generation = mishPackGeneration();
  if (staticCache?.generation === generation) return staticCache;
  const raw = (sectionCatalogData() as unknown as { entries: SectionCatalogEntry[] }).entries;
  const served = raw.flatMap((entry) => {
    const entryServed = publicCultEntry(entry);
    return entryServed ? [entryServed] : [];
  });
  staticCache = { generation, raw, served };
  return staticCache;
}

/**
 * A Cult entry as it is served: the internal inventory id (`cult:<name>`) can name the provider
 * a style came from, and the stored summary and source title are the provider's raw text. The
 * served entry carries the public id (`cult:<slug>`, `../cult-public-ids.ts`) as its `id`,
 * `provenance.cultId` and `adapterId`, the scrubbed summary, and its display title as the source
 * title. A build maps the public id back (`routes/agency-build.ts`). Other entries pass through;
 * a Cult entry without a public id is `undefined` (left out, never served branded).
 */
export function publicCultEntry(entry: SectionCatalogEntry): SectionCatalogEntry | undefined {
  if (entry.sourceKind !== 'cult-pro' || entry.content.kind !== 'cult-item') return entry;
  const publicId = cultPublicId(entry.id);
  // No slug yet (`generated/slugs.json` not regenerated after a catalog update): the entry is left
  // out rather than served under its internal id, and the daemon still starts. The catalog
  // package's `check` fails on a missing slug, so this is never shipped.
  if (publicId === undefined) {
    console.error('[sections] a Cult section has no public id and is not served; regenerate the catalog package slugs');
    return undefined;
  }
  const { adapterId, provenance, summary } = entry.content;
  return {
    ...entry,
    id: publicId,
    content: {
      kind: 'cult-item',
      summary: cultDisplayText(summary),
      sourceTitle: entry.title,
      provenance: { cultId: publicId, snapshotId: provenance.snapshotId },
      ...(adapterId !== undefined ? { adapterId: publicId } : {}),
    },
  };
}

const SPINE_CODES: ReadonlySet<string> = new Set<SectionCatalogSpineCode>(['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI']);
const SECTION_KINDS: ReadonlySet<string> = new Set<SectionCatalogSectionKind>([
  'navigation', 'hero', 'features', 'services', 'benefits', 'process-steps', 'proof-gallery',
  'product-grid', 'pricing', 'plan-comparison', 'testimonials', 'reviews-ratings', 'stats-metrics',
  'logo-wall', 'team', 'about-story', 'manifesto-statement', 'faq', 'blog-articles',
  'newsletter-waitlist', 'contact-form', 'booking-availability', 'location-map-hours', 'cta-band',
  'footer', 'timeline-roadmap', 'integrations', 'specifications', 'page-composition', 'unclassified',
]);

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function matchesSpine(entry: SectionCatalogEntry, spine: string | undefined): boolean {
  if (spine === undefined) return true;
  if (entry.spineAffinities === 'any') return true;
  if (entry.spineAffinities === 'unclassified') return false;
  return (entry.spineAffinities as readonly string[]).includes(spine);
}

function matchesKind(entry: SectionCatalogEntry, kind: string | undefined): boolean {
  return kind === undefined || entry.sectionKind === kind;
}

export function registerSectionsRoutes(app: Express, ctx: RegisterSectionsRoutesDeps, options: SectionsRouteOptions = {}): void {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  /** The merged catalog for this one request — `local`/`static` entries plus whatever the
   * MotionSites bridge can currently see. Re-fetched per request (not cached), same as
   * `routes/motionsites.ts`'s own `/api/motionsites/catalog`: a signed-in user's federated
   * entries can change between requests (a new prompt saved, an account connected). */
  const mergedEntries = async (): Promise<{ entries: SectionCatalogEntry[]; upstream?: SectionsListResponse['upstream'] }> => {
    const { entries: federated, upstream } = await fetchMotionSitesCatalogEntries(RUNTIME_DATA_DIR);
    return { entries: [...staticEntries().served, ...federated], ...(upstream ? { upstream } : {}) };
  };

  app.get('/api/sections', async (req, res) => {
    try {
      const spine = queryString(req.query.spine);
      if (spine !== undefined && !SPINE_CODES.has(spine)) {
        return sendApiError(res, 400, 'BAD_REQUEST', `spine must be one of ${[...SPINE_CODES].join(', ')}`);
      }
      const kind = queryString(req.query.kind);
      if (kind !== undefined && !SECTION_KINDS.has(kind)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'kind must be a known section kind');
      }
      const [{ entries, upstream }, directions] = await Promise.all([mergedEntries(), listDesignDirections()]);
      const filtered = entries.filter((entry) => matchesSpine(entry, spine) && matchesKind(entry, kind));
      const body: SectionsListResponse = {
        catalog: { schema: 'section-catalog/1', entries: filtered },
        directions: directions as SectionsListResponse['directions'],
        ...(upstream ? { upstream } : {}),
      };
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * AC-R07: one compiled section as a self-contained preview document (see
   * `workbench/section-previews.ts`). Only the static catalog has compiled bytes; MotionSites
   * entries are prompts, never fetched here. A Cult layout renders licensed source, so it answers
   * this machine only, like the Cult preview routes. The sandbox lives in the header, so the page
   * gets an opaque origin however it is opened.
   */
  app.get('/api/sections/:id/preview', (req, res) => {
    const key = req.params.id;
    const id = cultPublicId(key) ?? key;
    const entry = staticEntries().served.find((candidate) => candidate.id === id);
    const roots = options.previewRoots ?? { hyperuiRoot: null, cultKitDir: null };
    if (!entry) return sendApiError(res, 404, 'NOT_FOUND', 'no section catalog entry with that id');
    if (entry.content.kind === 'cult-item') {
      const refusal = cultLocalOnlyRefusal({ peer: req.socket.remoteAddress, header: (name) => req.get(name) });
      if (refusal !== null) return sendApiError(res, 403, 'FORBIDDEN', `licensed source is served to this machine only: ${refusal}`);
    }
    const preview = renderSectionPreview(entry, staticEntries().raw, roots);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (preview.status !== 200) return sendApiError(res, preview.status, preview.code, preview.message);
    res.setHeader('Content-Security-Policy', SECTION_PREVIEW_FRAME_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.type('html').send(preview.html);
  });

  app.get('/api/sections/:id', async (req, res) => {
    try {
      const { entries } = await mergedEntries();
      // A Cult entry answers to its public id, the bare slug, or its old internal id, and is
      // always served under the public id.
      const key = req.params.id;
      const bareSlug = key.includes(':') ? undefined : `cult:${key}`;
      const id = cultPublicId(key) ?? key;
      const entry = entries.find((candidate) => candidate.id === id) ?? (bareSlug ? entries.find((candidate) => candidate.id === bareSlug) : undefined);
      if (!entry) return sendApiError(res, 404, 'NOT_FOUND', 'no section catalog entry with that id');
      res.json({ entry } satisfies SectionEntryResponse);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });
}
