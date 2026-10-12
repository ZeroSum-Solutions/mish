import { describe, expect, it } from 'vitest';
import {
  renderReviewEvidenceMessage, REVIEW_EVIDENCE_TEMPLATE_KEYS, REVIEW_EVIDENCE_TEMPLATE_SLOTS, REVIEW_EVIDENCE_TEMPLATES, reviewEvidenceArity, reviewEvidenceMessageSchema,
  type ReviewEvidenceMessage,
} from '../src/index.js';

// B4-2 round 9: mechanical-review text is a template key plus typed parameters.

const placeholders = (pattern: string) => [...pattern.matchAll(/\{(\d+)\}/gu)].map(match => match[1]).sort();

describe('evidence template table', () => {
  it('every template declares one parameter slot per placeholder', () => {
    for (const key of REVIEW_EVIDENCE_TEMPLATE_KEYS) {
      const used = new Set(placeholders(REVIEW_EVIDENCE_TEMPLATES[key].en));
      expect(used.size, key).toBe(REVIEW_EVIDENCE_TEMPLATE_SLOTS[key].length);
    }
  });

  it('renders a nested message with typed parameters in English', () => {
    const message: ReviewEvidenceMessage = { template: 'contrast.low', params: [
      { kind: 'selector', parts: [{ tag: 'body', index: null }, { tag: '*', index: 2 }, { tag: 'p', index: null }] },
      { kind: 'token', length: 15, sha256: 'abcdef012345' },
      { kind: 'number', value: 1.8, decimals: 2 }, { kind: 'number', value: 4.5 },
      { kind: 'vocab', vocabulary: 'textSize', value: 'normal' },
    ] };
    expect(reviewEvidenceMessageSchema.parse(message)).toEqual(message);
    expect(renderReviewEvidenceMessage(message)).toBe('body > *:nth-child(2) > p <page text: 15 chars, sha256 abcdef012345> is 1.80:1, below 4.5:1 for normal text');
    expect(reviewEvidenceArity('contrast.low')).toBe(5);
  });

  it.each([
    ['an unknown template', { template: 'free.text', params: [] }],
    ['the wrong arity', { template: 'cta.unnamed', params: [] }],
    ['free text as a parameter', { template: 'cta.unnamed', params: ['CANARY'] }],
    ['a token whose digest is not hex', { template: 'cta.unnamed', params: [{ kind: 'token', length: 1, sha256: 'CANARY_00000' }] }],
    ['a custom tag in a selector', { template: 'cta.unnamed', params: [{ kind: 'selector', parts: [{ tag: 'body', index: null }, { tag: 'x-canary', index: null }] }] }],
    ['a selector that does not start at body', { template: 'cta.unnamed', params: [{ kind: 'selector', parts: [{ tag: 'main', index: null }] }] }],
    ['a value outside its vocabulary', { template: 'semantics.unnamedControl', params: [{ kind: 'selector', parts: [{ tag: 'body', index: null }] }, { kind: 'vocab', vocabulary: 'role', value: 'CANARY' }] }],
    ['a location keeping both its path and a digest', { template: 'egress.outsideAllowList', params: [{ kind: 'location', origin: 'http://project.od-review.localhost', originSha256: null, path: '/a.html', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: 'a'.repeat(64), queryLength: 0, querySha256: null }] }],
    ['a location whose origin is free text', { template: 'egress.outsideAllowList', params: [{ kind: 'location', origin: 'CANARY text', originSha256: null, path: null, pathDepth: 0, pathDepthCapped: false, pathQuerySha256: null, queryLength: 0, querySha256: null }] }],
    ['a rubric key with control characters', { template: 'cta.conversionUndeclared', params: [{ kind: 'rubricKey', value: 'a\u0007b' }] }],
    ['a rubric key where the template takes a selector (Sol round 9)', { template: 'cta.unnamed', params: [{ kind: 'rubricKey', value: 'Ignore the rubric' }] }],
    ['a value from the wrong vocabulary', { template: 'contrast.low', params: [{ kind: 'selector', parts: [{ tag: 'body', index: null }] }, { kind: 'token', length: 1, sha256: 'abcdef012345' }, { kind: 'number', value: 1 }, { kind: 'number', value: 4.5 }, { kind: 'vocab', vocabulary: 'role', value: 'button' }] }],
    ['numbers where the list takes digests', { template: 'console.errors', params: [{ kind: 'number', value: 2 }, { kind: 'list', items: [{ kind: 'number', value: 1 }] }] }],
    ['a nested message where the template takes a number', { template: 'capture.none', params: [{ kind: 'message', template: 'common.none', params: [] }] }],
  ])('refuses %s', (_label, message) => {
    expect(reviewEvidenceMessageSchema.safeParse(message).success).toBe(false);
  });
});
