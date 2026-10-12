import { describe, expect, it } from 'vitest';

import {
  cultPreviewFrameUrl,
  cultPreviewInfoUrl,
  parseCultPreviewFrameMessage,
  parseCultPreviewInfoResponse,
} from '../src/api/cult-live-preview.js';

describe('cult live preview contract', () => {
  it('builds the same-origin info and frame URLs from an id', () => {
    expect(cultPreviewInfoUrl('cult:hero-glow')).toBe('/api/cult/preview/cult%3Ahero-glow');
    expect(cultPreviewFrameUrl('cult:hero-glow')).toBe('/api/cult/preview/cult%3Ahero-glow/frame?theme=light');
    expect(cultPreviewFrameUrl('cult:a/b', 'dark')).toBe('/api/cult/preview/cult%3Aa%2Fb/frame?theme=dark');
  });

  it('accepts a live or refused info response and rejects anything else', () => {
    expect(parseCultPreviewInfoResponse({ preview: { live: true, mode: 'converted', supportsDark: true, mockNote: null, extra: 1 } }))
      .toEqual({ preview: { live: true, mode: 'converted', supportsDark: true, mockNote: null } });
    // A row the harness rendered live with deterministic mocks (needed server keys) carries that
    // reason forward as mockNote, never a refusal.
    expect(parseCultPreviewInfoResponse({ preview: { live: true, mode: 'harness', supportsDark: false, mockNote: 'it needs server keys (1 key-bound server SDK) and a running API' } }))
      .toEqual({ preview: { live: true, mode: 'harness', supportsDark: false, mockNote: 'it needs server keys (1 key-bound server SDK) and a running API' } });
    expect(parseCultPreviewInfoResponse({ preview: { live: false, mode: 'harness', reason: 'no keys' } }))
      .toEqual({ preview: { live: false, mode: 'harness', reason: 'no keys' } });
    for (const bad of [null, {}, { preview: { live: true, mode: 'other', supportsDark: true, mockNote: null } }, { preview: { live: true, mode: 'harness' } },
      { preview: { live: true, mode: 'harness', supportsDark: true, mockNote: 5 } },
      { preview: { live: false, mode: 'harness', reason: '' } }, { preview: { live: 'yes', mode: 'harness' } }]) {
      expect(() => parseCultPreviewInfoResponse(bad)).toThrow();
    }
  });

  it('scrubs vendor names out of every reason it parses', () => {
    const info = parseCultPreviewInfoResponse({ preview: { live: false, mode: 'harness', reason: 'threw inside the Vercel AI SDK' } });
    expect(JSON.stringify(info)).not.toMatch(/vercel/i);
    expect(JSON.stringify(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'error', reason: 'Stripe checkout threw' }))).not.toMatch(/stripe/i);
  });

  it('reads only its own frame messages', () => {
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'ready' })).toEqual({ source: 'cult-live-preview', type: 'ready' });
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'error', reason: 'threw: x' }))
      .toEqual({ source: 'cult-live-preview', type: 'error', reason: 'threw: x' });
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'error' })).toMatchObject({ reason: 'it failed to render' });
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'escape' })).toEqual({ source: 'cult-live-preview', type: 'escape' });
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'navigate' })).toBeNull();
    expect(parseCultPreviewFrameMessage({ source: 'other', type: 'ready' })).toBeNull();
    expect(parseCultPreviewFrameMessage('ready')).toBeNull();
  });

  it('accepts only bounded finite content dimensions from a cult frame', () => {
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'size', width: 390, height: 320 }))
      .toEqual({ source: 'cult-live-preview', type: 'size', width: 390, height: 320 });
    for (const height of [0, -1, 4097, Infinity, NaN, '320', 1.5]) {
      expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'size', width: 390, height })).toBeNull();
    }
    expect(parseCultPreviewFrameMessage({ source: 'cult-live-preview', type: 'size', width: Infinity, height: 320 })).toBeNull();
  });
});
