// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { detectInitialLocale } from '../../src/i18n';

const LS_KEY = 'open-design:locale';
const LS_SOURCE_KEY = 'open-design:locale-source';

function setStoredLocale(locale: string, source: 'manual' | 'untagged' = 'manual'): void {
  window.localStorage.setItem(LS_KEY, locale);
  if (source === 'manual') {
    window.localStorage.setItem(LS_SOURCE_KEY, 'manual');
  } else {
    window.localStorage.removeItem(LS_SOURCE_KEY);
  }
}

function setNavigatorLanguages(languages: readonly string[]): void {
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    get: () => languages,
  });
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    get: () => languages[0] ?? 'en',
  });
}

// Track the installed mock so each test can swap it out without leaking
// state into the next case (installMockOpenDesignHost returns an
// uninstall callback that restores the previous value).
let uninstallHost: (() => void) | null = null;

function installHostWithOsLocale(value: unknown): void {
  uninstallHost?.();
  uninstallHost = installMockOpenDesignHost({
    host: {
      // The mock host's defaultHost() already sets client.type to
      // 'desktop'; we only override the field exercised here.
      client: { osLocale: value as string | undefined },
    },
  });
}

function clearHost(): void {
  uninstallHost?.();
  uninstallHost = null;
}

describe('detectInitialLocale priority chain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearHost();
    setNavigatorLanguages(['en-US']);
  });

  afterEach(() => {
    window.localStorage.clear();
    clearHost();
  });

  it('prefers a manually-tagged localStorage pick over host and navigator', () => {
    setStoredLocale("en", 'manual');
    installHostWithOsLocale('en-US');
    setNavigatorLanguages(['en-GB']);

    expect(detectInitialLocale()).toBe("en");
  });

  it('ignores an untagged localStorage value when a fresh host locale is available', () => {
    setStoredLocale("en", 'untagged');
    installHostWithOsLocale('en-US');

    expect(detectInitialLocale()).toBe('en');
  });

  it('falls through to navigator when an unsupported locale was stored', () => {
    setStoredLocale('xx-YY', 'manual');
    setNavigatorLanguages(['es-MX']);

    expect(detectInitialLocale()).toBe("en");
  });

  it('uses the desktop host OS locale when no localStorage pick exists', () => {
    installHostWithOsLocale("en");
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe("en");
  });

  it("routes packaged OS locale strings through resolveSystemLocale (es-419 → en)", () => {
    installHostWithOsLocale('es-419');
    setNavigatorLanguages(['en-US']);

    expect(detectInitialLocale()).toBe("en");
  });

  it('falls back to navigator when host osLocale is missing or not a string', () => {
    installHostWithOsLocale(undefined);
    setNavigatorLanguages(['es-AR']);
    expect(detectInitialLocale()).toBe("en");

    installHostWithOsLocale(42);
    setNavigatorLanguages(['en-GB']);
    expect(detectInitialLocale()).toBe('en');
  });

  it('falls back to navigator when host osLocale is not in the supported set', () => {
    installHostWithOsLocale('nl-NL');
    setNavigatorLanguages(['es-CO']);

    expect(detectInitialLocale()).toBe("en");
  });

  it('falls back to en when nothing else is available', () => {
    clearHost();
    setNavigatorLanguages([]);

    expect(detectInitialLocale()).toBe('en');
  });
});
