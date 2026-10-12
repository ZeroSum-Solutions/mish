/**
 * OPEND-2807: the permanent error-card button says "Contact us".
 * The key, button location and behavior stay unchanged. English is the only
 * shipped locale. Keep the new value and the old-value regression check.
 */
import { describe, expect, it } from 'vitest';

import { LOCALES, type Dict, type Locale } from '../../src/i18n/types';

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => {
    return Boolean(value) && typeof value === 'object';
  });
  if (!dict) throw new Error(`No dictionary export found for locale ${locale}`);
  return dict;
}

/**
 * 工单要求的最终值,逐字。**不是重译** —— 译文由 OPEND-2807 那次评审
 * 定稿,这里只是把定稿抄成判据。
 */
const CONTACT_US: Record<Locale, string> = {
  en: 'Contact us',
};

/** 改之前那一版「联系支持」。命中说明这个语言被漏掉了。 */
const OLD_CONTACT_SUPPORT: Record<Locale, string> = {
  en: 'Contact support',
};

describe('OPEND-2807 · English contact CTA', () => {
  it('ships one English dictionary', () => {
    expect(LOCALES.length).toBe(1);
    expect(Object.keys(CONTACT_US).length).toBe(1);
    expect(Object.keys(OLD_CONTACT_SUPPORT).length).toBe(1);
  });

  it.each(LOCALES)('%s 的值就是工单定稿那一句', async (locale) => {
    const dict = await loadDict(locale);
    expect(dict['chat.runError.contactSupportCta']).toBe(CONTACT_US[locale]);
  });

  it.each(LOCALES)('%s 不许留着旧的〔联系支持〕', async (locale) => {
    const dict = await loadDict(locale);
    expect(dict['chat.runError.contactSupportCta']).not.toBe(
      OLD_CONTACT_SUPPORT[locale],
    );
  });

  /*
   * 真空探针:上面那条 `not.toBe` 只有在「旧值确实是这些字」时才有意义。
   * 这里证明这张旧值表不是空话 —— 它和新值一一不同。
   */
  it('新旧两张表逐语言都不一样 —— 反向对照不是摆设', () => {
    LOCALES.forEach((locale) => {
      expect(CONTACT_US[locale], `${locale} 新旧值写成了同一句`).not.toBe(
        OLD_CONTACT_SUPPORT[locale],
      );
    });
  });
});
