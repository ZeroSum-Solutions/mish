import { describe, expect, it } from 'vitest';

import {
  normalizeMishTelemetryRelayUrl,
  MISH_TELEMETRY_RELAY_URLS,
} from '../../src/integrations/telemetry-relay.js';

describe('Mishh Mashh telemetry relay URLs', () => {
  it('keeps production on telemetry.mish.invalid', () => {
    expect(MISH_TELEMETRY_RELAY_URLS.prod).toBe(
      'https://telemetry.mish.invalid/api/langfuse',
    );
    expect(normalizeMishTelemetryRelayUrl(
      'https://telemetry.mish.invalid/api/langfuse//',
    )).toBe(MISH_TELEMETRY_RELAY_URLS.prod);
  });

  it('moves legacy self-host test URLs to telemetry-test.mish.invalid', () => {
    expect(normalizeMishTelemetryRelayUrl(
      'https://telemetry-selfhost.mish.invalid/api/langfuse/',
    )).toBe(MISH_TELEMETRY_RELAY_URLS.test);
  });

  it('leaves custom relay URLs unchanged', () => {
    expect(normalizeMishTelemetryRelayUrl(
      'https://telemetry.example.test/api/langfuse/',
    )).toBe('https://telemetry.example.test/api/langfuse');
  });
});
