import { createHash } from 'node:crypto';
import type { CatalogueHelper } from './catalogue-material.js';
import { SHADCN_MIT_NOTICE } from './shadcn-material.js';

/**
 * shadcn's MIT `utils` helper, byte-pinned: the `lib/utils.ts` file of
 * https://ui.shadcn.com/r/styles/new-york-v4/utils.json, retrieved 2026-10-09T01:48:37Z
 * (registry document sha256 c22651d566e943525910eb81a31a84eed9ad8ae24c6cdfa3ec609cc0fb04b0d5).
 * It re-exports `cn` from shadcn's MIT `cn` npm package, which the dependency report
 * then requires. Registry items that import `cn` from `@/lib/utils` without shipping it
 * get this copy only when the project has no such module.
 */
const SHADCN_UTILS_SOURCE = 'export { cn } from "cn"\n';
export const SHADCN_UTILS_SHA256 = '14300d758170c270c75b057f38fedb3793a5920ea872f0477e29fb131185e8a7';
if (createHash('sha256').update(SHADCN_UTILS_SOURCE).digest('hex') !== SHADCN_UTILS_SHA256) throw new Error('Pinned shadcn utils helper bytes changed');

export const SHADCN_UTILS_HELPER: Readonly<CatalogueHelper> = Object.freeze({
  path: 'lib/utils.ts',
  // Same directory only: the executor observes paths whose parent directory exists.
  alternatePaths: ['lib/utils.tsx', 'lib/utils.js', 'lib/utils.jsx', 'lib/utils.mjs'],
  exportName: 'cn',
  bytes: Buffer.from(SHADCN_UTILS_SOURCE, 'utf8'),
  packageDependencies: [{ name: 'cn', range: '*' }],
  notice: `shadcn/ui \`utils\` helper (https://ui.shadcn.com/r/styles/new-york-v4/utils.json), sha256 ${SHADCN_UTILS_SHA256}.\n\n${SHADCN_MIT_NOTICE}`,
});
