import { describe, expect, it } from 'vitest';
import {
  captureDraftListSchema, captureDraftRevisionSchema, createCaptureDraftRequestSchema,
  parseCaptureDraftRevision, WORKBENCH_CAPTURE_DRAFT_LIMITS,
} from '../src/index.js';

const pending = {
  schema: 'capture-draft/1', draftId: `draft_${'a'.repeat(20)}`, projectId: 'p', captureId: `cap_${'b'.repeat(20)}`,
  revision: 1, parentRevision: null, createdAt: '2026-10-09T12:00:00.000Z', status: 'pending',
  prompt: 'Recreate the visible layout.', html: null, outputSha256: null, assumptions: [], failure: null,
  generator: { provider: 'claude-max', modelId: 'claude-sonnet-5-5', billingLane: 'max-subscription' },
} as const;
const ready = { ...pending, status: 'ready', html: '<!doctype html><html><body>Draft</body></html>', outputSha256: 'a'.repeat(64) };

describe('capture draft contracts (AC-R14.2)', () => {
  it('accepts persisted pending, ready and failed revisions with lineage', () => {
    expect(parseCaptureDraftRevision(pending)).toEqual(pending);
    expect(captureDraftRevisionSchema.safeParse(ready).success).toBe(true);
    expect(captureDraftRevisionSchema.safeParse({ ...pending, revision: 2, parentRevision: 1, status: 'failed', failure: { reason: 'generation-failed', message: 'Generation stopped.', recovery: 'Retry this revision.' } }).success).toBe(true);
  });

  it('rejects mixed terminal states, malformed identities and authority fields', () => {
    for (const value of [
      { ...pending, html: '<html></html>' }, { ...pending, outputSha256: 'a'.repeat(64) },
      { ...pending, failure: { reason: 'failed', message: 'failed', recovery: 'Retry' } },
      { ...ready, html: ' ' }, { ...ready, outputSha256: null }, { ...pending, status: 'failed' },
      { ...pending, draftId: '../draft' }, { ...pending, captureId: 'cap_invalid' },
      { ...pending, revision: 0 }, { ...pending, parentRevision: 0 }, { ...pending, createdAt: 'yesterday' },
      { ...pending, generator: { ...pending.generator, billingLane: 'api' } },
      { ...pending, generator: { ...pending.generator, apiKey: 'not-accepted' } },
      { ...pending, rightsStatus: 'redistributable' },
    ]) expect(captureDraftRevisionSchema.safeParse(value).success).toBe(false);
  });

  it('bounds UTF-8 HTML bytes, assumptions, prompts and list size', () => {
    expect(captureDraftRevisionSchema.safeParse({ ...ready, html: 'x'.repeat(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxHtmlBytes) }).success).toBe(true);
    expect(captureDraftRevisionSchema.safeParse({ ...ready, html: 'é'.repeat(WORKBENCH_CAPTURE_DRAFT_LIMITS.maxHtmlBytes / 2 + 1) }).success).toBe(false);
    expect(captureDraftRevisionSchema.safeParse({ ...ready, assumptions: Array(33).fill('Missing detail') }).success).toBe(false);
    expect(captureDraftRevisionSchema.safeParse({ ...ready, assumptions: ['x'.repeat(2001)] }).success).toBe(false);
    expect(captureDraftRevisionSchema.safeParse({ ...pending, prompt: 'x'.repeat(12001) }).success).toBe(false);
    expect(captureDraftListSchema.safeParse({ drafts: Array(501).fill(pending) }).success).toBe(false);
  });

  it('takes only user intent and an optional exact parent revision', () => {
    const request = { projectId: 'p', captureId: pending.captureId, prompt: 'Use a compact header.' };
    expect(createCaptureDraftRequestSchema.safeParse(request).success).toBe(true);
    expect(createCaptureDraftRequestSchema.safeParse({ ...request, parent: { draftId: pending.draftId, revision: 1 } }).success).toBe(true);
    for (const extra of [{ html: '<html></html>' }, { generator: pending.generator }, { draftId: pending.draftId }, { revision: 2 }]) {
      expect(createCaptureDraftRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(createCaptureDraftRequestSchema.safeParse({ ...request, prompt: '   ' }).success).toBe(false);
    expect(createCaptureDraftRequestSchema.safeParse({ ...request, parent: { draftId: pending.draftId, revision: 0 } }).success).toBe(false);
    expect(createCaptureDraftRequestSchema.safeParse({ ...request, parent: { draftId: pending.draftId, revision: 1, html: 'authority' } }).success).toBe(false);
  });
});
