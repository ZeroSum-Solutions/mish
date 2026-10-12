/**
 * The design kit a fast-lane build (`POST /api/agency/build`) was asked to wear.
 *
 * A kit is looked up in the catalog THIS request may see: a claimed Workspace/member pair must
 * pass the membership verifier, and the listing is narrowed by the catalog route's own
 * per-member rule (`listOwnedDesignSystemKits`, AC-R04.1/R04.2). So a member can wear only a kit
 * they could pick, a Team kit is read from its Team root, and an unverifiable claim sees no user
 * kit at all. Then the kit is checked like a build-on-brand kit (`routes/build-on-brand.ts`): it
 * must be published, approved at its current revision and not turned off in Settings
 * (`kitRefusalReason`), and its `tokens.css` is read from one revision snapshot, under the kit's
 * own root, whose revision must still equal the approved one. The tokens then become a composed page's direction
 * (`kitDirection`); a kit whose tokens cannot style a page is refused here, before the build
 * starts, rather than half-applied after it.
 */

import { kitDirection, KitDirectionError, type BuildDesignKit } from '@open-design/agency-fast-lane/build';
import type { AgencyBuildDesignKitRefusalCode, DesignSystemSummary } from '@open-design/contracts';
import { kitRefusalReason } from './build-on-brand.js';
import { listOwnedDesignSystemKits, type OwnedKitListerDeps } from '../workbench/resources-user-design-systems.js';

/** A generous bound on a kit id: `user:` plus a directory name, never a document. */
export const DESIGN_SYSTEM_ID_MAX_CHARS = 200;

/** One kit a request may see, and the directory its files live under (user, Team or built-in). */
export interface ScopedKit { summary: DesignSystemSummary; root: string }

export interface AgencyDesignKitDeps {
  /** The kits THIS request may see (`createScopedKitLister`), or why it may see none. */
  listKits: (req: unknown) => Promise<{ kits: ScopedKit[] } | { reason: string }>;
  disabledKitIds: () => Promise<readonly string[]>;
  /** The kit's files from ONE revision snapshot under `root` (`readDesignSystemBuildAssets`). */
  readKitAssets: (root: string, id: string) => Promise<{ revision: string; tokensCss: string | null }>;
}

/**
 * `AgencyDesignKitDeps.listKits` over the daemon catalog: user kits only as
 * `listOwnedDesignSystemKits` admits them for the request (with their own root), built-in kits
 * from the bundled root. `listCatalog` must be the FRESH, scoped catalog, so approval is current.
 */
export function createScopedKitLister(deps: OwnedKitListerDeps & {
  listCatalog: (scope: { workspaceId: string | null; workspaceMemberId: string | null }) => Promise<DesignSystemSummary[]>;
  builtInRoot: string;
}): AgencyDesignKitDeps['listKits'] {
  return async (req) => {
    const owned = await listOwnedDesignSystemKits(req, deps);
    if (owned.reason) return { reason: owned.reason };
    const scope = { workspaceId: owned.workspace?.workspaceId ?? null, workspaceMemberId: owned.workspace?.workspaceMemberId ?? null };
    const roots = new Map(owned.kits.map((kit) => [kit.id, kit.root]));
    const kits: ScopedKit[] = [];
    for (const summary of await deps.listCatalog(scope)) {
      if (summary.id.startsWith('user:')) {
        const root = roots.get(summary.id);
        if (root) kits.push({ summary, root });
      } else if (summary.source === 'built-in') {
        kits.push({ summary, root: deps.builtInRoot });
      }
    }
    return { kits };
  };
}

export type AgencyDesignKitResolution =
  | { ok: true; kit: BuildDesignKit }
  | { ok: false; code: AgencyBuildDesignKitRefusalCode; message: string; details: { designSystemId: string; reason: string; token?: string } };

const NOT_SELECTABLE: Record<string, string> = {
  'not-installed': 'That design system is not installed. Pick an installed kit.',
  draft: 'That design system is still a draft. Publish it before a build uses it.',
  unreviewed: 'That design system is Unreviewed. Approve its current revision before a build uses it.',
  disabled: 'That design system is turned off in Settings. Turn it on, or pick another kit.',
  'workspace-unverified': 'Your workspace membership could not be verified, so no installed kit can be used. Sign in again, or build without a kit.',
};

const TOKENS_UNUSABLE = 'That design system has no colour roles Build with Jev can use (--bg, --fg and --accent in tokens.css). Use "First draft on a kit" in the Design index, or pick another kit.';

/** Resolves `id` to the kit `req` may wear, or the fixed refusal a client renders. */
export async function resolveAgencyDesignKit(deps: AgencyDesignKitDeps, req: unknown, id: string): Promise<AgencyDesignKitResolution> {
  const refuse = (code: AgencyBuildDesignKitRefusalCode, reason: string, token?: string): AgencyDesignKitResolution => ({
    ok: false,
    code,
    message: code === 'DESIGN_SYSTEM_NOT_SELECTABLE' ? NOT_SELECTABLE[reason] ?? NOT_SELECTABLE['not-installed']! : TOKENS_UNUSABLE,
    details: { designSystemId: id, reason, ...(token ? { token } : {}) },
  });
  const [listing, disabled] = await Promise.all([deps.listKits(req), deps.disabledKitIds()]);
  // An unverifiable Workspace claim sees no user kit; it never falls back to an unscoped lookup.
  if ('reason' in listing) return refuse('DESIGN_SYSTEM_NOT_SELECTABLE', 'workspace-unverified');
  const found = listing.kits.find((kit) => kit.summary.id === id);
  const summary = found?.summary;
  const reason = kitRefusalReason(summary, disabled);
  if (reason) return refuse('DESIGN_SYSTEM_NOT_SELECTABLE', reason);
  let assets: { revision: string; tokensCss: string | null };
  try {
    assets = await deps.readKitAssets(found!.root, id);
  } catch {
    return refuse('DESIGN_SYSTEM_TOKENS_UNUSABLE', 'tokens-missing');
  }
  // The snapshot must be the revision that was approved: an edit since then is not approved.
  if (assets.revision !== summary!.approval?.revision) return refuse('DESIGN_SYSTEM_NOT_SELECTABLE', 'unreviewed');
  if (!assets.tokensCss?.trim()) return refuse('DESIGN_SYSTEM_TOKENS_UNUSABLE', 'tokens-missing');
  const title = typeof summary!.title === 'string' && summary!.title.trim() ? summary!.title.trim() : id;
  try {
    return { ok: true, kit: { id, title, revision: assets.revision, direction: kitDirection(assets.tokensCss, { id, title }) } };
  } catch (error) {
    if (error instanceof KitDirectionError) return refuse('DESIGN_SYSTEM_TOKENS_UNUSABLE', error.code, error.token);
    throw error;
  }
}
