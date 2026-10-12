import type { ApprovedDesignSystemSeed } from './approved-seed.js';

/** Seven Atlas Digest kits vetted by their freeze and installed-render receipts. */
export const APPROVED_ATLAS_SEED = [
  {
    "id": "user:atlas-odyssee-clinic-tl02",
    "revision": "5ac6294081f657d01e6128f13dd131735fdbb4495340fc3e1ad6d799cb5ec70f"
  },
  {
    "id": "user:atlas-sage-space-tl02",
    "revision": "81c148bb3614c2bcbfbeca14c1a639103b31df1550b750b1abb3177c917e5968"
  },
  {
    "id": "user:atlas-beyond-tl03",
    "revision": "0eab3a41a5921b2d2918f382f1b269663e4937fc6aa45a4978f34f62822d3e97"
  },
  {
    "id": "user:atlas-cocollect-tl03",
    "revision": "ed714c6ba14eec56930cd6fcb661c6418d9b031f8a7b1ff3f726dd4c715377df"
  },
  {
    "id": "user:atlas-hellohello-tl05",
    "revision": "bb14aa0ccbbaea77bff238de414b239d77d3a1a3cdf381f9fe32cbc91ded3eed"
  },
  {
    "id": "user:atlas-ortolan-tl05",
    "revision": "aaf26886c32462c0a2197f9edc40eee14fe3d16db8fda45c05e6656f2671773a"
  },
  {
    "id": "user:atlas-ulysses-de-santi-tl06",
    "revision": "48a72745ff6fcc6f554e84dc6825ca7ed0eb899953d02a46c51bfe7a5c13cbb8"
  }
] as const satisfies readonly ApprovedDesignSystemSeed[];
