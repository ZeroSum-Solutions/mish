// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchImprovePrompt } from '../../../src/components/workbench/WorkbenchImprovePrompt';
import { homeBriefPreview } from '../../helpers/home-brief-preview';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function open(onClose = vi.fn()) {
  const view = render(<I18nProvider initial="en"><WorkbenchImprovePrompt draft="A bakery site" onClose={onClose} /></I18nProvider>);
  await act(async () => { await Promise.resolve(); });
  return { ...view, onClose };
}

it.each(['Escape', 'backdrop', 'Cancel'])('aborts the preview immediately on %s, before the owner unmounts', async how => {
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
    signal = init.signal!;
    return new Promise(() => {});
  }));
  const view = await open();
  if (how === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
  else if (how === 'backdrop') fireEvent.click(screen.getByRole('presentation'));
  else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(view.onClose).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(true);
});

it('shows a calm busy state and retries once after two seconds', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(homeBriefPreview)));
  vi.stubGlobal('fetch', request);
  await open();
  expect(screen.getByRole('status')).toHaveTextContent('Still finishing the last preview…');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Use prompt' })).toBeInTheDocument();
});

it('stops after one busy retry and cancels a scheduled retry on dismiss', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }));
  vi.stubGlobal('fetch', request);
  const first = await open();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Still finishing the last preview…');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(request).toHaveBeenCalledTimes(2);
  first.unmount();
  await open();
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(request).toHaveBeenCalledTimes(3);
});

it('offers an explicit retry after the previous preview stays busy, without duplicate turns', async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const request = vi.fn()
    .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }))
    .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', request);
  const onUsePreview = vi.fn();
  render(<I18nProvider initial="en"><WorkbenchImprovePrompt draft="A bakery site" onUsePreview={onUsePreview} onClose={vi.fn()} /></I18nProvider>);
  await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(2000); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('improve-prompt-original')).toHaveTextContent('A bakery site');
  expect(onUsePreview).not.toHaveBeenCalled();
  const retry = screen.getByRole('button', { name: 'Retry' });
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry); });
  expect(request).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await act(async () => { finish(new Response(JSON.stringify(homeBriefPreview))); });
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Keep my explicit library direction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save edits' }));
  expect(screen.getByLabelText('Purpose')).toHaveValue('Keep my explicit library direction');
  fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
  expect(onUsePreview).toHaveBeenCalledWith(expect.objectContaining({ purpose: { value: 'Keep my explicit library direction', basis: 'user' } }));
});

it('aborts an explicit retry on dismiss and schedules no further turns', async () => {
  vi.useFakeTimers();
  let retrySignal!: AbortSignal;
  const request = vi.fn()
    .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }))
    .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'transformer-busy', message: 'busy' } }), { status: 503 }))
    .mockImplementationOnce((_url, init: RequestInit) => { retrySignal = init.signal!; return new Promise<Response>(() => {}); });
  vi.stubGlobal('fetch', request);
  const view = await open();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retrySignal.aborted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(retrySignal.aborted).toBe(true);
  expect(view.onClose).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(request).toHaveBeenCalledTimes(3);
});

it('cancels the project brief on the daemon when the dialog closed before the create answered', async () => {
  let answerCreate!: (response: Response) => void;
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url === '/api/workbench/briefs') return new Promise<Response>(resolve => { answerCreate = resolve; });
    return Promise.resolve(new Response(JSON.stringify({ id: 'brief_1', projectId: 'p', status: 'cancelled', originalText: 'A bakery site', brief: null, failure: null, revisions: [], createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z' })));
  }));
  const onClose = vi.fn();
  const view = render(<I18nProvider initial="en"><WorkbenchImprovePrompt projectId="p" draft="A bakery site" onClose={onClose} pollMs={1} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => {
    answerCreate(new Response(JSON.stringify({ id: 'brief_1', projectId: 'p', status: 'pending', originalText: 'A bakery site', brief: null, failure: null, revisions: [], createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z' }), { status: 202 }));
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  expect(calls).toContainEqual({ url: '/api/workbench/briefs/brief_1/cancel?projectId=p', method: 'POST' });
  expect(calls.filter(call => call.url.startsWith('/api/workbench/briefs/brief_1?'))).toHaveLength(0);
});
