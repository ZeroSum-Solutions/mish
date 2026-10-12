// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogPreviewWorkspace,
  PreviewPartsSelector,
  PreviewViewportControls,
  readPreviewContentSize,
  useCatalogPreviewStage,
  usePreviewContentHeight,
  type CatalogPreviewWidth,
} from '../../src/components/CatalogPreviewViewer';

let restoreSize: (() => void) | null = null;
function stageSize(width: number, height: number) {
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
  restoreSize = () => {
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth);
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalHeight);
  };
}

beforeEach(() => { restoreSize = null; });
afterEach(() => { restoreSize?.(); cleanup(); });

function Stage({ viewport, contentHeight }: { viewport: CatalogPreviewWidth; contentHeight?: number }) {
  const { stageRef, frameWidth, frameHeight, displayHeight, scale } = useCatalogPreviewStage(viewport, contentHeight);
  return <div ref={stageRef} data-testid="stage"><output>{`${frameWidth}/${frameHeight}/${displayHeight}/${scale}`}</output></div>;
}

describe('shared catalog viewer', () => {
  it('keeps the viewport toolbar and the same frame mounted while the preview width changes', () => {
    function Harness() {
      const [width, setWidth] = useState<CatalogPreviewWidth>('fit');
      return <CatalogPreviewWorkspace
        toolbar={<PreviewViewportControls value={width} onChange={setWidth} label="Demo width" />}
        preview={<iframe title="interactive demo" data-testid="demo" style={{ width: width === 'fit' ? '100%' : width }} />}
        details={<p>Source details</p>}
      />;
    }
    render(<Harness />);
    const toolbar = screen.getByRole('group', { name: 'Demo width' });
    expect([...toolbar.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Fit', 'Phone 390', 'Tablet 768', 'Desktop 1280']);
    const frame = screen.getByTestId('demo');
    fireEvent.click(screen.getByRole('button', { name: /Phone 390/ }));
    expect(screen.getByRole('group', { name: 'Demo width' })).toBe(toolbar);
    expect(screen.getByTestId('demo')).toBe(frame);
    expect(frame.style.width).toBe('390px');
    fireEvent.click(screen.getByRole('button', { name: /Tablet 768/ }));
    expect(screen.getByTestId('demo')).toBe(frame);
    expect(frame.style.width).toBe('768px');
    expect(screen.getByRole('button', { name: /Tablet 768/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Source details')).toBeTruthy();
  });

  it('keeps the frame viewport at the stage size and bounds only the visible box by a reported height', () => {
    stageSize(800, 600);
    const view = render(<Stage viewport={390} contentHeight={320} />);
    const stage = screen.getByTestId('stage');
    // frame width / frame layout height / visible box height / scale
    expect(screen.getByText('390/600/320/1')).toBeTruthy();
    view.rerender(<Stage viewport={390} contentHeight={4000} />);
    expect(screen.getByText('390/600/600/1')).toBeTruthy();
    view.rerender(<Stage viewport={390} contentHeight={40} />);
    expect(screen.getByText('390/600/200/1')).toBeTruthy();
    view.rerender(<Stage viewport={390} contentHeight={Number.NaN} />);
    expect(screen.getByText('390/600/600/1')).toBeTruthy();
    // A wide preset scales down; the frame keeps the stage height in its own pixels.
    view.rerender(<Stage viewport={1280} contentHeight={480} />);
    expect(screen.getByText('1280/960/300/0.625')).toBeTruthy();
    expect(screen.getByTestId('stage')).toBe(stage);
  });

  it('starts measuring when the stage mounts after the hook, as in a dialog opened later', () => {
    stageSize(700, 500);
    function Late() {
      const [open, setOpen] = useState(false);
      const { stageRef, frameWidth, frameHeight } = useCatalogPreviewStage('fit');
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        {open ? <div ref={stageRef}><output>{`${frameWidth}/${frameHeight}`}</output></div> : null}
      </>;
    }
    render(<Late />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText('700/500')).toBeTruthy();
  });

  it('reads only typed, finite, bounded sizes measured at the current frame width', () => {
    const type = 'mishh-effect-preview-size';
    expect(readPreviewContentSize({ type, width: 390, height: 280 }, type, 390)).toBe(280);
    expect(readPreviewContentSize({ type, width: 1280, height: 280 }, type, 390)).toBeNull();
    expect(readPreviewContentSize({ type: 'other', width: 390, height: 280 }, type, 390)).toBeNull();
    for (const height of [0, -2, 4097, 1.5, Infinity, Number.NaN, '280', null]) {
      expect(readPreviewContentSize({ type, width: 390, height }, type, 390)).toBeNull();
    }
    expect(readPreviewContentSize('280', type, 390)).toBeNull();
    expect(readPreviewContentSize(null, type, 390)).toBeNull();
  });

  it('keeps a reported height with its content identity only', () => {
    let report: (height: number) => void = () => {};
    function Content({ contentKey }: { contentKey: string }) {
      const [height, setHeight] = usePreviewContentHeight(contentKey);
      report = setHeight;
      return <output>{height ?? 'none'}</output>;
    }
    const view = render(<Content contentKey="a" />);
    act(() => report(320));
    expect(screen.getByText('320')).toBeTruthy();
    view.rerender(<Content contentKey="b" />);
    expect(screen.getByText('none')).toBeTruthy();
    view.rerender(<Content contentKey="a" />);
    expect(screen.getByText('320')).toBeTruthy();
  });

  it('labels family parts by relationship and selects by exact ID', () => {
    const onSelect = vi.fn();
    const onPrepare = vi.fn();
    render(<PreviewPartsSelector label="Parts" selectedId="cult:organic-dither" onSelect={onSelect} onPrepare={onPrepare} parts={[
      { id: 'cult:organic-dither', kind: 'Whole', title: 'Organic' },
      { id: 'cult:hero-page-organic-dither', kind: 'Page section', title: 'Hero' },
      { id: 'cult:animated-badge-demo', kind: 'Example', title: 'Hero' },
    ]} />);
    const group = screen.getByRole('group', { name: 'Parts' });
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Whole Organic', 'Page section Hero', 'Example Hero']);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    fireEvent.focus(buttons[2]!);
    expect(onPrepare).toHaveBeenCalledWith('cult:animated-badge-demo');
    fireEvent.click(buttons[1]!);
    expect(onSelect).toHaveBeenCalledWith('cult:hero-page-organic-dither');
  });
});
