import { describe, expect, it, vi } from 'vitest';
import type { ModelCall } from '@open-design/agency-fast-lane/deepseek';
import { createProviderBriefGenerator } from '../../src/workbench/brief/generator-provider.js';

describe('metered provider brief generator (no live calls)', () => {
  it('sends the transform prompt plus the schema and the field shape, and returns the raw answer', async () => {
    const call = vi.fn<ModelCall>(async () => ({ text: '{"ok":true}', ms: 1, retries: 0 }));
    const generator = createProviderBriefGenerator({ provider: 'cerebras', model: 'gpt-oss-120b', call });
    const result = await generator.generate({ system: 'SYSTEM', user: 'USER' }, new AbortController().signal);
    expect(result).toEqual({ text: '{"ok":true}', reportedModel: null });
    const request = call.mock.calls[0]![0];
    expect(request.user).toBe('USER');
    expect(request.system).toMatch(/^SYSTEM\n/);
    expect(request.system).toMatch(/never a bare string/);
    expect(request.system).toContain('"referenceChanges"');
    expect(generator.billingLane).toBe('metered-cerebras');
  });
});
