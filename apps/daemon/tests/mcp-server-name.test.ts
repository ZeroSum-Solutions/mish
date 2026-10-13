import { describe, expect, it } from 'vitest';
import {
  buildAcpMcpServers,
  buildClaudeMcpJson,
  buildOpenCodeMcpConfigContent,
  type McpServerConfig,
} from '../src/mcp-config.js';
import { spawnedMcpServerName } from '../src/mcp-server-name.js';
import { renderConnectedExternalMcpDirective } from '../src/prompts/system.js';

const servers: McpServerConfig[] = [
  { id: 'refero', transport: 'http', enabled: true, url: 'https://api.refero.design/mcp' },
  { id: 'mishmash-already', transport: 'http', enabled: true, url: 'https://example.com/mcp' },
  { id: '21st-dev', transport: 'stdio', enabled: true, command: 'echo' },
];

describe('spawned MCP server names', () => {
  it('prefixes once and never double-prefixes', () => {
    expect(spawnedMcpServerName('refero')).toBe('mishmash-refero');
    expect(spawnedMcpServerName('mishmash-refero')).toBe('mishmash-refero');
  });

  it('Claude .mcp.json uses mishmash-refero, never a bare refero', () => {
    const out = buildClaudeMcpJson(servers) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(out.mcpServers).sort()).toEqual(
      ['mishmash-21st-dev', 'mishmash-already', 'mishmash-refero'],
    );
    expect(out.mcpServers.refero).toBeUndefined();
  });

  it('still looks up OAuth tokens by the bare daemon id', () => {
    const out = buildClaudeMcpJson(
      [{ id: 'refero', transport: 'http', enabled: true, authMode: 'oauth', url: 'https://api.refero.design/mcp' }],
      { refero: 'tok' },
    ) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(out.mcpServers['mishmash-refero']?.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('ACP names are namespaced', () => {
    expect(buildAcpMcpServers(servers).map((s) => s.name)).toEqual(['mishmash-21st-dev']);
  });

  it('OpenCode config keys are namespaced', () => {
    const parsed = JSON.parse(buildOpenCodeMcpConfigContent(servers) as string);
    expect(Object.keys(parsed.mcp)).not.toContain('refero');
    expect(Object.keys(parsed.mcp)).toContain('mishmash-refero');
  });

  it('system prompt names the namespaced server', () => {
    const text = renderConnectedExternalMcpDirective([{ id: 'refero' }]);
    expect(text).toContain('`mishmash-refero`');
    expect(text).not.toContain('- `refero`');
  });
});
