// The stored design-index profiles, read by Home.
//
// Deliberately NOT part of the plugin-catalog cache: the index is mutable
// state a user edits in the Design index view (add, remove) and expects to see
// reflected on Home, while the plugin catalog is a slow-moving install list
// with its own TTL and its own `open-design:plugins-changed` event. Sharing
// one cache would tie a reference add to a plugin refresh and back.

import type { DesignIndexFindResponse, DesignProfile } from '@open-design/contracts';

/**
 * Dispatched on `window` after the Design index view successfully stores or
 * removes a profile. Home listens and re-reads the index; nothing else does.
 */
export const DESIGN_INDEX_CHANGED_EVENT = 'open-design:design-index-changed';

/** Home asks for the whole index; the endpoint caps a page at 500. */
export const DESIGN_INDEX_HOME_LIMIT = 500;

export async function listDesignIndexProfiles(
  limit: number = DESIGN_INDEX_HOME_LIMIT,
): Promise<DesignProfile[]> {
  const resp = await fetch(`/api/design-index?limit=${limit}`);
  if (!resp.ok) throw new Error(`design-index request failed: ${resp.status}`);
  const json = (await resp.json()) as DesignIndexFindResponse;
  return json.profiles ?? [];
}

export function notifyDesignIndexChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DESIGN_INDEX_CHANGED_EVENT));
}
