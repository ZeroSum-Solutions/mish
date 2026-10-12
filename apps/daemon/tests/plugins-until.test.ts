// `until` evaluator (spec §10.1 / §10.2). Closed vocabulary, intentionally
// not arbitrary JS — the parser refuses signals it does not know about and
// only accepts == != >= <= > < operators. The evaluator is short-circuit
// per OR clause and returns the first matching conjunction so the run
// audit can record "what convinced me to advance".

import { describe, expect, it } from 'vitest';
import {
  evaluateUntil,
  isParseableUntil,
  parseUntil,
  UntilSyntaxError,
} from '../src/plugins/until.js';

describe('parseUntil', () => {
  it('accepts the §10.1 reference expression', () => {
    const expr = parseUntil('critique.score>=4 || iterations>=3');
    expect(expr.any).toHaveLength(2);
    expect(expr.any[0]?.[0]).toMatchObject({ signal: 'critique.score', op: '>=', value: 4 });
    expect(expr.any[1]?.[0]).toMatchObject({ signal: 'iterations', op: '>=', value: 3 });
  });

  it('accepts boolean signals with == / !=', () => {
    const expr = parseUntil('user.confirmed == true');
    expect(expr.any[0]?.[0]).toMatchObject({ signal: 'user.confirmed', op: '==', value: true });
  });

  it('rejects unknown signals', () => {
    expect(() => parseUntil('lol.idk >= 1')).toThrow(UntilSyntaxError);
  });

  it('rejects boolean signal with > operator', () => {
    expect(() => parseUntil('preview.ok > true')).toThrow(UntilSyntaxError);
  });

  it('rejects empty expressions', () => {
    expect(() => parseUntil('')).toThrow(UntilSyntaxError);
  });

  it('isParseableUntil returns false for syntactically broken input', () => {
    expect(isParseableUntil('critique.score nope 4')).toBe(false);
    expect(isParseableUntil('critique.score >= 4')).toBe(true);
  });
});

describe('evaluateUntil', () => {
  it('converges on the canonical critique-or-iterations termination', () => {
    const expr = parseUntil('critique.score>=4 || iterations>=3');
    expect(evaluateUntil(expr, { 'critique.score': 4, iterations: 1 })).toMatchObject({ satisfied: true });
    expect(evaluateUntil(expr, { 'critique.score': 2, iterations: 3 })).toMatchObject({ satisfied: true });
    expect(evaluateUntil(expr, { 'critique.score': 2, iterations: 1 })).toMatchObject({ satisfied: false });
  });

  it('boolean signals respect == / !=', () => {
    const expr = parseUntil('user.confirmed == true');
    expect(evaluateUntil(expr, { 'user.confirmed': true }).satisfied).toBe(true);
    expect(evaluateUntil(expr, { 'user.confirmed': false }).satisfied).toBe(false);
  });

  it('missing signal value never satisfies a comparison', () => {
    const expr = parseUntil('iterations>=3');
    expect(evaluateUntil(expr, {}).satisfied).toBe(false);
  });

  it('returns the matching conjunction terms for audit', () => {
    const expr = parseUntil('critique.score>=4 || iterations>=3');
    const result = evaluateUntil(expr, { 'critique.score': 4, iterations: 0 });
    expect(result.satisfied).toBe(true);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.signal).toBe('critique.score');
  });
});

describe('documented boolean shorthand and grouping', () => {
  it('treats a bare boolean signal as `== true`', () => {
    const expr = parseUntil('build.passing && tests.passing');
    expect(expr.any).toEqual([[
      { signal: 'build.passing', op: '==', value: true },
      { signal: 'tests.passing', op: '==', value: true },
    ]]);
    expect(() => parseUntil('iterations')).toThrow(UntilSyntaxError);
  });

  it('parses a parenthesized conjunction inside a disjunction', () => {
    const expr = parseUntil('(build.passing && tests.passing) || iterations>=8');
    expect(evaluateUntil(expr, { 'build.passing': true, 'tests.passing': false, iterations: 2 }).satisfied).toBe(false);
    expect(evaluateUntil(expr, { 'build.passing': true, 'tests.passing': true, iterations: 2 }).satisfied).toBe(true);
    expect(evaluateUntil(expr, { 'build.passing': false, iterations: 8 }).satisfied).toBe(true);
  });

  it('distributes a parenthesized disjunction over a conjunction', () => {
    const expr = parseUntil('preview.ok && (critique.score >= 4 || iterations >= 3)');
    expect(expr.any).toHaveLength(2);
    expect(evaluateUntil(expr, { 'preview.ok': true, iterations: 3 }).satisfied).toBe(true);
    expect(evaluateUntil(expr, { 'preview.ok': false, iterations: 3 }).satisfied).toBe(false);
  });

  it('parses every `until` expression shipped in a bundled plugin manifest', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/_official');
    const manifests: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === 'mish.json') manifests.push(full);
      }
    };
    await walk(root);
    const expressions: Array<{ file: string; until: string }> = [];
    const collect = (file: string, value: unknown) => {
      if (Array.isArray(value)) value.forEach((item) => collect(file, item));
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'until' && typeof inner === 'string') expressions.push({ file, until: inner });
          else collect(file, inner);
        }
      }
    };
    for (const file of manifests) collect(file, JSON.parse(await readFile(file, 'utf8')));
    expect(expressions.length).toBeGreaterThan(0);
    for (const { file, until } of expressions) {
      expect({ file, until, ok: isParseableUntil(until) }).toEqual({ file, until, ok: true });
    }
  });
});
