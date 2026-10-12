// Connects the agency fast lane (a separate package that cannot import the daemon) to the pack
// overlay: public slugs, scrubbed names and prebuilt Cult adapters from an installed Mish pack.

import { setFastLanePackOverlay } from '@mish/agency-fast-lane/pack-overlay';

import { mishPackGeneration, overlayCultJson, packCultAdaptersFile } from './overlay.js';

export function installFastLanePackOverlay(): void {
  setFastLanePackOverlay({
    generation: mishPackGeneration,
    cultSlugs: () => overlayCultJson<unknown>('generated/slugs.json', undefined),
    cultPublicNames: () => overlayCultJson<unknown>('generated/public-names.json', undefined),
    cultAdaptersFile: () => packCultAdaptersFile() ?? undefined,
  });
}
