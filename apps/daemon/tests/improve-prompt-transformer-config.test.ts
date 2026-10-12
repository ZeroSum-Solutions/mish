import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAppConfig, readImprovePromptTransformerLane, writeAppConfig } from '../src/app-config.js';

describe('improvePromptTransformer app-config key', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'od-transformer-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('is unset (terra, D28.4) until the user picks a lane', async () => {
    expect((await readAppConfig(dataDir)).improvePromptTransformer).toBeUndefined();
  });

  it('persists terra and claude, and clears on null', async () => {
    await writeAppConfig(dataDir, { improvePromptTransformer: 'terra' });
    expect((await readAppConfig(dataDir)).improvePromptTransformer).toBe('terra');
    await writeAppConfig(dataDir, { improvePromptTransformer: 'claude' });
    expect((await readAppConfig(dataDir)).improvePromptTransformer).toBe('claude');
    await writeAppConfig(dataDir, { improvePromptTransformer: null } as never);
    expect((await readAppConfig(dataDir)).improvePromptTransformer).toBeUndefined();
  });

  it('refuses an unknown lane instead of silently reading it as claude', async () => {
    await expect(writeAppConfig(dataDir, { improvePromptTransformer: 'gpt' } as never)).rejects.toThrow(/improvePromptTransformer must be claude, terra, or null/);
  });

  describe('the lane the transformer reads (D28.4)', () => {
    const configFile = () => path.join(dataDir, 'app-config.json');
    it('is terra with no file, no key, after a null reset, or when chosen', async () => {
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('terra');
      await writeAppConfig(dataDir, { stagedDrafting: true });
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('terra');
      await writeAppConfig(dataDir, { improvePromptTransformer: 'claude' });
      await writeAppConfig(dataDir, { improvePromptTransformer: null } as never);
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('terra');
      await writeAppConfig(dataDir, { improvePromptTransformer: 'terra' });
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('terra');
    });

    it('keeps an explicit claude opt-out', async () => {
      await writeAppConfig(dataDir, { improvePromptTransformer: 'claude' });
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('claude');
    });

    it('fails closed to claude when the file or the value is damaged', async () => {
      for (const damaged of ['{"improvePromptTransformer": "cla', '[]', '"terra"', '{"improvePromptTransformer": "Claude"}', '{"improvePromptTransformer": 1}']) {
        await writeFile(configFile(), damaged);
        expect(await readImprovePromptTransformerLane(dataDir)).toBe('claude');
        // An unrelated save rewrites the file; the opt-out must survive it.
        await writeAppConfig(dataDir, { stagedDrafting: true });
        expect(await readImprovePromptTransformerLane(dataDir)).toBe('claude');
        expect((await readAppConfig(dataDir)).improvePromptTransformer).toBe('claude');
      }
    });

    it('keeps an explicit claude through unrelated saves, and a reset still returns to terra', async () => {
      await writeAppConfig(dataDir, { improvePromptTransformer: 'claude' });
      await writeAppConfig(dataDir, { stagedDrafting: true });
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('claude');
      await writeAppConfig(dataDir, { improvePromptTransformer: null } as never);
      await writeAppConfig(dataDir, { stagedDrafting: false });
      expect(await readImprovePromptTransformerLane(dataDir)).toBe('terra');
    });
  });
});
