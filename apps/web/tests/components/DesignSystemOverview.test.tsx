// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/providers/registry', () => ({ fetchProjectFileText: vi.fn(async () => null), projectRawUrl: vi.fn(), openExternalUrl: vi.fn() }));
import { DesignSystemOverview } from '../../src/components/DesignSystemOverview';
import { I18nProvider } from '../../src/i18n';
import type { DesignKit } from '../../src/runtime/design-kit';

afterEach(cleanup);
const kit: DesignKit = {
  name: 'Doppler · Study', editable: false, canUpload: false, logoAlternates: [],
  description: 'A precise operations console. Long identity guidance stays available when expanded.',
  colors: [{ name: 'Green', role: 'accent', hex: '#00f575', usage: 'Primary action' }],
  typography: { body: { family: 'Inter', fallbacks: ['sans-serif'], weights: [400, 600] } },
  fonts: [], showcaseHtml: '<!doctype html><h1>Working console</h1>',
};
describe('Design-system browsing overview', () => {
  it('shows every recorded color once, with usage guidance instead of a second palette', () => {
    const colors = Array.from({ length: 15 }, (_, i) => ({ role: 'source', name: `Color ${i}`, hex: `#${String(i).padStart(6, '0')}`, usage: `Purpose ${i}` }));
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, colors }} dataTestId="overview" /></I18nProvider>);
    const palette = screen.getByRole('region', { name: 'Palette' });
    expect(palette.querySelectorAll('ul > li')).toHaveLength(15);
    expect(palette.querySelectorAll('i')).toHaveLength(15);
    expect(palette.querySelectorAll('code')).toHaveLength(15);
    expect(palette.querySelector('details')?.textContent).toContain('Purpose 14');
    expect(palette.querySelector('details')?.querySelector('code, i')).toBeNull();
  });
  it('shows a calm empty state without an empty swatch grid', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, colors: [] }} dataTestId="overview" /></I18nProvider>);
    expect(screen.getByText('No recorded colors')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Palette' }).querySelector('ul, details')).toBeNull();
  });
  it('does not repeat a color value when its label uses different hex capitalization', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, colors: [{ role: 'source', name: '#ABCDEF', hex: '#abcdef', usage: '' }] }} dataTestId="overview" /></I18nProvider>);
    expect(screen.getByRole('region', { name: 'Palette' }).querySelector('code')).toBeNull();
  });
  it('shows repeated token colors once while preserving each token’s usage', () => {
    const colors = [{ role: 'background', name: 'Canvas', hex: '#FFFFFF', usage: 'Page' }, { role: 'surface', name: 'Surface', hex: '#ffffff', usage: 'Card' }];
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, colors }} dataTestId="overview" /></I18nProvider>);
    const palette = screen.getByRole('region', { name: 'Palette' });
    expect(palette.querySelectorAll('ul > li')).toHaveLength(1);
    expect(palette.querySelector('li')?.title).toContain('Surface — Card');
    expect(palette.querySelector('details')?.textContent).toContain('CanvasPageSurfaceCard');
  });
  it('labels substituted typography without requiring the notes disclosure', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, typography: { body: { family: 'Manrope', fallbacks: [], weights: [400], notes: 'Source: Satoshi. Free visual alternative; not the original typeface.' } } }} dataTestId="overview" /></I18nProvider>);
    expect(screen.getByText('Free alternative')).toBeTruthy();
    expect(screen.getByText('Manrope')).toBeTruthy();
  });
  it('leads with an isolated showcase, then palette, title, identity and typography', () => {
    render(<I18nProvider><DesignSystemOverview kit={kit} dataTestId="overview" /></I18nProvider>);
    const overview = screen.getByTestId('overview');
    expect(overview.firstElementChild).toBe(screen.getByTestId('design-system-overview-showcase'));
    expect(overview.children[1]!.getAttribute('aria-label')).toBe('Palette');
    expect(overview.children[2]!.tagName).toBe('HEADER');
    const frame = screen.getByTitle('Doppler showcase');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('Working console');
    expect(frame.getAttribute('srcdoc')).toContain('data-od-preview-redirect-guard');
    expect(frame.getAttribute('srcdoc')).toContain('localStorage');
    expect(screen.getByRole('heading', { name: 'Doppler' })).toBeTruthy();
    const sections = [...overview.querySelectorAll('section[aria-label]')];
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual(['Palette', 'Typography']);
    const identity = screen.getByText('Identity', { selector: 'summary' }).closest('details')!;
    expect(identity.open).toBe(false);
    fireEvent.click(identity.querySelector('summary')!);
    // Native details owns the keyboard/click behavior in browsers. Identity
    // remains complete in the document instead of being permanently truncated.
    expect(identity.textContent).toContain('Long identity guidance');
  });
  it('loads declared fonts and removes the stylesheet when the preview closes', () => {
    const url = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600';
    const view = render(<I18nProvider><DesignSystemOverview kit={{ ...kit, fonts: [{ family: 'Inter', weights: [400, 600], fallbacks: [], googleFontsUrl: url }] }} dataTestId="overview" /></I18nProvider>);
    expect([...document.head.querySelectorAll('link')].map(link => link.getAttribute('href'))).toContain(url);
    view.unmount();
    expect(document.head.querySelector(`link[href="${url}"]`)).toBeNull();
  });
  it('loads only generated package font rules and cleans them up after browsing', () => {
    const url = '/api/design-systems/user%3Adoppler/static?path=fonts%2Finter.woff2&workspaceId=team';
    const view = render(<I18nProvider><DesignSystemOverview kit={{ ...kit, fontFaces: [{ family: 'od-package-61', url, weight: '400', style: 'normal' }] }} dataTestId="overview" /></I18nProvider>);
    expect(document.head.querySelector('style[data-package-fonts]')?.textContent).toContain(url);
    expect(document.head.querySelector('link[href*="fonts.css"]')).toBeNull();
    view.unmount();
    expect(document.head.querySelector('style[data-package-fonts]')).toBeNull();
  });
  it('uses a reference image when no working showcase is available', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, showcaseHtml: null, referenceImageUrl: '/source.png' }} dataTestId="overview" /></I18nProvider>);
    expect(screen.getByRole('img').getAttribute('src')).toBe('/source.png');
    expect(screen.queryByTitle('Doppler showcase')).toBeNull();
  });
  it('falls back to a working showcase when the reference image fails', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, referenceImageUrl: '/missing.png' }} dataTestId="overview" /></I18nProvider>);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByTitle('Doppler showcase')).toBeTruthy();
  });
  it('keeps an unpunctuated identity available in its disclosure', () => {
    const longDescription = 'A long unpunctuated identity '.repeat(30);
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, description: longDescription }} dataTestId="overview" /></I18nProvider>);
    expect(screen.getByText('Identity', { selector: 'summary' }).closest('details')?.querySelector('p')?.textContent).toBe(longDescription);
  });
  it('prefers the actual package kit over a generated showcase and allows isolated scripts', () => {
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, system: { kitUrl: '/kit.html' } }} dataTestId="overview" /></I18nProvider>);
    const frame = screen.getByTitle('Doppler component showcase');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
  it('opens a long palette as a compact strip with an expand control', () => {
    const colors = Array.from({ length: 12 }, (_, i) => ({ role: 'source', name: `Tone ${i}`, hex: `#${String(i).padStart(6, '0')}`, usage: '' }));
    render(<I18nProvider><DesignSystemOverview kit={{ ...kit, colors }} dataTestId="overview" /></I18nProvider>);
    const palette = screen.getByRole('region', { name: 'Palette' });
    const toggle = screen.getByRole('button', { name: 'Show all 12 colors' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect((palette.querySelector('ul') as HTMLElement).hidden).toBe(true);
    expect(palette.querySelectorAll('.ds-overview-paletteStrip > span')).toHaveLength(12);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect((palette.querySelector('ul') as HTMLElement).hidden).toBe(false);
    expect(palette.querySelector('.ds-overview-paletteStrip')).toBeNull();
  });
  it('keeps a short palette fully visible without a toggle', () => {
    render(<I18nProvider><DesignSystemOverview kit={kit} dataTestId="overview" /></I18nProvider>);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    expect((screen.getByRole('region', { name: 'Palette' }).querySelector('ul') as HTMLElement).hidden).toBe(false);
  });
  it('holds a skeleton over the showcase until the frame loads', () => {
    render(<I18nProvider><DesignSystemOverview kit={kit} dataTestId="overview" /></I18nProvider>);
    const stage = screen.getByTestId('design-system-overview-showcase');
    expect(stage.getAttribute('data-ready')).toBe('false');
    fireEvent.load(screen.getByTitle('Doppler showcase'));
    expect(stage.getAttribute('data-ready')).toBe('true');
  });
});
