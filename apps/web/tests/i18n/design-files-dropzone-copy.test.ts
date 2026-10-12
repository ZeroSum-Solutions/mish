import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/locales/en';


const LOCALE_DICTS = {
  en,

};

describe('Design Files dropzone copy', () => {
  it('does not advertise unsupported Figma link drops', () => {
    for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
      expect(dict['designFiles.dropDesc'], locale).not.toMatch(/figma/i);
    }
  });
});
