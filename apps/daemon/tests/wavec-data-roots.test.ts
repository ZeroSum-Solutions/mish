import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRegistryRoots } from '../src/plugins/registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Wave C data-root boundaries', () => {
  it('D7 derives registry roots from the resolved root, ignoring the environment', () => {
    vi.stubEnv('OD_DATA_DIR', 'wrong-root');
    const resolved = path.join(path.parse(process.cwd()).root, 'resolved-root');
    const roots = defaultRegistryRoots(resolved);
    expect(roots.userPluginsRoot).toBe(path.join(resolved, 'plugins'));
  });

  it('D8 refuses config reads and writes before configuration without touching disk', async () => {
    vi.resetModules();
    const config = await import('../src/connectors/composio-config.js');
    const read = vi.spyOn(fs, 'readFileSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(() => config.readComposioConfig()).toThrow(/not configured/i);
    expect(() => config.writeComposioConfig({ apiKey: 'test-placeholder' })).toThrow(/not configured/i);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('D8 refuses catalog persistence until its root is configured', async () => {
    vi.resetModules();
    const config = await import('../src/connectors/composio-config.js');
    config.configureComposioConfigStore(process.env.OD_DATA_DIR!);
    const { ComposioConnectorProvider } = await import('../src/connectors/composio.js');
    const write = vi.spyOn(fs, 'writeFileSync');
    const provider = new ComposioConnectorProvider();
    await expect(provider.listDefinitions()).rejects.toThrow(/not configured/i);
    expect(write).not.toHaveBeenCalled();
  });
});
