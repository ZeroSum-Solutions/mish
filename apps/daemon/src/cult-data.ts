/**
 * The Cult UI catalogue data files, each as the bundled package ships it unless an installed Mish
 * pack provides a replacement (`mish-packs/overlay.ts`). Every function re-reads the overlay, so a
 * pack installed while the daemon runs takes effect on the next request; callers that cache a
 * derived value key it on `mishPackGeneration()`.
 */

import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import cultCurationJson from '@mish/cult-ui-catalog/catalog-curation.json' with { type: 'json' };
import cultRefinementsJson from '@mish/cult-ui-catalog/catalog-copy-refinements.json' with { type: 'json' };
import cultSlugsJson from '@mish/cult-ui-catalog/generated/slugs.json' with { type: 'json' };
import cultThumbnailsJson from '@mish/cult-ui-catalog/generated/thumbnails.json' with { type: 'json' };

import { overlayCultJson } from './mish-packs/overlay.js';

export function cultInventoryData(): typeof cultInventoryJson {
  return overlayCultJson('catalog.json', cultInventoryJson);
}

export function cultCurationData(): typeof cultCurationJson {
  return overlayCultJson('catalog-curation.json', cultCurationJson);
}

export function cultRefinementsData(): typeof cultRefinementsJson {
  return overlayCultJson('catalog-copy-refinements.json', cultRefinementsJson);
}

export function cultSlugData(): typeof cultSlugsJson {
  return overlayCultJson('generated/slugs.json', cultSlugsJson);
}

export function cultThumbnailData(): typeof cultThumbnailsJson {
  return overlayCultJson('generated/thumbnails.json', cultThumbnailsJson);
}
