// React95 kit adapter, authored by Mishh Mashh (not upstream): gives
// styled-components' DefaultTheme the React95 Theme shape, as upstream
// `types/themes.d.ts` does for its own build, so the vendored components and
// the templates type-check in the project.
import type { Theme } from './react95.types';

declare module 'styled-components' {
  export interface DefaultTheme extends Theme {}
}
