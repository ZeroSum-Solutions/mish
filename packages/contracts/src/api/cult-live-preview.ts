// Live preview: `GET /api/cult/preview/:id` and `GET /api/cult/preview/:id/frame` — one Blocks or
// Components row rendered live in the Catalog tab's preview modal, on this machine only.
//
// - A section or page row (`mode: 'converted'`) serves the converter's static HTML for the item,
//   filled with its own source text, under the same CSP a build ships (no script, inline style).
// - A primitive or app row (`mode: 'harness'`) proxies the local preview harness, which renders
//   the item's own demo from the licensed source kit.
//
// Both routes pass `cultLocalOnlyRefusal` (./cult-local-only.ts) first, because both render
// licensed source. Each frame response carries a CSP `sandbox` directive, so the page has an
// opaque origin however it is opened, not only inside the modal. The info route never returns
// source text: only whether the item previews live, why not, and whether it has a dark theme.
// Every reason passes the brand scrub (`cultDisplayText`) again at this parse boundary, since a
// harness reason can quote vendor code.
//
// A `mode: 'harness'` row that reads a secret env var or imports a key-bound server SDK anywhere
// in its kit directory still previews live — the harness answers every request the mounted demo
// makes with deterministic local data (its own mock fetch router, an AI SDK UI Message Stream
// response with canned text for a chat-shaped request, a generic empty-but-valid JSON body for
// anything else) instead of refusing outright. `mockNote` carries that reason forward as a small
// "demo data" caption the modal shows next to the live render, never a reason panel shown instead
// of one.

import { cultDisplayText } from './cult-brand.js';

export const CULT_PREVIEW_MODES = ['converted', 'harness'] as const;
export type CultPreviewMode = (typeof CULT_PREVIEW_MODES)[number];

export const CULT_PREVIEW_THEMES = ['light', 'dark'] as const;
export type CultPreviewTheme = (typeof CULT_PREVIEW_THEMES)[number];

/** The frame widths the preview modal offers (phone, tablet, desktop), in CSS pixels. */
export const CULT_PREVIEW_WIDTHS = [390, 768, 1280] as const;
export type CultPreviewWidth = (typeof CULT_PREVIEW_WIDTHS)[number];

/** The `source` field of the message a harness frame posts to its parent once it settles. */
export const CULT_PREVIEW_MESSAGE_SOURCE = 'cult-live-preview';

export type CultPreviewInfo =
  | { live: true; mode: CultPreviewMode; supportsDark: boolean; mockNote: string | null }
  | { live: false; mode: CultPreviewMode; reason: string };

export interface CultPreviewInfoResponse {
  preview: CultPreviewInfo;
}

/**
 * A harness frame's message to the modal: it mounted (`ready`), it threw or rendered nothing
 * (`error` with the reason), or Esc was pressed while focus was inside it (`escape`), which the
 * modal cannot see across the frame boundary on its own.
 */
export type CultPreviewFrameMessage =
  | { source: typeof CULT_PREVIEW_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof CULT_PREVIEW_MESSAGE_SOURCE; type: 'error'; reason: string }
  | { source: typeof CULT_PREVIEW_MESSAGE_SOURCE; type: 'escape' }
  | { source: typeof CULT_PREVIEW_MESSAGE_SOURCE; type: 'size'; width: number; height: number };

export function cultPreviewInfoUrl(id: string): string {
  return `/api/cult/preview/${encodeURIComponent(id)}`;
}

export function cultPreviewFrameUrl(id: string, theme: CultPreviewTheme = 'light'): string {
  return `/api/cult/preview/${encodeURIComponent(id)}/frame?theme=${theme}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an untrusted info response; throws with the first problem. */
export function parseCultPreviewInfoResponse(value: unknown): CultPreviewInfoResponse {
  if (!isRecord(value) || !isRecord(value.preview)) throw new Error('cult preview: missing preview');
  const preview = value.preview;
  const mode = preview.mode;
  if (typeof mode !== 'string' || !(CULT_PREVIEW_MODES as readonly string[]).includes(mode)) {
    throw new Error('cult preview: unknown mode');
  }
  if (preview.live === true) {
    if (typeof preview.supportsDark !== 'boolean') throw new Error('cult preview: supportsDark must be a boolean');
    const mockNote = preview.mockNote;
    if (mockNote !== null && typeof mockNote !== 'string') throw new Error('cult preview: mockNote must be a string or null');
    return {
      preview: {
        live: true, mode: mode as CultPreviewMode, supportsDark: preview.supportsDark,
        mockNote: mockNote === null || mockNote === undefined ? null : cultDisplayText(mockNote).slice(0, 300),
      },
    };
  }
  if (preview.live === false) {
    if (typeof preview.reason !== 'string' || preview.reason.length === 0) throw new Error('cult preview: a refusal needs a reason');
    return { preview: { live: false, mode: mode as CultPreviewMode, reason: cultDisplayText(preview.reason).slice(0, 300) } };
  }
  throw new Error('cult preview: live must be a boolean');
}

/** Reads a frame's settle message; null for anything else (other frames, extensions, noise). */
export function parseCultPreviewFrameMessage(value: unknown): CultPreviewFrameMessage | null {
  if (!isRecord(value) || value.source !== CULT_PREVIEW_MESSAGE_SOURCE) return null;
  if (value.type === 'ready') return { source: CULT_PREVIEW_MESSAGE_SOURCE, type: 'ready' };
  if (value.type === 'escape') return { source: CULT_PREVIEW_MESSAGE_SOURCE, type: 'escape' };
  if (value.type === 'size') {
    const bounded = (number: unknown): number is number => typeof number === 'number' && Number.isInteger(number) && number > 0 && number <= 4096;
    return bounded(value.width) && bounded(value.height)
      ? { source: CULT_PREVIEW_MESSAGE_SOURCE, type: 'size', width: value.width, height: value.height }
      : null;
  }
  if (value.type === 'error') {
    const reason = typeof value.reason === 'string' && value.reason.length > 0 ? cultDisplayText(value.reason).slice(0, 300) : 'it failed to render';
    return { source: CULT_PREVIEW_MESSAGE_SOURCE, type: 'error', reason };
  }
  return null;
}
