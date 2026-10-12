/**
 * A seam for private content a host process installs at run time (Mish packs). The fast lane ships
 * with the public catalogue data only; a host that has an installed pack registers these readers
 * and the fast lane asks them before it falls back to its bundled data. With no overlay set, every
 * call behaves exactly as before.
 *
 * Readers are called on demand and may return `undefined` ("this pack provides nothing"). The
 * `generation` number changes whenever the set of installed packs changes, so the fast lane can
 * drop what it derived from the old set.
 */

export interface FastLanePackOverlay {
  generation(): number;
  /** `generated/slugs.json` of a pack's Cult catalogue. */
  cultSlugs?(): unknown;
  /** `generated/public-names.json` of a pack's Cult catalogue. */
  cultPublicNames?(): unknown;
  /** Absolute path of a prebuilt ES module that exports `CULT_ADAPTERS`. */
  cultAdaptersFile?(): string | undefined;
}

let overlay: FastLanePackOverlay | undefined;

export function setFastLanePackOverlay(next: FastLanePackOverlay | undefined): void {
  overlay = next;
}

export function fastLanePackOverlay(): FastLanePackOverlay | undefined {
  return overlay;
}

/** The overlay generation, or 0 when no overlay is set. */
export function fastLanePackGeneration(): number {
  return overlay?.generation() ?? 0;
}
