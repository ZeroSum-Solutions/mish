import { defineConfig } from 'vitest/config';

// Node is the default environment: the catalog, schema and sync tests read the disk. A component
// test opts into the DOM per file with a `// @vitest-environment jsdom` first-line comment
// (jsdom 29.1.1, the version apps/web and packages/components already pin).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
