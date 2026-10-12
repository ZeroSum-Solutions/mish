import { afterEach, beforeEach } from 'vitest';
import { setStyleCatalogAssetOrigin } from '../../src/runtime/visual-style-catalog';

/**
 * Stand-in style-catalog asset origin. The fork ships no hosted previews, so
 * cards carry no `preview` until an origin is configured; tests that exercise
 * preview images configure this one first.
 */
export const TEST_STYLE_CATALOG_ORIGIN = 'https://repo-assets.mish.invalid';

/** Configure {@link TEST_STYLE_CATALOG_ORIGIN} for every test in the calling scope. */
export function useConfiguredStyleCatalog(origin: string = TEST_STYLE_CATALOG_ORIGIN): void {
  beforeEach(() => {
    setStyleCatalogAssetOrigin(origin);
  });
  afterEach(() => {
    setStyleCatalogAssetOrigin(null);
  });
}
