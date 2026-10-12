/**
 * R17 React95 kit pins. The kit's source is the exact requested fork
 * (`react95-io/React95@871d5335…`, vendored in `kit.generated.ts`); the
 * packages below are what its G02 receipt builds, type-checks and renders
 * with, resolved from the daemon's own lockfile. A project receives the
 * template, the vendored source and notices; it declares and installs these
 * packages itself (the daemon checks, never installs).
 */
export const REACT95_SOURCE = Object.freeze({
  repository: 'https://github.com/react95-io/React95',
  commit: '871d5335daebdda1469f66f81266523f4191a595',
});
export const REACT95_TOOLCHAIN = Object.freeze({
  esbuild: '0.28.0', typescript: '5.9.3',
  react: '18.3.1', 'react-dom': '18.3.1', 'react-is': '18.3.1', 'styled-components': '5.3.11',
  '@types/react': '18.3.28', '@types/react-dom': '18.3.7', '@types/styled-components': '5.1.36',
});
/** Declared to the target project (checked against its manifest, never installed). */
export const REACT95_PROJECT_DEPENDENCIES = Object.freeze([
  { name: 'styled-components', range: '^5.3.11' },
  { name: '@types/styled-components', range: '^5.1.36' },
]);
