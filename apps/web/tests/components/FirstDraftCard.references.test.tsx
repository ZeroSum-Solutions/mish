// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RouteDecision } from '@mish/contracts';
import { FirstDraftCard } from '../../src/components/design-index/FirstDraftCard';
import { I18nProvider } from '../../src/i18n';
import { referenceFanout } from '../helpers/reference-fanout';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const decision = { decision: 'routed', spine: { code: 'TL' }, family: { id: 'practice' } } as RouteDecision;
it('searches the routed spine with exact named kept sections and drops results when hints change', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(url === '/api/design-systems' ? { designSystems: [] } : referenceFanout()));
  }));
  const sections = [{ id: 'services', name: 'Treatment options', purpose: 'Services' }];
  const view = render(<I18nProvider initial="en"><FirstDraftCard brief="Dentistry" decision={decision} sectionHints={{ services: 'keep' }} referenceSections={sections} /></I18nProvider>);
  expect(calls.some(call => call.url.includes('references'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(calls.find(call => call.url.includes('references'))?.body).toMatchObject({ brief: 'Dentistry', spineCode: 'TL', sectionAdditions: sections });
  expect(calls.find(call => call.url.includes('references'))?.body).not.toHaveProperty('sections');
  view.rerender(<I18nProvider initial="en"><FirstDraftCard brief="Dentistry" decision={decision} sectionHints={{ services: 'drop' }} referenceSections={sections} /></I18nProvider>);
  expect(screen.queryByRole('link', { name: 'Dental practice' })).toBeNull();
});
it('shows the section bound instead of silently truncating named sections', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ designSystems: [] }))));
  render(<I18nProvider initial="en"><FirstDraftCard brief="Dentistry" decision={decision} sectionHints={{}} referenceSections={Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: 'Services', purpose: null }))} /></I18nProvider>);
  expect(screen.getByRole('button', { name: 'Find references' })).toBeDisabled();
  expect(screen.getByText(/1–8 non-empty sections/)).toBeTruthy();
});
it.each([{ label: 'default', sections: undefined }, { label: 'auto', sections: [] }])('keeps Find references enabled for $label choices with no named sections', async ({ sections }) => {
  let request: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/references/')) request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(url === '/api/design-systems' ? { designSystems: [] } : referenceFanout()));
  }));
  render(<I18nProvider initial="en"><FirstDraftCard brief="Dentistry" decision={decision} sectionHints={{}} referenceSections={sections} /></I18nProvider>);
  const button = screen.getByRole('button', { name: 'Find references' });
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(request).toMatchObject({ brief: 'Dentistry', spineCode: 'TL' });
  expect(request).not.toHaveProperty('sections');
  expect(request).not.toHaveProperty('sectionAdditions');
});
it('carries dropped named roles as exclusions without replacing explicit kept sections', async () => {
  let request: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/references/')) request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(url === '/api/design-systems' ? { designSystems: [] } : referenceFanout()));
  }));
  const sections = [{ id: 'services', name: 'Treatment options', purpose: 'Services' }];
  render(<I18nProvider initial="en"><FirstDraftCard brief="Dentistry" decision={decision} sectionHints={{ services: 'keep', reviews: 'drop' }} referenceSections={sections} referenceExcludedSections={['Patient stories', 'testimonials']} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  await screen.findByRole('link', { name: 'Dental practice' });
  expect(request).toMatchObject({ sectionAdditions: sections, excludedSections: ['Patient stories', 'testimonials'] });
  expect(request).not.toHaveProperty('sections');
});
