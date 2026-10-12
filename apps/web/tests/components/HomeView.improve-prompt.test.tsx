// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { homeBriefPreview as preview } from '../helpers/home-brief-preview';
import { HomeView } from '../../src/components/HomeView';
import type { PluginLoopSubmit } from '../../src/components/PluginLoopHome';
import { I18nProvider } from '../../src/i18n';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';
import type { useWorkbenchIntake } from '../../src/components/WorkbenchIntake';

let intake: ReturnType<typeof useWorkbenchIntake> = null;
vi.mock('../../src/components/WorkbenchIntake', async original => ({
  ...(await original<typeof import('../../src/components/WorkbenchIntake')>()),
  useWorkbenchIntake: () => intake,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({ PlaceholderCarousel: () => null }));
vi.mock('../../src/collab/useWorkspaceContext', async (original) => ({
  ...(await original<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({ context: null, loading: false, failure: 'unsupported' }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); intake = null; });
function home() {
  writeHomeGuideStage('done');
  const projects: string[] = [];
  let finishGenerate!: () => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/plugins') return new Response(JSON.stringify({ plugins: [] }));
    if (url === '/api/workbench/briefs/preview') return new Promise<Response>(resolve => {
      finishGenerate = () => resolve(new Response(JSON.stringify(preview)));
    });
    throw new Error(`unexpected fetch ${url}`);
  }));
  const onSubmit = vi.fn(async (payload: PluginLoopSubmit) => {
    projects.push('project_1');
    return true;
  });
  const view = render(<I18nProvider initial="en"><HomeView projects={[]} onSubmit={onSubmit} onOpenProject={vi.fn()} onViewAllProjects={vi.fn()} /></I18nProvider>);
  return { onSubmit, projects, finish: () => finishGenerate(), view };
}
async function open() {
  await screen.findByTestId('home-hero-input');
  setHomeHeroPrompt('A bakery site');
  fireEvent.click(screen.getByTestId('home-improve-prompt-button'));
  await screen.findByTestId('improve-prompt');
}
it('creates zero projects while open, after generate and after dismiss; exactly one after Accept then Run', async () => {
  const h = home();
  await open();
  expect(h.projects).toHaveLength(0);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/workbench/briefs/preview', expect.anything()));
  h.finish();
  await screen.findByText('Opening hours were not given');
  expect(h.projects).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Keep original' }));
  expect(h.projects).toHaveLength(0);
  expect(screen.getByTestId('home-hero-input')).toHaveTextContent('A bakery site');
  fireEvent.click(screen.getByTestId('home-improve-prompt-button'));
  await screen.findByTestId('improve-prompt');
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/workbench/briefs/preview')).toHaveLength(2));
  h.finish();
  await screen.findByText('Opening hours were not given');
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'Take cake orders' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
  await screen.findByTestId('home-improve-prompt-attached');
  expect(h.projects).toHaveLength(0);
  expect(screen.getByTestId('home-improve-prompt-attached')).toHaveTextContent('Brief revision 2 attached');
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await waitFor(() => expect(h.projects).toHaveLength(1));
  expect(h.onSubmit).toHaveBeenCalledTimes(1);
  expect(h.onSubmit.mock.calls[0]![0]).toMatchObject({ prompt: 'A bakery site', acceptedBrief: { purpose: { value: 'Take cake orders', basis: 'user' } } });
});
it('leaves no project when the tab unmounts during generation', async () => {
  const h = home(); await open();
  expect(h.projects).toHaveLength(0);
  h.view.unmount();
  expect(h.projects).toHaveLength(0);
});

it('dismisses the captured intake rows only after a successful send', async () => {
  const files = [{ batchId: 'batch', clientFileId: 'sent', filename: 'sent.txt', size: 1 }];
  const finishHomeSend = vi.fn();
  intake = {
    target: { destination: { kind: 'pending' }, context: null }, pendingIds: ['batch'], pendingMessageFiles: files, finishHomeSend,
    add: vi.fn(), acceptDrop: vi.fn(), removePending: vi.fn(), attached: [], handoffPending: false, startDropMode: vi.fn(), coordinator: {} as never,
  };
  const h = home();
  await screen.findByTestId('home-hero-input');
  setHomeHeroPrompt('A bakery site');
  h.onSubmit.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await screen.findByRole('alert');
  expect(finishHomeSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await waitFor(() => expect(finishHomeSend).toHaveBeenCalledWith(files));
  expect(h.onSubmit.mock.calls[1]![0].intakeBatchIds).toEqual(['batch']);
});
it('detaches the accepted preview after editing the draft', async () => {
  const h = home(); await open(); h.finish();
  fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
  await screen.findByTestId('home-improve-prompt-attached');
  setHomeHeroPrompt('A florist site');
  expect(screen.queryByTestId('home-improve-prompt-attached')).toBeNull();
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await waitFor(() => expect(h.onSubmit).toHaveBeenCalledTimes(1));
  expect(h.onSubmit.mock.calls[0]![0]).toMatchObject({ prompt: 'A florist site' });
  expect(h.onSubmit.mock.calls[0]![0]).not.toHaveProperty('acceptedBrief');
});
it('keeps the accepted preview after a rejected send so it can retry', async () => {
  const h = home(); await open(); h.finish();
  fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
  await screen.findByTestId('home-improve-prompt-attached');
  h.onSubmit.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await screen.findByRole('alert');
  expect(screen.getByTestId('home-improve-prompt-attached')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  await waitFor(() => expect(h.onSubmit).toHaveBeenCalledTimes(2));
  expect(h.onSubmit.mock.calls[1]![0].acceptedBrief).toEqual(h.onSubmit.mock.calls[0]![0].acceptedBrief);
});
it('refuses a stale accepted preview when Home attachments change', async () => {
  const h = home(); await open(); h.finish();
  fireEvent.click(await screen.findByRole('button', { name: 'Use prompt' }));
  await screen.findByTestId('home-improve-prompt-attached');
  fireEvent.change(screen.getByTestId('home-hero-file-input'), { target: { files: [new File(['new'], 'new.txt', { type: 'text/plain' })] } });
  fireEvent.click(screen.getByTestId('home-hero-submit'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The Home setup changed');
  expect(h.projects).toHaveLength(0);
});
