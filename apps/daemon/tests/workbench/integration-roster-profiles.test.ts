import { describe, expect, it, vi } from 'vitest';
import { parseIntegrationRoster } from '@open-design/contracts';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';

vi.mock('../../src/runtimes/registry.js', async original => {
  const registry = await original<typeof import('../../src/runtimes/registry.js')>();
  const base = registry.getAgentDef('claude')!;
  return { ...registry, PRODUCT_AGENT_DEFS: [...registry.PRODUCT_AGENT_DEFS,
    { ...base, id: 'work_profile', name: 'Work profile' },
    { ...base, id: 'Work.Profile-1', name: 'Mixed case profile' },
    { ...base, id: 'p'.repeat(80), name: 'Maximum local id' },
    { ...base, id: 'bad_profile', name: 'Bad\u0000name' },
    { ...base, id: 'refero', name: 'Local name collision' },
  ] };
});

describe('local CLI profiles in the shared roster', () => {
  it('preserves valid local ids and isolates a malformed profile without breaking other rows', () => {
    const roster = parseIntegrationRoster(buildIntegrationRoster({ mcpServers: [], licences: [] }));
    const ids = roster.entries.map(row => row.id);
    expect(ids).toEqual(expect.arrayContaining(['work_profile', 'Work.Profile-1', 'p'.repeat(80), 'claude', 'codex', 'refero']));
    expect(ids).not.toContain('bad_profile');
    expect(ids.filter(id => id === 'refero')).toHaveLength(1);
    expect(roster.knownGaps.join(' ')).toMatch(/local CLI profile/i);
    expect(JSON.stringify(roster)).not.toContain('Bad');
  });
});
