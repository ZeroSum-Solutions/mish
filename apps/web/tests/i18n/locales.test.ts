import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSystemLocale } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';

import { LOCALES, LOCALE_LABEL, type Dict, type Locale } from '../../src/i18n/types';

const EXPECTED_LOCALES = ['en'];
const RETIRED_PRODUCT_NAME = /\bopen[\s_-]*design\b|\bne[x]u\b/i;

function placeholders(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names.sort();
}

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => {
    return Boolean(value) && typeof value === 'object';
  });
  if (!dict) {
    throw new Error(`No dictionary export found for locale ${locale}`);
  }
  return dict;
}


describe('i18n locales', () => {
  it('does not expose the retired product name in localized copy', async () => {
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${locale}.${key}`).not.toMatch(RETIRED_PRODUCT_NAME);
      }
    }
  });

  it('does not expose the retired product name in shared localized content', () => {
    const i18nDir = new URL('../../src/i18n/', import.meta.url);
    const contentFiles = readdirSync(i18nDir)
      .filter((name) => /^content(?:\.[^.]+)?\.ts$/.test(name));

    for (const name of contentFiles) {
      const source = readFileSync(new URL(name, i18nDir), 'utf8');
      expect(source, name).not.toMatch(RETIRED_PRODUCT_NAME);
    }
  });

  it('resolves the initial locale from browser language preferences', () => {
    // Unsupported languages (even ones once shipped, like zh/pt-PT) fall
    // through to whatever supported language follows in the list, and
    // return null when nothing in the list is supported at all.
    expect(resolveSystemLocale(['zh-Hans-CN', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['zh-Hant-HK', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['pt-PT', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['es-MX', 'en-US'])).toBe("en");
    expect(resolveSystemLocale(['nl-NL', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL'])).toBeNull();
    expect(resolveSystemLocale(['zh-CN'])).toBeNull();
  });

  it('registers every supported locale in the language menu', () => {
    expect(LOCALES).toEqual(EXPECTED_LOCALES);
    expect(LOCALE_LABEL.en).toBe('English');
  });

  it('localizes the Home prototype creation type in every supported locale', async () => {
    const expected: Record<Locale, string> = {
      en: 'Prototype',

    };

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(dict['homeHero.chip.prototype'], `${locale}.homeHero.chip.prototype`).toBe(
        expected[locale],
      );
    }
  });

  // PR #7303 round 3: the ACP handshake-refusal copy used to be an English
  // paragraph the DAEMON wrote into `run.error`, so a Chinese UI showed a
  // Chinese title over an English body. It is a dictionary entry now — pin the
  // language the product signed off, and let the parity test below prove the
  // other seventeen exist with the same placeholders.
  it('localizes the ACP CLI session refusal card', async () => {
    const zh = await loadDict("en");
    expect(zh['chat.runError.title.cliSessionRefused']).toBe("Agent version incompatible");
    expect(zh['chat.runError.cliSessionRefusedMessage']).toBe(
      "{agent} refused to start a session. The installed version is usually incompatible with Mishh Mashh — switch to a different version and retry.",
    );

    // `{agent}` is the ONLY slot the card fills. A locale that carries a
    // `{version}` placeholder would render a literal `{version}` at the user,
    // because nothing supplies one — which is exactly how a half-reverted
    // version variant would escape into production copy.
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(
        dict['chat.runError.cliSessionRefusedMessage'],
        `${locale}.cliSessionRefusedMessage`,
      ).not.toMatch(/\{version\}/);
    }

    // No locale may quietly fall back to English prose for these keys.
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      const dict = await loadDict(locale);
      for (const key of [
        'chat.runError.title.cliSessionRefused',
        'chat.runError.cliSessionRefusedMessage',
      ] as const) {
        expect(dict[key], `${locale}.${key}`).not.toBe(en[key]);
        expect(dict[key], `${locale}.${key}`).not.toMatch(/TODO/i);
      }
    }
  });

  it('keeps locale dictionaries aligned with English keys and placeholders', async () => {
    const englishKeys = Object.keys(en).sort();

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(Object.keys(dict).sort()).toEqual(englishKeys);

      for (const key of englishKeys) {
        const dictKey = key as keyof Dict;
        expect(placeholders(dict[dictKey]), `${locale}.${key}`).toEqual(
          placeholders(en[dictKey]),
        );
      }
    }
  });

  it('labels workspace USD spending power as allowance instead of points or account balance', async () => {
    const expected: Record<Locale, string> = {
      en: 'Allowance',

    };

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(dict['entry.credits'], `${locale}.entry.credits`).toBe(expected[locale]);
      expect(dict['settings.amrBalance'], `${locale}.settings.amrBalance`).toBe(
        expected[locale],
      );
    }
  });

  // The zh-CN/zh-TW terminology-consistency case that used to live here
  // (locking `额度` as the one Chinese word for this wallet/gate copy, and
  // rejecting the `余额`/`餘額` substring it could accidentally collide
  // across this key set (some read `saldo`, others `Cuota`), so there is no
  // real invariant left to pin without inventing one. Dropped along with
  // Chinese rather than papered over.

  it('keeps the recharge recovery action concise enough to sit beside retry', async () => {
    const expected: Record<Locale, string> = {
      en: 'Top up',

    };

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(dict['chat.amrError.rechargeCta'], `${locale}.chat.amrError.rechargeCta`).toBe(
        expected[locale],
      );
    }
  });





  it("explains API provider draft activation in English", () => {
    expect(en['settings.byokDraftNotice']).toBe(
      'Complete the required fields to save this provider. Your current setup will remain active.',
    );

  });







  // Vercel's Security Checkpoint is its own deploy outcome (F2): a visitor
  // meets bot mitigation rather than the page. Both the badge and the sentence
  // that tells the user what to do about it must exist in every locale, or the
  // outcome reads as English to everyone else.
  it('localizes the Security Checkpoint deploy outcome in every supported locale', async () => {
    expect(en['fileViewer.deployLinkChallenged']).toBe(
      "Vercel's Security Checkpoint is challenging visitors. Open the link in a browser.",
    );
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      for (const key of ['fileViewer.deployLinkChallenged', 'fileViewer.deployLinkChallengedLabel'] as const) {
        expect(typeof dict[key], `${locale} must define ${key}`).toBe('string');
        expect(dict[key].trim(), `${locale}.${key} must not be blank`).not.toBe('');
      }
    }
  });

  // Brand / proper-noun lock: these labels are product or technical proper
  // nouns and must stay verbatim English in EVERY locale, never translated.
  // (e.g. the plugin-details "Integrity" field was wrongly localized to
  // 完整性 / Integrität / etc.; lock it so a future translation pass can't
  // re-localize it.)
  it('keeps brand/proper-noun labels verbatim English across every locale', async () => {
    const verbatim: Array<{ key: keyof Dict; value: string }> = [
      { key: 'plugins.availableDetails.integrity', value: 'Integrity' },
    ];
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      for (const { key, value } of verbatim) {
        expect(dict[key], `${locale}.${String(key)}`).toBe(value);
      }
    }
  });

  /*
   * `assistant.waitingFirstOutput` briefly had a reader (2026-09-03 → 2026-09-07):
   * an ACP turn silent for 60s swapped the in-shell row's copy to it. Product
   * reverted that copy on 2026-09-07 — the row reads 「思考中」 again — so the key
   * is back to being a dead key. See
   * `tests/components/chat/waiting-first-output.test.tsx` for the revert, and
   * `ExecutionShell.tsx` for why the *detection* behind it stayed.
   *
   * ⚠️ **The key and its 19 translations stay.** Product removed a rendering,
   * not the situation it describes; the plan of record is to bring it back in a
   * different form (same call product made for S12 on 2026-08-27). Deleting the
   * key now means re-translating it into 19 locales later — and it is exactly
   * the dead-key period that let the bug below slip in unnoticed the first time.
   *
   * That dead period had already hidden a mistranslation: `tr` read
   * 「İlk girdi için bekleniyor」— *waiting for first **input***, the exact
   * inverse of what the line reports. This test is what keeps the next dead
   * period from hiding another one.
   *
   * ⚠️ **What this test can and cannot prove.** Asserting a translated string
   * against the file that defines it is a tautology — it can never tell you
   * whether the Turkish is *good*, only that it is not the specific broken
   * string we already found. So the two halves below claim exactly that much:
   *
   *  · the key resolves to non-empty text in all 19 locales (a real
   *    completeness check — `types.ts` forces the key to exist, not to be
   *    filled in with something), and
   *  · no locale's value carries its own language's word for **input**, which
   *    is a lint pinning one known regression shut, not evidence of quality.
   *
   * The `input`-word list stays SHORT and evidence-backed: only languages
   * where a wrong-direction word was actually observed, or where the
   * input/output pair is close enough to swap by accident. Guessing an
   * "input" word for a language nobody here reads would make this test lie in
   * the other direction.
   */
  it('never says "waiting for first INPUT" in any locale (assistant.waitingFirstOutput)', async () => {
    const inputWords: Partial<Record<Locale, RegExp>> = {

      en: /\binput\b/i,
    };
    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      const value = dict['assistant.waitingFirstOutput'];
      expect(typeof value, `${locale} must define assistant.waitingFirstOutput`).toBe('string');
      expect(value.trim(), `${locale}.assistant.waitingFirstOutput must not be blank`).not.toBe('');
      const wrongDirection = inputWords[locale];
      if (wrongDirection) {
        expect(
          value,
          `${locale}.assistant.waitingFirstOutput reports the model's first OUTPUT, not its input`,
        ).not.toMatch(wrongDirection);
      }
    }
  });
});
