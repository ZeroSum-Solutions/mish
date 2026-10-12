import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAppConfig, writeAppConfig } from '../src/app-config.js';

describe('stagedDrafting app-config key', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-staged-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is off until the user turns it on', async () => {
    expect((await readAppConfig(dataDir)).stagedDrafting).toBeUndefined();
  });

  it('persists true and false', async () => {
    await writeAppConfig(dataDir, { stagedDrafting: true });
    expect((await readAppConfig(dataDir)).stagedDrafting).toBe(true);
    await writeAppConfig(dataDir, { stagedDrafting: false });
    expect((await readAppConfig(dataDir)).stagedDrafting).toBe(false);
  });

  it('clears on null', async () => {
    await writeAppConfig(dataDir, { stagedDrafting: true });
    await writeAppConfig(dataDir, { stagedDrafting: null });
    expect((await readAppConfig(dataDir)).stagedDrafting).toBeUndefined();
  });

  it('refuses a non-boolean instead of silently reading it as off', async () => {
    await expect(writeAppConfig(dataDir, { stagedDrafting: 'yes' } as never)).rejects.toThrow(
      /stagedDrafting must be true, false, or null/,
    );
  });
});
