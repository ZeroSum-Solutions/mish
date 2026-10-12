// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RAIL_OPEN_STORAGE_KEY,
  readInitialRailDocked,
  readStoredRailPreference,
  resolveRailDocked,
} from '../../src/components/entryRailBridge';
import { installViewport } from '../helpers/viewport-media';

// Decision D13 (2026-10-09): the Home nav rail docks by default at >= 1280 px
// when the user has never chosen; an explicit choice always wins; at <= 1080 px
// CSS cannot show a docked rail, so the rail presents collapsed there while
// the stored preference is kept.

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readStoredRailPreference', () => {
  it('reads a missing value as "never chosen"', () => {
    expect(readStoredRailPreference()).toBeNull();
  });

  it('preserves valid stored choices', () => {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
    expect(readStoredRailPreference()).toBe(true);
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'false');
    expect(readStoredRailPreference()).toBe(false);
  });

  it('reads an invalid value or unavailable storage as "never chosen"', () => {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'yes');
    expect(readStoredRailPreference()).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readStoredRailPreference()).toBeNull();
  });
});

describe('resolveRailDocked', () => {
  it('docks a never-chosen rail only on a wide viewport', () => {
    expect(resolveRailDocked(null, { wide: true, narrow: false })).toBe(true);
    expect(resolveRailDocked(null, { wide: false, narrow: false })).toBe(false);
    expect(resolveRailDocked(null, { wide: false, narrow: true })).toBe(false);
  });

  it('lets an explicit choice win above the narrow breakpoint', () => {
    expect(resolveRailDocked(false, { wide: true, narrow: false })).toBe(false);
    expect(resolveRailDocked(true, { wide: false, narrow: false })).toBe(true);
  });

  it('never presents a docked rail where CSS hides it', () => {
    expect(resolveRailDocked(true, { wide: false, narrow: true })).toBe(false);
  });
});

describe('readInitialRailDocked', () => {
  it('resolves synchronously from storage and the current viewport', () => {
    installViewport(1440);
    expect(readInitialRailDocked()).toBe(true);
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'false');
    expect(readInitialRailDocked()).toBe(false);
  });

  it('reports collapsed below the default threshold and where CSS hides the rail', () => {
    installViewport(1024);
    expect(readInitialRailDocked()).toBe(false);
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
    expect(readInitialRailDocked()).toBe(false);
  });
});
