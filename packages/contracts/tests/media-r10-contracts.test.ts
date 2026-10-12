import { describe, expect, it } from 'vitest';

import {
  MEDIA_GALLERY_DEFAULT_LIMIT,
  MEDIA_GALLERY_MAX_LIMIT,
  MEDIA_TASK_CANCELLED_CODE,
  isValidMediaIdempotencyKey,
  mediaFailureNextStep,
  mediaTaskInterruptReason,
  parseMediaGalleryQuery,
} from '../src/api/media';
import { API_ERROR_CODES } from '../src/errors';

describe('AC-R10.1 media cancel/retry contract', () => {
  it('derives the interrupt reason from status and code, and only for interrupted tasks', () => {
    expect(mediaTaskInterruptReason('interrupted', MEDIA_TASK_CANCELLED_CODE)).toBe('user-cancelled');
    expect(mediaTaskInterruptReason('interrupted', 'DAEMON_RESTART')).toBe('daemon-restart');
    expect(mediaTaskInterruptReason('interrupted', 'SOMETHING_ELSE')).toBeUndefined();
    expect(mediaTaskInterruptReason('failed', MEDIA_TASK_CANCELLED_CODE)).toBeUndefined();
  });

  it('classifies a cancelled task as nothing to fix rather than contact-support', () => {
    expect(mediaFailureNextStep({ code: MEDIA_TASK_CANCELLED_CODE })).toBe('retry-later');
  });

  it('accepts only bounded visible-ASCII idempotency keys', () => {
    expect(isValidMediaIdempotencyKey('retry-1')).toBe(true);
    expect(isValidMediaIdempotencyKey('')).toBe(false);
    expect(isValidMediaIdempotencyKey('has space')).toBe(false);
    expect(isValidMediaIdempotencyKey('x'.repeat(129))).toBe(false);
    expect(isValidMediaIdempotencyKey(42)).toBe(false);
  });

  it('registers every new refusal code as an API error code', () => {
    for (const code of [
      'MEDIA_TASK_NOT_FOUND',
      'MEDIA_TASK_NOT_CANCELLABLE',
      'MEDIA_TASK_NOT_RETRYABLE',
      'MEDIA_RETRY_SAFETY_REJECTED',
      'MEDIA_RETRY_REQUEST_UNAVAILABLE',
      'MEDIA_GALLERY_ENTRY_NOT_FOUND',
      'MEDIA_GALLERY_OUTPUT_UNAVAILABLE',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_CONFLICT',
    ]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });
});

describe('AC-R10.2 media gallery query contract', () => {
  it('defaults the page and parses every filter', () => {
    expect(parseMediaGalleryQuery({})).toEqual({
      ok: true,
      query: { limit: MEDIA_GALLERY_DEFAULT_LIMIT, includeUnlinked: false },
    });
    const parsed = parseMediaGalleryQuery({
      kind: 'video',
      status: 'done,failed,done',
      provider: 'custom-image',
      from: '1000',
      to: '2024-01-01T00:00:00Z',
      limit: '7',
      cursor: 'abc_DEF-1',
      includeUnlinked: 'true',
    });
    expect(parsed).toEqual({
      ok: true,
      query: {
        kind: 'video',
        status: ['done', 'failed'],
        provider: 'custom-image',
        from: 1000,
        to: Date.parse('2024-01-01T00:00:00Z'),
        limit: 7,
        cursor: 'abc_DEF-1',
        includeUnlinked: true,
      },
    });
  });

  it('clamps the page size and refuses values that would silently widen the listing', () => {
    const clamped = parseMediaGalleryQuery({ limit: '9999' });
    expect(clamped.ok && clamped.query.limit).toBe(MEDIA_GALLERY_MAX_LIMIT);
    for (const [raw, field] of [
      [{ kind: 'hologram' }, 'kind'],
      [{ status: 'cancelled' }, 'status'],
      [{ provider: '../etc' }, 'provider'],
      [{ from: 'soon' }, 'from'],
      [{ from: '2000', to: '1000' }, 'to'],
      [{ limit: '0' }, 'limit'],
      [{ cursor: 'a/b' }, 'cursor'],
    ] as const) {
      expect(parseMediaGalleryQuery(raw)).toMatchObject({ ok: false, field });
    }
  });
});
