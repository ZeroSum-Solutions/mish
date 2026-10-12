import { describe, expect, it } from 'vitest';
import { budgetSerializedReplay } from '../../src/workbench/replay-budget.js';

const marker = '\n\n[Mishh Mashh truncated replay; full history remains stored.]\n\n';
const markerBytes = Buffer.byteLength(marker, 'utf8');

describe('serialized workbench replay budget', () => {
  it('keeps exactly 16000 bytes and bounds a 16001-byte replay with head, tail and marker', () => {
    const boundary = 'x'.repeat(16000);
    expect(budgetSerializedReplay(boundary)).toMatchObject({
      replay: boundary, bytes: 16000, byteLimit: 16000, truncated: false,
    });
    const overflow = `HEAD${'x'.repeat(15993)}TAIL`;
    const result = budgetSerializedReplay(overflow);
    expect(result.originalBytes).toBe(16001);
    expect(result.bytes).toBeLessThanOrEqual(16000);
    expect(result.replay).toContain('truncated replay');
    expect(result.replay?.startsWith('HEAD')).toBe(true);
    expect(result.replay?.endsWith('TAIL')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(overflow).toHaveLength(16001);
  });

  it('counts caller framing and the marker inside the final serialized byte limit', () => {
    const framed = '## user\n' + 'x'.repeat(15993);
    const result = budgetSerializedReplay(framed);
    expect(result.originalBytes).toBe(16001);
    expect(result.bytes).toBe(16000);
    expect(result.replay).toContain(marker);
    expect(Buffer.byteLength(result.replay!, 'utf8')).toBe(16000);
    expect(result.omittedBytes).toBe(markerBytes + 1);
  });

  it('preserves deterministic head and tail without rebuilding or normalizing caller text', () => {
    const input = 'ABCDE123456789UVWXY';
    const budget = Object.freeze({ byteLimit: markerBytes + 10 });
    const result = budgetSerializedReplay(input.repeat(10), budget);
    expect(result.replay).toBe(`ABCDE${marker}UVWXY`);
    expect(result.bytes).toBe(markerBytes + 10);
    expect(result.omittedBytes).toBe(180);
    expect(budgetSerializedReplay(input.repeat(10), budget)).toEqual(result);
    expect(input).toBe('ABCDE123456789UVWXY');
  });

  it('truncates CJK and emoji at code point boundaries and counts UTF8 rather than JS length', () => {
    const result = budgetSerializedReplay('汉😀'.repeat(40), { byteLimit: markerBytes + 14 });
    expect(result.replay).toBe(`汉😀${marker}汉😀`);
    expect(result.bytes).toBe(markerBytes + 14);
    expect(result.originalBytes).toBe(280);
    expect(Buffer.from(result.replay!, 'utf8').toString('utf8')).toBe(result.replay);
    expect(result.omittedBytes).toBe(266);
  });

  it('preserves combining code points without normalizing decomposed text', () => {
    const result = budgetSerializedReplay('e\u0301'.repeat(50), { byteLimit: markerBytes + 6 });
    expect(result.replay).toBe(`e\u0301${marker}e\u0301`);
    expect(result.bytes).toBe(markerBytes + 6);
    expect(result.originalBytes).toBe(150);
    expect(result.replay).not.toContain('é');
  });

  it('enforces a smaller declared 500 estimated-token allowance as 1500 bytes', () => {
    const result = budgetSerializedReplay('x'.repeat(16000), { estimatedTokenAllowance: 500 });
    expect(result).toMatchObject({
      byteLimit: 1500, bytes: 1500, estimatedReplayTokens: 500,
      estimatedTokenAllowance: 500, estimatedAllowanceStatus: 'declared',
      budgetConfidence: 'byte-and-estimate-bound', remainingBudgetConfidence: 'unverified',
      tokenEstimateMethod: 'utf8_bytes_div_3_ceil_v1', actualReplayTokens: null,
    });
  });

  it('compares estimated tokens in matching units and obeys the smaller explicit byte allowance', () => {
    const result = budgetSerializedReplay('x'.repeat(2000), { byteLimit: 1000, estimatedTokenAllowance: 500 });
    expect(result).toMatchObject({ byteLimit: 1000, bytes: 1000, estimatedReplayTokens: 334 });
    expect(budgetSerializedReplay('x'.repeat(16001), {
      byteLimit: 20000, estimatedTokenAllowance: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ byteLimit: 16000, bytes: 16000, estimatedReplayTokens: 5334 });
  });

  it.each([undefined, null])('keeps an unknown allowance %s unknown and applies the byte cap', allowance => {
    const budget = allowance === undefined ? {} : { estimatedTokenAllowance: allowance, byteLimit: null };
    expect(budgetSerializedReplay('x'.repeat(16001), budget)).toMatchObject({
      byteLimit: 16000, bytes: 16000, estimatedTokenAllowance: null,
      estimatedAllowanceStatus: 'unknown', budgetConfidence: 'byte-bound-only',
      remainingBudgetConfidence: 'unverified', actualReplayTokens: null,
    });
  });

  it.each([{ byteLimit: 0 }, { estimatedTokenAllowance: 0 }])('omits nonempty replay explicitly at zero budget %j', budget => {
    expect(budgetSerializedReplay('history', budget)).toMatchObject({
      status: 'omitted', reason: 'zero-budget', replay: null, bytes: 0,
      byteLimit: 0, originalBytes: 7, omittedBytes: 7, omitted: true,
      truncated: false, estimatedReplayTokens: null,
    });
  });

  it('returns empty replay explicitly at a valid zero allowance', () => {
    expect(budgetSerializedReplay('', { estimatedTokenAllowance: 0 })).toMatchObject({
      status: 'empty', replay: '', bytes: 0, byteLimit: 0, originalBytes: 0,
      omitted: false, omittedBytes: 0, truncated: false, estimatedReplayTokens: 0,
    });
  });

  it('retains a short replay even when the limit could not fit an unnecessary marker', () => {
    expect(budgetSerializedReplay('汉', { byteLimit: 3 })).toMatchObject({
      status: 'unchanged', replay: '汉', bytes: 3, truncated: false, omitted: false,
    });
  });

  it('omits oversized replay when the required marker cannot fit, rather than returning partial marker text', () => {
    expect(budgetSerializedReplay('x'.repeat(200), { byteLimit: markerBytes - 1 })).toMatchObject({
      status: 'omitted', reason: 'marker-does-not-fit', replay: null, bytes: 0,
      byteLimit: markerBytes - 1, omittedBytes: 200, omitted: true, truncated: false,
    });
    expect(budgetSerializedReplay('x'.repeat(200), { byteLimit: markerBytes })).toMatchObject({
      status: 'truncated', replay: marker, bytes: markerBytes,
      omittedBytes: 200, omitted: false, truncated: true,
    });
  });

  it('leaves spare bytes instead of cutting a multibyte code point', () => {
    const result = budgetSerializedReplay('😀'.repeat(100), { byteLimit: markerBytes + 6 });
    expect(result.replay).toBe(marker);
    expect(result.bytes).toBe(markerBytes);
    expect(result.omittedBytes).toBe(400);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid byte allowance %s', byteLimit => {
    expect(budgetSerializedReplay('retain original', { byteLimit })).toMatchObject({
      status: 'invalid-budget', reason: 'invalid-byte-limit', replay: null,
      originalBytes: 15, bytes: 0, omitted: true, omittedBytes: 15,
      budgetConfidence: 'invalid', actualReplayTokens: null,
    });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid estimated allowance %s', estimatedTokenAllowance => {
    expect(budgetSerializedReplay('retain original', { estimatedTokenAllowance })).toMatchObject({
      status: 'invalid-budget', reason: 'invalid-estimated-token-allowance', replay: null,
      estimatedAllowanceStatus: 'invalid', estimatedTokenAllowance: null,
      budgetConfidence: 'invalid', remainingBudgetConfidence: 'unverified',
    });
  });
});
