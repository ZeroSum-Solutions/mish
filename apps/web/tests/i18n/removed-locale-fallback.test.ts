// @vitest-environment jsdom

// Retired locale preferences must fall back to English without an error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectInitialLocale, LOCALES, resolveSystemLocale } from '../../src/i18n';

const LS_KEY = 'open-design:locale';
const LS_SOURCE_KEY = 'open-design:locale-source';

const REMOVED_LOCALES = [
  'es', 'es-ES', 'ar', 'de', 'fa', 'fr', 'hu', 'id', 'it', 'ja', 'ko', 'pl',
  'pt-BR', 'ru', 'th', 'tr', 'uk', 'zh-CN', 'zh-TW',
];

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

describe('removed locales fall back to English', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setNavigatorLanguages(['en-US']);
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("ships only English", () => {
    expect([...LOCALES].sort()).toEqual(['en']);
  });

  it.each(REMOVED_LOCALES)('a saved manual pick of %s falls back to en', (locale) => {
    window.localStorage.setItem(LS_KEY, locale);
    window.localStorage.setItem(LS_SOURCE_KEY, 'manual');
    setNavigatorLanguages([locale]);

    expect(detectInitialLocale()).toBe('en');
  });

  it.each(['ja-JP', 'zh-Hant-TW', 'zh-CN', 'pt-BR', 'de-DE', 'fr-FR'])(
    'a browser language of %s resolves to no locale and detection returns en',
    (tag) => {
      expect(resolveSystemLocale([tag])).toBeNull();
      setNavigatorLanguages([tag]);
      expect(detectInitialLocale()).toBe('en');
    },
  );

  it.each(['es', 'es-ES', 'es-MX', 'es;q=0.9', 'es-ES,es;q=0.9'])('resolves the retired browser or Accept-Language preference %s to en', (tag) => {
    expect(resolveSystemLocale([tag])).toBe('en');
    setNavigatorLanguages([tag]);
    expect(detectInitialLocale()).toBe('en');
  });

  it('uses English for mixed browser preferences', () => {
    expect(resolveSystemLocale(['es-MX'])).toBe("en");
    setNavigatorLanguages(['ja-JP', 'es-419']);
    expect(detectInitialLocale()).toBe("en");
  });
});
