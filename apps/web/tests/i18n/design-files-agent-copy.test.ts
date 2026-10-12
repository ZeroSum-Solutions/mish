import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/locales/en';


const LOCALE_DICTS = {
  en,

};

describe('Design Files agent copy', () => {
  it('uses neutral agent wording in shared helper text', () => {
    for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
      expect(dict['designFiles.dropDesc'], locale).not.toMatch(/claude/i);
    }
  });
});
