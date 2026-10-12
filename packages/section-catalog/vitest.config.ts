import { defineConfig } from 'vitest/config';

// Everything here is Node-only: catalog/schema validation and disk-backed build checks. There is
// no browser or DOM surface in this package (that lives in apps/web once phase D wires a picker).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
