import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@mish/contracts';

import {
  brandOfficialPluginText,
  localizePluginDescription,
} from '../../src/components/plugins-home/localization';

describe('official plugin UI branding', () => {
  it('keeps the add-marketplace placeholder neutral', () => {
    const source = readFileSync(
      new URL('../../src/components/PluginsView.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('placeholder="https://example.com/plugin-marketplace.json"');
    expect(source).not.toContain('placeholder="https://example.com/mish-marketplace.json"');
  });

  it('removes upstream product names from official marketplace copy', () => {
    expect(brandOfficialPluginText('Build an editable Mish artifact.')).toBe(
      'Build an editable Mishh Mashh artifact.',
    );
    expect(brandOfficialPluginText('Pairs Open Claude Design with motion tools.')).toBe(
      'Pairs Mishh Mashh with motion tools.',
    );
    expect(brandOfficialPluginText('Mish workflow')).toBe('Mishh Mashh workflow');
    expect(brandOfficialPluginText('See mish.invalid and @MishHQ.')).toBe(
      'See Mishh Mashh and Mishh Mashh.',
    );
    expect(brandOfficialPluginText('Contribute to ZeroSum-Solutions/mish.')).toBe(
      'Contribute to Mishh Mashh.',
    );
  });

  it('applies the rewrite only to bundled official descriptions', () => {
    const base = {
      id: 'plugin',
      title: 'Plugin',
      version: '1.0.0',
      sourceKind: 'bundled',
      source: './plugin',
      fsPath: '/plugin',
      installedAt: 0,
      updatedAt: 0,
      trust: 'trusted',
      capabilitiesGranted: [],
      manifest: {
        name: 'plugin',
        version: '1.0.0',
        description: 'Build an Mish artifact.',
      },
    } as InstalledPluginRecord;

    expect(localizePluginDescription('en', { ...base, sourceKind: 'bundled' })).toBe(
      'Build a Mishh Mashh artifact.',
    );
    expect(localizePluginDescription('en', { ...base, sourceKind: 'user' })).toBe(
      'Build an Mish artifact.',
    );
  });

  it('keeps every translated contribution label free of the upstream name', () => {
    const localeDir = new URL('../../src/i18n/locales/', import.meta.url);
    for (const file of readdirSync(localeDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, localeDir), 'utf8');
      const line = source.split('\n').find((value) =>
        value.includes('skillPluginCandidate.contributeToMain'),
      );
      expect(line, file).toBeDefined();
      expect(line, file).not.toMatch(/open[ -]?design/i);
    }
  });
});
