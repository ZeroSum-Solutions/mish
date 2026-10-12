// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { ComposerPluginOption } from '../../src/components/ComposerPluginPreview';

vi.mock('../../src/components/plugins-home/cards/PreviewSurface', () => ({
  PreviewSurface: () => <iframe title="Live plugin thumbnail" />,
}));

const observers: { node: Element; callback: IntersectionObserverCallback }[] = [];
afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

it('releases a row live preview off-screen and restores it when visible again', () => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(node: Element) { observers.push({ node, callback: this.callback }); }
    disconnect() {}
  });
  render(<ComposerPluginOption
    record={{ id: 'html-plugin', title: 'HTML plugin', manifest: {} } as InstalledPluginRecord}
    locale="en" previewed={false} onPreview={vi.fn()} onPick={vi.fn()}
  />);
  const thumbnail = screen.getByTestId('composer-plugin-thumbnail');
  const observer = observers.find(({ node }) => node === thumbnail)!;
  const setVisible = (isIntersecting: boolean) => act(() => observer.callback(
    [{ target: thumbnail, isIntersecting, boundingClientRect: thumbnail.getBoundingClientRect(),
      intersectionRect: thumbnail.getBoundingClientRect(), rootBounds: null,
      intersectionRatio: isIntersecting ? 1 : 0, time: 0 }],
    {} as IntersectionObserver,
  ));
  expect(screen.queryByTitle('Live plugin thumbnail')).toBeNull();
  setVisible(true);
  expect(screen.getByTitle('Live plugin thumbnail')).toBeTruthy();
  setVisible(false);
  expect(screen.queryByTitle('Live plugin thumbnail')).toBeNull();
  setVisible(true);
  expect(screen.getByTitle('Live plugin thumbnail')).toBeTruthy();
});
