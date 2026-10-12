// `expectBrandFree` for vitest, over the independent check in ./cult-brand-names.ts.

import { expect } from 'vitest';

import { brandHit } from './cult-brand-names.js';

export { asWords, brandHit } from './cult-brand-names.js';

export function expectBrandFree(text: string, where: string): void {
  expect(brandHit(text), where).toBeNull();
}
