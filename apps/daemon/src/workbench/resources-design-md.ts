import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceCandidate, ResourceSourceSnapshot } from '@open-design/contracts';
import { readPackageFile } from './resources-design-systems.js';
import type { OwnedKitListing } from './resources-user-design-systems.js';
import type { ResourceSourceAdapter } from './resources.js';

/**
 * AC-R04.1/R04.2 `design-md`: the DESIGN.md documents of the bundled design
 * systems and of the caller's own visible kits, as reference-only guidance.
 *
 * A DESIGN.md names swatches and roles in prose; it is not an installable token
 * set, so every item is `reference-only` and its swatches never satisfy the
 * AC-R05.2 eligible colour criterion (see eligibleTokenKind). Kit visibility is the
 * same per-request listing the design-systems source uses. The curated external
 * Awesome DESIGN.md roster is not federated here; it has no local copy.
 */
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const DESIGN_MD_LIMITS = Object.freeze({ documents: 256, swatches: 24 });
function swatches(markdown: string, limit: number): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/giu)) {
    found.add(match[0].toLowerCase());
    if (found.size >= limit) break;
  }
  return [...found];
}
function heading(markdown: string): string | null {
  return /^#\s+(.{1,120})$/mu.exec(markdown)?.[1]?.trim() ?? null;
}
function documentItem(itemId: string, title: string, bytes: Buffer, bundled: boolean, attribution: string): ResourceCandidate {
  const text = bytes.toString('utf8');
  const named = swatches(text, DESIGN_MD_LIMITS.swatches);
  return {
    ref: { sourceType: 'reference', sourceId: 'design-md', itemId, revisionOrDigest: `sha256:${sha256(bytes)}` },
    title: `${title} DESIGN.md`, category: 'reference', readiness: 'reference-only',
    compatibility: { nativeFormat: 'markdown', targets: [], state: 'unsupported', reason: 'Reference guidance, not an installable token set' },
    rightsStatus: bundled ? 'permitted' : 'unknown',
    fitReasons: [
      named.length ? `Swatches named in DESIGN.md: ${named.join(', ')}` : 'DESIGN.md names no hex swatches',
      'Reference-only: these swatches are guidance and do not count as an eligible project colour',
    ],
    previewCapability: { available: false, kind: 'none', reason: 'reference-only-document' },
    adoptionCapability: { available: false, reason: 'reference-only' }, sourceAttribution: { title: attribution },
    implementationOrigin: bundled ? 'bundled' : 'user-design-system', styleTags: ['design-md', ...(named.length ? ['swatches'] : [])],
    operationGrants: [], admissionStage: 'reference-only', needDecision: 'reference-only',
    needReason: 'DESIGN.md is reference guidance; derive project tokens before use',
  };
}
export function createDesignMdResourceSource(deps: { root?: string; userKits?: () => Promise<OwnedKitListing> }): ResourceSourceAdapter {
  return {
    sourceId: 'design-md',
    async list(): Promise<ResourceSourceSnapshot> {
      const items: ResourceCandidate[] = [];
      const reasons = new Map<string, number>();
      const note = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (deps.root) {
        try {
          const root = await realpath(deps.root);
          const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')).map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en'));
          if (entries.length > DESIGN_MD_LIMITS.documents) note('document-limit-exceeded');
          for (const name of entries.slice(0, DESIGN_MD_LIMITS.documents)) {
            const packageRoot = path.join(root, name);
            const bytes = await readPackageFile(packageRoot, 'DESIGN.md');
            if (bytes) items.push(documentItem(name, heading(bytes.toString('utf8')) ?? name, bytes, true, `${name} · bundled`));
          }
        } catch { note('resource-root-unreadable'); }
      }
      if (deps.userKits) {
        try {
          const listing = await deps.userKits();
          if (listing.reason) note(listing.reason);
          for (const kit of listing.kits.slice(0, DESIGN_MD_LIMITS.documents)) {
            try {
              const root = await realpath(kit.root);
              const kitRoot = await realpath(path.join(root, kit.dirId));
              if (!kitRoot.startsWith(root + path.sep)) { note('user-kit-outside-root'); continue; }
              const bytes = await readPackageFile(kitRoot, 'DESIGN.md');
              if (bytes) items.push(documentItem(kit.id, kit.title, bytes, false, `${kit.title} · ${kit.teamSynced ? 'team kit' : 'your kit'}`));
              else note('user-kit-design-unreadable');
            } catch { note('user-kit-unreadable'); }
          }
        } catch { note('user-kits-unreadable'); }
      }
      const reason = [...reasons].map(([key, count]) => `${key}:${count}`).join('; ') || null;
      const listingDigest = sha256(JSON.stringify(items.map(item => [item.ref.itemId, item.ref.revisionOrDigest])));
      return { items, status: { sourceId: 'design-md', state: reason ? 'degraded' : 'searched', reason, itemCount: items.length, listingDigest } };
    },
  };
}
