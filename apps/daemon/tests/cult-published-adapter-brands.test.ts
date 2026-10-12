import { describe, expect, it } from 'vitest';

const REGISTRY = '@mish/cult-ui-catalog/generated';
const { CULT_ADAPTERS } = await import(REGISTRY) as { CULT_ADAPTERS: Record<string, unknown> };

describe('public adapter registry', () => {
  it('publishes no licensed adapters in the public stub', () => {
    expect(CULT_ADAPTERS).toEqual({});
  });
});
