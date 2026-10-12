// Fork egress pins: this fork must not send data to, or pull content from,
// upstream services unless an operator opts in with an explicit
// URL. See docs/legal/LICENSE-COMPLIANCE.md.

import { describe, expect, it, vi } from 'vitest';

import { mirrorAmrEntryAnalytics } from '../src/integrations/vela.js';

const payload = {
  pageName: 'open_design',
  sourcePageName: 'chat_panel',
  area: 'amr_entry',
  element: 'chat_error_recharge',
  action: 'click_amr_entry',
  entryId: 'od-amr-entry-123',
  sourceProduct: 'open_design',
  sourceDetail: 'chat_error_recharge',
  entryOccurredAt: '2026-06-03T12:00:00.000Z',
} as Parameters<typeof mirrorAmrEntryAnalytics>[0];

const analyticsContext = {
  deviceId: 'od-device-1',
  sessionId: 'od-session-1',
  clientType: 'web',
  locale: 'en',
  requestId: null,
} as const;

describe('AMR analytics mirror in this fork', () => {
  it('sends nothing when OPEN_DESIGN_AMR_ANALYTICS_URL is unset', async () => {
    const fetchImpl = vi.fn();

    const result = await mirrorAmrEntryAnalytics(payload, { analyticsContext, env: {}, fetchImpl });

    expect(result).toEqual({ mirrored: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends to the operator URL when OPEN_DESIGN_AMR_ANALYTICS_URL is set', async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response('{}', { status: 202 }));

    await mirrorAmrEntryAnalytics(payload, {
      analyticsContext,
      env: { OPEN_DESIGN_AMR_ANALYTICS_URL: 'https://analytics.example/events' },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://analytics.example/events');
  });
});
