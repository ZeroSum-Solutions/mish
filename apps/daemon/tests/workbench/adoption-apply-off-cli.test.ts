import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAdoptionCli } from '../../src/workbench/placement/adoption-cli.js';

afterEach(() => vi.unstubAllGlobals());

describe('od workbench adoption refusal text', () => {
  it('does not describe an unsupported imported project as an off machine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: {
      code: 'VALIDATION_FAILED', message: 'Adoption into imported project roots is unsupported',
      details: { kind: 'placement', reason: 'unsupported-capability' },
    } }), { status: 422 })));
    const lines: unknown[] = [];
    expect(await runAdoptionCli(['apply', '--plan', 'plan-1', '--digest', 'd'.repeat(64)], {
      baseUrl: 'http://127.0.0.1:1234', write: line => lines.push(line),
    })).toBe(3);
    expect(lines).not.toContainEqual(expect.stringContaining('Apply is off on this machine'));
    expect(JSON.stringify(lines)).toContain('Adoption into imported project roots is unsupported');
  });
  it('maps an adoption-unprovisioned reason without a gate list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: {
      code: 'VALIDATION_FAILED', message: 'Adoption is unavailable (adoption-executor-unprovisioned)',
      details: { kind: 'adoption', reason: 'adoption-executor-unprovisioned' },
    } }), { status: 422 })));
    const lines: unknown[] = [];
    expect(await runAdoptionCli(['apply', '--plan', 'plan-1', '--digest', 'd'.repeat(64)], {
      baseUrl: 'http://127.0.0.1:1234', write: line => lines.push(line),
    })).toBe(3);
    expect(lines).toEqual([
      'Apply is off on this machine. Apply needs the placement helper, which is off here. Use Copy code, or start Mishh with apply enabled (see setup).',
      'Reason: adoption-executor-unprovisioned',
    ]);
  });
  it.each([
    ['prepare', ['--request-file', '-']],
    ['catalogue-prepare', ['--ref', 'ref-key', '--project', 'p1', '--entry', 'src/App.tsx']],
    ['apply', ['--plan', 'plan-1', '--digest', 'd'.repeat(64)]],
  ])('%s reports the Apply-off reason in two human lines while --json remains structured', async (command, flags) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: {
      code: 'VALIDATION_FAILED', message: 'Adoption is unavailable (ordinary-uncoordinated: controlled-writers-unmigrated)',
      details: { kind: 'placement', reason: 'unsupported-capability', gates: ['adoption-executor-unprovisioned'] },
    } }), { status: 422, headers: { 'content-type': 'application/json' } })));
    const lines: unknown[] = [];
    const options = { baseUrl: 'http://127.0.0.1:1234', readStdin: async () => JSON.stringify({ projectId: 'p1', entryPath: 'src/App.tsx', source: { implementationOrigin: 'owned' }, writes: [{ path: 'src/App.tsx', role: 'entry', contentBase64: 'eA==' }] }), write: (line: unknown) => lines.push(line) };
    expect(await runAdoptionCli([command, ...flags], options)).toBe(3);
    expect(lines).toEqual([
      'Apply is off on this machine. Apply needs the placement helper, which is off here. Use Copy code, or start Mishh with apply enabled (see setup).',
      'Reason: unsupported-capability (adoption-executor-unprovisioned)',
    ]);
    lines.length = 0;
    expect(await runAdoptionCli([command, ...flags, '--json'], options)).toBe(3);
    expect(lines).toEqual([{ status: 422, error: {
      code: 'VALIDATION_FAILED', message: 'Adoption is unavailable (ordinary-uncoordinated: controlled-writers-unmigrated)',
      details: { kind: 'placement', reason: 'unsupported-capability', gates: ['adoption-executor-unprovisioned'] },
    } }]);
  });
});
