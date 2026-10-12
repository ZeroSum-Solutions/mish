import { afterEach, beforeEach } from 'vitest';
import { setRuntimeAmrConsoleOrigin } from '../../src/runtime/amr-guidance';

/**
 * Stand-in AMR console origin. The fork ships no AMR console host, so every
 * account / recharge / upgrade link is unavailable until one is configured;
 * tests that exercise those links configure this origin first.
 */
export const TEST_AMR_CONSOLE_ORIGIN = 'https://amr-console.example.invalid';

/** Configure {@link TEST_AMR_CONSOLE_ORIGIN} for every test in the calling scope. */
export function useConfiguredAmrConsole(origin: string = TEST_AMR_CONSOLE_ORIGIN): void {
  beforeEach(() => {
    setRuntimeAmrConsoleOrigin(origin);
  });
  afterEach(() => {
    setRuntimeAmrConsoleOrigin(null);
  });
}
