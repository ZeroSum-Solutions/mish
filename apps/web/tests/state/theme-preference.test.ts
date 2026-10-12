// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppearanceToDocument, resolveAppTheme } from '../../src/state/appearance';
import { DEFAULT_CONFIG, loadConfig } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const STORAGE_KEY = 'mish:config';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => store.set(key, value)),
  removeItem: vi.fn((key: string) => store.delete(key)),
  clear: vi.fn(() => store.clear()),
});

function persist(config: Partial<AppConfig>): void {
  store.set(STORAGE_KEY, JSON.stringify(config));
}

describe('theme preference', () => {
  beforeEach(() => store.clear());
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  it('defaults new installs to system and preserves valid saved preferences', () => {
    expect(DEFAULT_CONFIG.theme).toBe('system');
    expect(loadConfig().theme).toBe('system');
    for (const theme of ['light', 'dark', 'system'] as const) {
      persist({ theme });
      expect(loadConfig().theme).toBe(theme);
    }
    expect(resolveAppTheme('invalid' as AppConfig['theme'])).toBe('system');
  });

  it('applies explicit themes and leaves system mode to the media-query tokens', () => {
    applyAppearanceToDocument({ theme: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyAppearanceToDocument({ theme: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyAppearanceToDocument({ theme: 'system' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('applies the saved theme before hydration', () => {
    const layoutPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/layout.tsx');
    const source = readFileSync(layoutPath, 'utf8');
    const script = /const themeInitScript = `([^`]*)`;/.exec(source)?.[1];
    if (!script) throw new Error('themeInitScript not found');

    persist({ theme: 'dark' });
    new Function(script)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    persist({ theme: 'system' });
    new Function(script)();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
