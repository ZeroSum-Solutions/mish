import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { createIntegrationProbes } from '../../src/workbench/integration-probes.js';
import { IntegrationStatusService, migrateIntegrationStatus } from '../../src/workbench/integration-status.js';
import { RUNTIME_INTEGRATION_ROWS } from '../../src/workbench/integration-roster-data.js';
import { readMcpConfig } from '../../src/mcp-config.js';
import { tempDir } from './design-brief-fixture.js';

vi.mock('../../src/mcp-config.js', async original => ({ ...await original<typeof import('../../src/mcp-config.js')>(), readMcpConfig: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });

describe('V03-1b with the real inspector and an empty MCP config', () => {
  it('keeps curated rows on their recorded install state while runtime rows follow the live probe', async () => {
    vi.mocked(readMcpConfig).mockResolvedValue({ servers: [] });
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const db = new Database(':memory:'); migrateIntegrationStatus(db);
    cleanups.push(async () => { db.close(); });
    const probes = createIntegrationProbes({ dataDir: dir, skillRoots: [], proxy: { search: vi.fn() } });
    const roster = buildIntegrationRoster({ mcpServers: [], licences: [] });
    const listed = await new IntegrationStatusService({ db, inspect: probes.inspect, probe: probes.probe }).status(roster);
    const recorded = (id: string) => roster.entries.find(row => row.id === id)!.installState;
    const row = (id: string) => listed.entries.find(item => item.id === id)!;

    for (const id of ['shadcn', 'react-bits', 'figma', 'gsap', 'hallmark']) expect(row(id).installState, id).toEqual(recorded(id));

    const runtimeIds = RUNTIME_INTEGRATION_ROWS.map(item => item.id);
    for (const id of ['github', 'higgsfield', 'vercel', 'jev', 'claude', 'codex']) expect(runtimeIds, id).toContain(id);
    for (const id of runtimeIds) {
      const entry = row(id);
      expect(['installed', 'missing'], id).toContain(entry.runtime?.installed);
      expect(entry.installState.state, id).toBe(entry.runtime?.installed === 'installed' ? 'configured' : 'not-installed');
      expect(entry.installState.reason, id).not.toMatch(/has not been checked/);
    }
    // With no MCP server, Jev has no other lane: missing, with a Settings fix that never claims a local install.
    expect(row('jev').installState).toMatchObject({ state: 'not-installed', reason: expect.stringContaining('Settings → External MCP') });
    expect(row('jev').installState.reason).not.toMatch(/on this machine/);
  });
});
