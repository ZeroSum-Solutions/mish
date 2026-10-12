/**
 * Initial conversion status, before the converter's result is applied (src/converted.ts): only a
 * checked adapter from the kit's `converted/` output makes a row `insertable`. Items that need a live runtime a
 * static page cannot provide are `adapter-needed` with the reason stated, never silently flattened.
 */

import type { AssetKind, Conversion, RuntimeFeature } from './types.ts';

const NEEDS_ADAPTER: ReadonlySet<RuntimeFeature> = new Set([
  'api-routes', 'canvas', 'server-actions', 'shaders', 'webgl',
]);

export function initialConversion(
  assetKind: AssetKind,
  category: string,
  features: readonly RuntimeFeature[],
  pendingReason: string | undefined,
): Conversion {
  if (pendingReason !== undefined) return { status: 'pending-fetch', reason: pendingReason };
  if (assetKind === 'app') {
    return {
      status: 'app-only',
      reason: `application behavior (category ${category || 'none'}); a static site build cannot promise it`,
    };
  }
  const blocking = features.filter((f) => NEEDS_ADAPTER.has(f));
  if (blocking.length > 0) {
    return { status: 'adapter-needed', reason: `needs ${blocking.join(', ')}; a static adapter must supply a fallback` };
  }
  return { status: 'unconverted' };
}
