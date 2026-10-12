// Mish pack manifest validation: shape, safe relative paths, the environment allow-list, and the
// rule that an MCP server never carries a literal credential.

import { describe, expect, it } from 'vitest';

import { isSafeMishPackPath, mishPackEnvProblem, mishPackManifestSchema } from '@mish/contracts';

import { checkArchiveEntryPath } from '../../src/mish-packs/extract.js';
import { parseMishPackManifestText } from '../../src/mish-packs/store.js';

const base = { schemaVersion: 1, id: 'team-kit', name: 'Team kit', version: '1.0.0' };

function parse(provides: unknown, extra: Record<string, unknown> = {}) {
  return mishPackManifestSchema.safeParse({ ...base, provides, ...extra });
}

describe('mish-pack.json', () => {
  it('accepts an empty and a full manifest', () => {
    expect(parse({}).success).toBe(true);
    expect(mishPackManifestSchema.safeParse(base).success).toBe(true);
    expect(parse({
      catalogs: { cultKit: 'kit', cultCatalog: 'catalog', cultAdapters: 'adapters/index.mjs', genui: 'genui', sections: 'sections.json', twentyFirst: 'twentyfirst' },
      designSystems: 'ds', skills: 'skills', studies: 'studies',
      assets: { pets: 'pets', promptTemplates: 'prompts', styleCatalog: 'styles' },
      env: { MISH_AMR_CONSOLE_URL: 'https://console.example.test' },
      mcpServers: [{ id: 'refero', transport: 'http', url: 'https://api.example.test/mcp' }],
    }).success).toBe(true);
  });

  it.each([
    ['a bad id', { id: 'Team Kit' }],
    ['a wrong schema version', { schemaVersion: 2 }],
    ['an unknown top-level key', { surprise: true }],
    ['a missing name', { name: '' }],
  ])('rejects %s', (_label, change) => {
    expect(mishPackManifestSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });

  it('rejects an unknown provides key', () => {
    expect(parse({ plugins: 'x' }).success).toBe(false);
  });

  it.each([
    '../outside',
    '/etc/passwd',
    'a/../b',
    'a/./b',
    'a\\b',
    'C:/Windows',
    'a//b',
    'trailing/',
    'dot.',
    '',
    'a/b\u0000c',
    'x'.repeat(600),
  ])('rejects the path %j in every path field', (bad) => {
    expect(isSafeMishPackPath(bad)).toBe(false);
    expect(parse({ catalogs: { cultKit: bad } }).success).toBe(false);
    expect(parse({ skills: bad }).success).toBe(false);
    expect(parse({ assets: { pets: bad } }).success).toBe(false);
  });

  it('accepts ordinary nested relative paths', () => {
    for (const ok of ['kit', 'kit/cult-ui-pro', 'a b/c-d_e/f.json', 'x@1/y']) expect(isSafeMishPackPath(ok)).toBe(true);
  });

  it('refuses archive entry paths that leave the folder', () => {
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\x', 'a\\b', 'a/./b', '']) expect(() => checkArchiveEntryPath(bad)).toThrow(/unsafe path/);
    expect(checkArchiveEntryPath('a/b/')).toBe('a/b');
  });

  describe('environment allow-list', () => {
    it('lets a pack set only the listed keys, with checked values', () => {
      expect(parse({ env: { MISH_AMR_CONSOLE_URL: 'https://console.example.test' } }).success).toBe(true);
      expect(parse({ env: { MISH_AMR_CONSOLE_URL: 'http://localhost:5173' } }).success).toBe(true);
      expect(parse({ env: { MISH_VELA_WEB_URLS: '{"prod":"https://a.example.test"}' } }).success).toBe(true);
      expect(parse({ env: { PATH: '/tmp/evil' } }).success).toBe(false);
      expect(parse({ env: { OD_DATA_DIR: '/tmp/x' } }).success).toBe(false);
      expect(parse({ env: { NODE_OPTIONS: '--require x' } }).success).toBe(false);
      expect(parse({ env: { MISH_AMR_CONSOLE_URL: 'http://remote.example.test' } }).success).toBe(false);
      expect(parse({ env: { MISH_AMR_CONSOLE_URL: 'https://user:pass@console.example.test' } }).success).toBe(false);
      expect(parse({ env: { MISH_AMR_CONSOLE_URL: 'javascript:alert(1)' } }).success).toBe(false);
      expect(parse({ env: { MISH_VELA_WEB_URLS: '["x"]' } }).success).toBe(false);
      expect(mishPackEnvProblem('MISH_AMR_PROFILE', 'prod')).toBeNull();
      expect(mishPackEnvProblem('MISH_AMR_PROFILE', 'Prod Env')).not.toBeNull();
    });
  });

  describe('MCP servers', () => {
    const http = { id: 'srv', transport: 'http', url: 'https://mcp.example.test/mcp' };

    it('takes environment placeholders but never a literal credential', () => {
      expect(parse({ mcpServers: [{ id: 'a', transport: 'stdio', command: 'node', env: { TOKEN: '${MY_TOKEN}' } }] }).success).toBe(true);
      expect(parse({ mcpServers: [{ ...http, headers: { Authorization: 'Bearer ${MY_TOKEN}' } }] }).success).toBe(true);
      expect(parse({ mcpServers: [{ ...http, headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz' } }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ id: 'a', transport: 'stdio', command: 'node', env: { TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, url: 'https://mcp.example.test/mcp?api_key=abc' }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, url: 'https://user:pw@mcp.example.test/mcp' }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, url: 'https://mcp.example.test/${X}' }] }).success).toBe(false);
    });

    it('checks transport fields and unique ids', () => {
      expect(parse({ mcpServers: [{ id: 'a', transport: 'stdio' }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ id: 'a', transport: 'http' }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, url: 'file:///etc/passwd' }] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, command: 'node' }] }).success).toBe(false);
      expect(parse({ mcpServers: [http, http] }).success).toBe(false);
      expect(parse({ mcpServers: [{ ...http, id: 'Bad Id' }] }).success).toBe(false);
    });
  });

  it('reports a bounded message for invalid JSON and invalid manifests', () => {
    expect(() => parseMishPackManifestText('{nope')).toThrow(/not valid JSON/);
    expect(() => parseMishPackManifestText(JSON.stringify({ ...base, provides: { skills: '../x' } }))).toThrow(/provides\.skills/);
  });
});
