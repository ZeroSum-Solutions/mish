import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDesignSystem, uninstallDesignSystem, uninstallSkill, syncCommunityPets } from '../../src/providers/registry';
import { finalizeBrandProject, extractBrandFromHtml, continueBrandExtraction, cancelBrandExtraction } from '../../src/runtime/brands';
import { publishGeneratedPluginToGitHub, contributeGeneratedPluginToMish } from '../../src/state/projects';
import { startMcpOAuth } from '../../src/state/mcp';
import { startVelaLogin } from '../../src/providers/daemon';
import { fetchElevenLabsVoiceOptions } from '../../src/providers/elevenlabs-voices';

afterEach(() => vi.unstubAllGlobals());
function fail(code = 'INTERNAL_ERROR', status = 500) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code, message: 'safe failure reason' } }), {
    status, headers: { 'Content-Type': 'application/json' },
  })));
}
describe('daemon contract error consumers', () => {
  it.each([
    ['skill uninstall', () => uninstallSkill('skill')],
    ['design system install', () => installDesignSystem({ source: 'github', url: 'https://github.com/example/kit' })],
    ['design system uninstall', () => uninstallDesignSystem('kit')],
    ['pet sync', () => syncCommunityPets()],
    ['brand finalize', () => finalizeBrandProject('brand', 'project')],
    ['brand HTML extraction', () => extractBrandFromHtml('brand', { html: '<html></html>' } as Parameters<typeof extractBrandFromHtml>[1])],
    ['brand continue', () => continueBrandExtraction('brand')],
    ['brand cancel', () => cancelBrandExtraction('brand')],
  ] as const)('%s returns a displayable string', async (_name, operation) => {
    fail();
    expect(await operation()).toMatchObject({ error: 'safe failure reason' });
  });
  it.each([400, 404, 500])('plugin share actions preserve typed %s reasons and codes', async (status) => {
    fail('PLUGIN_FOLDER_NOT_FOUND', status);
    for (const operation of [publishGeneratedPluginToGitHub, contributeGeneratedPluginToMish]) {
      expect(await operation('project', 'plugin')).toMatchObject({ ok: false, code: 'PLUGIN_FOLDER_NOT_FOUND', message: 'safe failure reason' });
    }
  });
  it('MCP OAuth keeps the typed failure reason', async () => {
    fail();
    expect(await startMcpOAuth('server')).toMatchObject({ ok: false, message: 'safe failure reason' });
  });
  it('Vela login keeps a displayable typed reason', async () => {
    fail();
    expect(await startVelaLogin()).toMatchObject({ ok: false, error: 'safe failure reason' });
  });
  it('voice lookup shows the safe message instead of serialised JSON', async () => {
    fail();
    await expect(fetchElevenLabsVoiceOptions()).rejects.toThrow(/: safe failure reason$/);
  });
});
