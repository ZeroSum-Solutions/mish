// @vitest-environment jsdom
// AC-R07.2 "Viewport controls ... use existing preview semantics": the Enlarge shell offers the
// catalog previews' labelled, pressed-state width switch at 320, 375, 768, 1024 and 1440 px (plus
// Fit). Changing the width resizes the same sandboxed document — no reload, no new srcDoc — and
// the controls are ordinary buttons inside the dialog's focus trap.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function resource(overrides: Partial<ResourceResult> = {}): ResourceResult {
  return {
    ref: { sourceType: 'section', sourceId: 'sections', itemId: 'hyperui:application/charts/1', revisionOrDigest: 'digest' },
    refKey: 'key', title: 'Charts', category: 'section', readiness: 'unverified',
    compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: null },
    rightsStatus: 'unknown', fitReasons: [],
    previewCapability: { available: true, kind: 'html', url: '/api/sections/charts/preview', reason: null, adapter: 'compiled-html-section' },
    adoptionCapability: { available: false, reason: 'adapter-missing' },
    sourceAttribution: { title: 'hyperui' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
    ...overrides,
  };
}

async function setup(item: ResourceResult) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<!doctype html><html><head></head><body><input aria-label="Name"></body></html>', { headers: { 'content-type': 'text/html' } }))));
  vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: item, sourceStatus: { sourceId: item.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
  render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={item} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Enlarge preview' });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('Enlarge viewport controls', () => {
  it('appear only while enlarged, labelled, with Fit selected and every required width', async () => {
    await setup(resource());
    expect(screen.queryByRole('group', { name: 'Viewport width' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    const dialog = screen.getByRole('dialog', { name: 'Charts' });
    const group = within(dialog).getByRole('group', { name: 'Viewport width' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Fit', '320 px', '375 px', '768 px', '1024 px', '1440 px']);
    expect(within(group).getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  it('resizes the same document without reloading it, and keeps the width across restore and re-enlarge', async () => {
    await setup(resource());
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    const frame = document.querySelector('iframe')!;
    const srcDoc = frame.getAttribute('srcdoc');
    const group = screen.getByRole('group', { name: 'Viewport width' });
    for (const width of [320, 375, 768, 1024, 1440]) {
      fireEvent.click(within(group).getByRole('button', { name: `${width} px` }));
      expect(within(group).getByRole('button', { name: `${width} px` }).getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector('iframe')).toBe(frame);
      expect(frame.getAttribute('srcdoc')).toBe(srcDoc);
      expect(frame.style.width).toBe(`${width}px`);
      expect(frame.closest('[data-preview-viewport]')!.getAttribute('data-preview-viewport')).toBe(String(width));
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(within(group).getByRole('button', { name: '375 px' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Compact view always fits its panel.
    expect(frame.style.width).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(within(screen.getByRole('group', { name: 'Viewport width' })).getByRole('button', { name: '375 px' }).getAttribute('aria-pressed')).toBe('true');
    expect(frame.style.width).toBe('375px');
    fireEvent.click(within(screen.getByRole('group', { name: 'Viewport width' })).getByRole('button', { name: 'Fit' }));
    expect(frame.style.width).toBe('');
  });

  it('is not offered for previews that are not HTML documents', async () => {
    await setup(resource({ category: 'image', previewCapability: { available: true, kind: 'reference', url: '/api/library/photo.png', reason: null } }));
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(screen.queryByRole('group', { name: 'Viewport width' })).toBeNull();
  });

  it('routes a video item without an HTML preview to the native player inside the same shell', async () => {
    await setup(resource({ category: 'video', previewCapability: { available: true, kind: 'video', url: '/api/library/assets/clip/raw', reason: null } }));
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(within(screen.getByRole('dialog')).getByTestId('workbench-video-preview')).toBeTruthy();
  });
});
