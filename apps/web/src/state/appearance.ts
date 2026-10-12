import { getMishHost } from '@mish/host';
import type { AppTheme } from '../types';

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

export const DEFAULT_ACCENT_COLOR = '#353535';
export const ACCENT_SWATCHES = [
  DEFAULT_ACCENT_COLOR,
  '#202020',
  '#848484',
  '#87ea5c',
  '#0d5400',
  '#1A74FF',
  '#FFBA12',
  '#FF7528',
  '#F04142',
] as const;

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAccentColor(value: unknown): string {
  return normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}

function accentVars(accentColor: string): Record<(typeof ACCENT_VARS)[number], string> {
  return {
    '--accent': accentColor,
    // Keep these mix ratios in sync with the pre-hydration script in app/layout.tsx.
    '--accent-strong': `color-mix(in srgb, ${accentColor} 82%, var(--text-strong))`,
    '--accent-soft': `color-mix(in srgb, ${accentColor} 12%, var(--bg-subtle))`,
    '--accent-tint': `color-mix(in srgb, ${accentColor} 6%, var(--bg-panel))`,
    '--accent-hover': `color-mix(in srgb, ${accentColor} 86%, var(--text-strong))`,
  };
}

export const DEFAULT_APP_THEME: AppTheme = 'system';

export function resolveAppTheme(persisted?: AppTheme | null): AppTheme {
  return persisted === 'light' || persisted === 'dark' || persisted === 'system'
    ? persisted
    : DEFAULT_APP_THEME;
}

/** Pick the higher-contrast ink for a custom solid accent (WCAG sRGB). */
export function accessibleAccentInk(accent: string): '#000000' | '#ffffff' {
  const hex = resolveAccentColor(accent);
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

export const WORKSPACE_ACCENT_INK_VARS = [
  '--ui-on-accent', '--ui-on-accent-hover', '--ui-on-accent-strong',
] as const;

export function workspaceAccentInks(accent: string, textStrong: string): Record<(typeof WORKSPACE_ACCENT_INK_VARS)[number], string> {
  const mix = (weight: number): string => '#' + [1, 3, 5].map((offset) =>
    Math.round(parseInt(accent.slice(offset, offset + 2), 16) * weight
      + parseInt(textStrong.slice(offset, offset + 2), 16) * (1 - weight))
      .toString(16).padStart(2, '0')).join('');
  return {
    '--ui-on-accent': accessibleAccentInk(accent),
    '--ui-on-accent-hover': accessibleAccentInk(mix(0.86)),
    '--ui-on-accent-strong': accessibleAccentInk(mix(0.82)),
  };
}

/** Catalog keeps its legacy ink; workspace custom accents get readable ink in every filled state. */
export function updateWorkspaceAccentInk(root: HTMLElement): void {
  const custom = normalizeAccentColor(root.style.getPropertyValue('--accent'));
  if (root.dataset.uiSystem === 'workspace' && custom && custom !== DEFAULT_ACCENT_COLOR) {
    const dark = root.dataset.theme === 'dark'
      || (!root.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const textStrong = normalizeAccentColor(getComputedStyle(root).getPropertyValue('--text-strong'))
      ?? (dark ? '#f4f7fc' : '#171d28');
    const inks = workspaceAccentInks(custom, textStrong);
    for (const name of WORKSPACE_ACCENT_INK_VARS) root.style.setProperty(name, inks[name]);
  } else for (const name of WORKSPACE_ACCENT_INK_VARS) root.style.removeProperty(name);
}

export function applyAppearanceToDocument({
  accentColor,
  theme,
}: {
  accentColor?: string;
  theme?: AppTheme;
}): void {
  const root = document.documentElement;
  const normalizedTheme = resolveAppTheme(theme);
  if (normalizedTheme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', normalizedTheme);
  const resolvedTheme = normalizedTheme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : normalizedTheme;
  // Desktop shell: keep the native window appearance (the macOS vibrancy
  // glass material) in step with the app theme. Without this the glass
  // follows the OS appearance, so the light app over a dark OS sat on dark
  // glass and read as a muddy gray (#94). Feature-detected — browsers and
  // older host builds have no appearance capability.
  getMishHost()?.appearance?.setTheme(resolvedTheme);

  const normalized = resolveAccentColor(accentColor);
  // The neutral default is theme-owned: tokens.css intentionally flips it
  // from charcoal in light mode to near-white in dark mode. Leaving a
  // #353535 inline override here made selected labels and outlines disappear
  // on the black palette. Custom accents remain explicit user choices.
  if (normalized === DEFAULT_ACCENT_COLOR) {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
    updateWorkspaceAccentInk(root);
    return;
  }
  const vars = accentVars(normalized);
  for (const name of ACCENT_VARS) {
    root.style.setProperty(name, vars[name]);
  }
  updateWorkspaceAccentInk(root);
}
