// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReferences } from '../../../src/components/workbench/WorkbenchReferences';
import { fanoutReferences } from '../../../src/providers/workbench-references';
import { referenceFanout } from '../../helpers/reference-fanout';
vi.mock('../../../src/providers/workbench-references', () => ({ fanoutReferences: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const panel = (brief = 'Dentistry website') => <I18nProvider initial="en"><WorkbenchReferences brief={brief} spineCode="TL" /></I18nProvider>;
it('calls only on request and shows links, section, score, reasons, rights and honest degradation', async () => {
  vi.mocked(fanoutReferences).mockResolvedValue(referenceFanout());
  render(panel());
  expect(fanoutReferences).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  expect(await screen.findByRole('link', { name: 'Dental practice' })).toHaveAttribute('href', 'https://refero.design/screens/1');
  expect(screen.getByText('Clear trust signals')).toBeTruthy();
  expect(screen.getByText('Score: 92/100')).toBeTruthy();
  expect(screen.getByText('Reference only')).toBeTruthy();
  expect(screen.getByText('Inspect the original; reuse rights are not granted.')).toBeTruthy();
  expect(screen.getByText(/Mobbin.*Hero.*not connected/)).toBeTruthy();
  expect(screen.getByTestId('reference-provider-notice').textContent).toBe('Usage notice\nCredit the original app.');
});
it('drops stale results and ignores a late answer after brief changes or unmount', async () => {
  let resolve!: (value: ReturnType<typeof referenceFanout>) => void;
  vi.mocked(fanoutReferences).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  expect(screen.getByRole('status')).toHaveTextContent('Finding references');
  view.rerender(panel('Plumbing website'));
  await act(async () => resolve(referenceFanout()));
  expect(screen.queryByRole('link', { name: 'Dental practice' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  view.unmount();
  await act(async () => resolve(referenceFanout()));
});
it('shows empty and readable errors without printing unknown machine codes', async () => {
  vi.mocked(fanoutReferences).mockResolvedValue({ ...referenceFanout(), references: [], ranking: { status: 'empty', model: 'jev-latest', code: null } });
  render(panel());
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  expect(await screen.findByText('No references found. Try a more specific brief.')).toBeTruthy();
  vi.mocked(fanoutReferences).mockRejectedValue(new Error('internal-machine-fault'));
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not find references. Try again.');
  expect(screen.queryByText('internal-machine-fault')).toBeNull();
});
it("renders the action and rights in English", async () => {
  vi.mocked(fanoutReferences).mockResolvedValue(referenceFanout());
  render(<I18nProvider initial="en"><WorkbenchReferences brief="Sitio of dentista" /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: "Find references" }));
  expect(await screen.findByText("Reference only")).toBeTruthy();
});
it('immediately hides captured results on sections or context changes and refuses too many sections', async () => {
  vi.mocked(fanoutReferences).mockResolvedValue(referenceFanout());
  const sections = [{ id: 'hero', name: 'Hero', purpose: null }];
  const view = render(<I18nProvider initial="en"><WorkbenchReferences brief="Dentistry" sections={sections} contextKey="saved" /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  await screen.findByRole('link', { name: 'Dental practice' });
  view.rerender(<I18nProvider initial="en"><WorkbenchReferences brief="Dentistry" sections={sections} contextKey="unsaved" /></I18nProvider>);
  expect(screen.queryByRole('link', { name: 'Dental practice' })).toBeNull();
  view.rerender(<I18nProvider initial="en"><WorkbenchReferences brief="Dentistry" sections={Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: 'Hero', purpose: null }))} /></I18nProvider>);
  expect(screen.getByRole('button', { name: 'Find references' })).toBeDisabled();
  expect(screen.getByText(/1–8 non-empty sections/)).toBeTruthy();
});

it('names TypeSafe Jev and labels deadline results as partial', async () => {
  vi.mocked(fanoutReferences).mockResolvedValue({ ...referenceFanout(), partial: true });
  render(panel());
  expect(screen.getByText(/TypeSafe Jev/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }));
  expect(await screen.findByText(/deadline.*partial/i)).toBeTruthy();
});
