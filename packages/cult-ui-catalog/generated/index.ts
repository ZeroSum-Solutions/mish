// Public stub. The Cult UI Pro adapters are licensed content and ship in a private pack, not in
// this repository. With no pack installed the registry is empty and Cult sections are unavailable.

import type { SectionAdapter } from './section-adapter.ts';

export type CultAdapterLoader = () => Promise<SectionAdapter>;

export const CULT_ADAPTERS: Readonly<Record<string, CultAdapterLoader>> = Object.freeze({});

export const CULT_ADAPTER_IDS: readonly string[] = Object.freeze(Object.keys(CULT_ADAPTERS));
