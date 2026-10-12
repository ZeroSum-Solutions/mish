// Bridge between EntryShell (the owner of the entry nav-rail open state) and
// chrome that lives in a sibling React tree — the pinned Home tab's sidebar
// toggle in WorkspaceTabsBar. Kept in a leaf module so the tabs bar can share
// this contract without importing the whole EntryShell module graph.
import { useEffect, useState } from 'react';

// Persisted entry nav-rail preference. Only an EXPLICIT user toggle writes it
// (decision D13, 2026-10-09): a missing value means the user has never chosen,
// and the viewport then decides. Values written before D13 by the old
// write-on-every-change effect are kept as they are; a stored `false` may be
// such an automatic default rather than proven intent, but it still wins.
export const RAIL_OPEN_STORAGE_KEY = 'od.entry.railOpen';

// At or below this width entry-layout.css cannot show a docked rail (the grid
// track zeroes out), so the rail presents collapsed there whatever the
// preference says, and opening it shows a dismissible overlay instead. Keep in
// sync with the `@media (max-width: 1080px)` block in entry-layout.css.
export const RAIL_AUTO_COLLAPSE_QUERY = '(max-width: 1080px)';

// A never-chosen rail docks open from this width up (D13). 1280 px is a
// starting threshold: the 236 px rail leaves 1044 px for content there.
export const RAIL_DEFAULT_OPEN_QUERY = '(min-width: 1280px)';

// Window event dispatched by chrome outside the entry tree (the pinned Home
// tab's sidebar toggle in WorkspaceTabsBar) to expand/collapse the entry rail.
export const ENTRY_RAIL_TOGGLE_EVENT = 'od:entry-rail-toggle';

// Window event dispatched by EntryShell whenever the rail's ACTUAL visibility
// changes (docked, or open as an overlay), with `detail: { open: boolean }`,
// so outside chrome can mirror it (the pinned toggle's `aria-expanded`).
export const ENTRY_RAIL_STATE_EVENT = 'od:entry-rail-state';

/** `true`/`false` for an explicit stored choice, `null` when never chosen. */
export type RailPreference = boolean | null;

export interface RailViewport {
  /** At or above the never-chosen default-open width. */
  wide: boolean;
  /** At or below the width where CSS cannot show a docked rail. */
  narrow: boolean;
}

/**
 * The stored preference. Missing, invalid or unavailable storage all read as
 * "never chosen" — nothing is written back.
 */
export function readStoredRailPreference(): RailPreference {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

/** Records an explicit user choice. Call only from a user toggle. */
export function writeStoredRailPreference(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    /* ignore quota / disabled storage */
  }
}

function matches(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

export function readRailViewport(): RailViewport {
  return {
    wide: matches(RAIL_DEFAULT_OPEN_QUERY),
    narrow: matches(RAIL_AUTO_COLLAPSE_QUERY),
  };
}

/**
 * Whether the rail is presented docked: an explicit choice wins, a
 * never-chosen rail docks on a wide viewport, and nothing docks where CSS
 * cannot show it.
 */
export function resolveRailDocked(preference: RailPreference, viewport: RailViewport): boolean {
  if (viewport.narrow) return false;
  return preference ?? viewport.wide;
}

/**
 * Synchronous first-render value (the app renders client-only, so there is no
 * server markup to match): resolving here rather than after mount keeps the
 * rail from sliding open on first paint.
 */
export function readInitialRailDocked(): boolean {
  return resolveRailDocked(readStoredRailPreference(), readRailViewport());
}

/** The live viewport facts the rail presentation depends on. */
export function useRailViewport(): RailViewport {
  const [viewport, setViewport] = useState<RailViewport>(readRailViewport);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(RAIL_DEFAULT_OPEN_QUERY);
    const narrow = window.matchMedia(RAIL_AUTO_COLLAPSE_QUERY);
    const sync = () => {
      setViewport((current) => {
        const next = { wide: wide.matches, narrow: narrow.matches };
        return current.wide === next.wide && current.narrow === next.narrow ? current : next;
      });
    };
    sync();
    wide.addEventListener?.('change', sync);
    narrow.addEventListener?.('change', sync);
    return () => {
      wide.removeEventListener?.('change', sync);
      narrow.removeEventListener?.('change', sync);
    };
  }, []);
  return viewport;
}
