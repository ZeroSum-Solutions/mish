import { agencyBuild } from './agency-build.ts';
import { buildOnBrand } from './build-on-brand.ts';
import { chatRun } from './chat-run.ts';
import type { Builder } from './types.ts';

export const BUILDER_IDS = ['build-on-brand', 'chat-run', 'agency-build'] as const;
export type BuilderId = (typeof BUILDER_IDS)[number];
export function builderFor(id: string): Builder {
  if (id === 'build-on-brand') return buildOnBrand();
  if (id === 'chat-run') return chatRun();
  if (id === 'agency-build') return agencyBuild();
  throw new Error(`Unknown builder: ${id}; choose ${BUILDER_IDS.join(', ')}`);
}
export type { Builder, BuildInput } from './types.ts';
