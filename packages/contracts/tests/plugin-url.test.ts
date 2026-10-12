// plugin-url — single source of truth for the public marketplace URL scheme.
// Web (PluginShareMenu) and the landing site both derive links here; this
// pins the slug rules so the two surfaces can't drift into a 404 against the
// SSG site. Detail/share routes are SINGLE-segment (last id segment); the
// preview route keeps the namespace.

import { describe, expect, it } from 'vitest';
import {
  MISH_SITE_ORIGIN,
  pluginSlug,
  pluginSlugSegment,
  pluginDetailSlug,
  pluginDetailPath,
  pluginPreviewPath,
  pluginShareUrl,
} from '../src/plugins/plugin-url.js';

describe('pluginSlugSegment', () => {
  it('lowercases, collapses unsafe runs, trims dashes', () => {
    expect(pluginSlugSegment('Hero Deck')).toBe('hero-deck');
    expect(pluginSlugSegment('  Wild!!Name  ')).toBe('wild-name');
  });
  it('keeps url-safe punctuation and falls back to "plugin"', () => {
    expect(pluginSlugSegment('keep.dots_and-dashes')).toBe('keep.dots_and-dashes');
    expect(pluginSlugSegment('!!!')).toBe('plugin');
  });
});

describe('pluginDetailSlug (single segment = last id segment)', () => {
  it('takes the slugified last segment, dropping any namespace', () => {
    expect(pluginDetailSlug('mish/Hero Deck')).toBe('hero-deck');
    expect(pluginDetailSlug('community/registry-starter')).toBe('registry-starter');
    expect(pluginDetailSlug('live-dashboard')).toBe('live-dashboard');
  });
});

describe('pluginSlug (multi-segment, namespace preserved)', () => {
  it('slugifies each segment and keeps / as a separator', () => {
    expect(pluginSlug('mish/Hero Deck')).toBe('mish/hero-deck');
  });
});

describe('pluginDetailPath / pluginPreviewPath', () => {
  it('detail path is single-segment with trailing slash', () => {
    expect(pluginDetailPath('mish/Hero Deck')).toBe('/plugins/hero-deck/');
    expect(pluginDetailPath('live-dashboard')).toBe('/plugins/live-dashboard/');
  });
  it('preview path keeps the namespace', () => {
    expect(pluginPreviewPath('mish/Hero Deck')).toBe(
      '/plugins/previews/mish/hero-deck/',
    );
  });
});

describe('pluginShareUrl', () => {
  it('returns no link while there is no public plugin-detail site', () => {
    // A repository root does not serve `/plugins/<slug>/` routes, so a
    // default origin would hand users a link that 404s.
    expect(MISH_SITE_ORIGIN).toBeNull();
    expect(pluginShareUrl('mish/live-dashboard')).toBeNull();
    expect(pluginShareUrl('mish/live-dashboard', '')).toBeNull();
  });
  it('honours an explicit origin and trims a trailing slash on it', () => {
    expect(pluginShareUrl('x', 'https://self.host')).toBe('https://self.host/plugins/x/');
    expect(pluginShareUrl('x', 'https://self.host/')).toBe('https://self.host/plugins/x/');
  });
});

describe('pluginShareUrl origin trimming', () => {
  it('trims any number of trailing slashes and stays fast on long slash runs', () => {
    expect(pluginShareUrl('mish/hero', 'https://example.test///')).toBe(`https://example.test${pluginDetailPath('mish/hero')}`);
    const hostile = `https://example.test${'/'.repeat(50_000)}x`;
    const started = performance.now();
    pluginShareUrl('mish/hero', hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
