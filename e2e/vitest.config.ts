import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const configuredMaxWorkers = Number.parseInt(process.env.OD_E2E_VITEST_MAX_WORKERS ?? '4', 10);
const maxWorkers = Number.isFinite(configuredMaxWorkers) && configuredMaxWorkers > 0
  ? configuredMaxWorkers
  : 4;

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./lib', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    fileParallelism: true,
    // Fails the run when a tools-dev namespace from this run still has live
    // processes after every suite finished (lib/vitest/global-setup.ts).
    globalSetup: ['lib/vitest/global-setup.ts'],
    include: ['specs/**/*.spec.ts', 'tests/**/*.test.ts'],
    maxWorkers,
    pool: 'forks',
  },
});
