// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';
import { installViewport } from '../helpers/viewport-media';

// Decision D13 (2026-10-09, Sol BLOCK 1): a DOCKED rail (wide viewport, open)
// is navigation, not a drawer — selection, outside presses and Escape leave it
// open. The OVERLAY presentation (the rail opened where CSS cannot dock it,
// <= 1080 px) keeps drawer dismissal.

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/messages?')) return Response.json({ messages: [], nextCursor: null, unreadCount: 0 });
    if (url.includes('/status')) return Response.json({ loggedIn: false });
    return Response.json({ items: [] });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderOverlay() {
  installViewport(1024);
  const onViewChange = vi.fn();
  function Drawer() {
    const [overlayOpen, setOverlayOpen] = useState(true);
    return <I18nProvider initial="en">
      <button data-testid="workspace-home-rail-toggle">Home toggle</button>
      <button>Outside</button>
      <EntryNavRail view="home" open={false} overlayOpen={overlayOpen} context={null}
        onViewChange={onViewChange} onNewProject={() => {}}
        onDismiss={() => setOverlayOpen(false)} />
    </I18nProvider>;
  }
  const view = render(<Drawer />);
  return { ...view, onViewChange, rail: view.container.querySelector('nav')! };
}

function renderDocked() {
  installViewport(1440);
  const onViewChange = vi.fn();
  const onDismiss = vi.fn();
  const view = render(<I18nProvider initial="en">
    <button>Outside</button>
    <EntryNavRail view="home" open context={null}
      onViewChange={onViewChange} onNewProject={() => {}} onDismiss={onDismiss} />
  </I18nProvider>);
  return { ...view, onViewChange, onDismiss, rail: view.container.querySelector('nav')! };
}

describe('docked rail', () => {
  it('stays open on an outside press', () => {
    const { rail, onDismiss } = renderDocked();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(rail.getAttribute('aria-hidden')).toBeNull();
    expect(rail.hasAttribute('inert')).toBe(false);
  });
  it('stays open after selecting a page', () => {
    const { rail, onViewChange, onDismiss } = renderDocked();
    fireEvent.click(screen.getByTestId('entry-nav-catalog'));
    expect(onViewChange).toHaveBeenCalledWith('catalog');
    expect(onDismiss).not.toHaveBeenCalled();
    expect(rail.getAttribute('aria-hidden')).toBeNull();
  });
  it('stays open on Escape', () => {
    const { rail, onDismiss } = renderDocked();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(rail.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('overlay rail', () => {
  it('closes on an outside press even when the target stops propagation', () => {
    const { rail } = renderOverlay();
    expect(rail.getAttribute('aria-hidden')).toBeNull();
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.addEventListener('pointerdown', event => event.stopPropagation());
    fireEvent.pointerDown(outside);
    expect(rail.getAttribute('aria-hidden')).toBe('true');
  });
  it('closes after selecting a page', () => {
    const { rail, onViewChange } = renderOverlay();
    fireEvent.click(screen.getByTestId('entry-nav-catalog'));
    expect(onViewChange).toHaveBeenCalledWith('catalog');
    expect(rail.getAttribute('aria-hidden')).toBe('true');
  });
  it('keeps the drawer open for internal interaction and the Home toggle press', () => {
    const { rail } = renderOverlay();
    fireEvent.pointerDown(screen.getByTestId('entry-nav-catalog'));
    fireEvent.pointerDown(screen.getByTestId('workspace-home-rail-toggle'));
    expect(rail.getAttribute('aria-hidden')).toBeNull();
  });
  it('closes on Escape', () => {
    const { rail } = renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(rail.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the drawer available while its portaled dialog owns interaction', async () => {
    const { rail } = renderOverlay();
    const opener = screen.getByTestId('entry-nav-message-center');
    fireEvent.click(opener);
    const dialog = await waitFor(() => screen.getByTestId('message-center-dialog'));
    fireEvent.pointerDown(dialog);
    expect(rail.getAttribute('aria-hidden')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('message-center-dialog')).toBeNull();
    expect(rail.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(rail.hasAttribute('inert')).toBe(false);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(rail.getAttribute('aria-hidden')).toBe('true');
  });
});
