// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseResourceSearchResponse, type ResourceResult } from '@open-design/contracts';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';
import { I18nProvider } from '../../src/i18n';
import { WorkbenchResourceSearch } from '../../src/components/workbench/WorkbenchResourceSearch';
import { searchWorkbenchResources, getWorkbenchResource, getWorkbenchPreferences, putWorkbenchPreferences, getProjectDesignContext, putProjectDesignContext, getProjectRubric, WorkbenchRequestError } from '../../src/providers/workbench';
vi.mock('../../src/providers/workbench', async (original) => ({ ...await original<typeof import('../../src/providers/workbench')>(), searchWorkbenchResources: vi.fn(), getWorkbenchResource: vi.fn(), getWorkbenchPreferences: vi.fn(), putWorkbenchPreferences: vi.fn(), getProjectDesignContext: vi.fn(), putProjectDesignContext: vi.fn(), getProjectRubric: vi.fn() }));
beforeEach(() => { vi.mocked(getWorkbenchPreferences).mockImplementation(async projectId => ({ projectId, revision: 0, preferences: null, effective: { useProjectContext: true } })); vi.mocked(getProjectDesignContext).mockImplementation(async projectId => ({ projectId, revision: 0, context: null })); vi.mocked(getProjectRubric).mockImplementation(async projectId => ({ projectId, revision: 0, rubric: null, linkage: null })); });
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); vi.clearAllMocks(); });
function item(sourceId: 'plugins' | 'genui' | 'sections'): ResourceResult {
  return { ref: { sourceType: sourceId === 'plugins' ? 'plugin' : sourceId === 'genui' ? 'genui' : 'section', sourceId, itemId: sourceId, revisionOrDigest: 'digest' }, refKey: sourceId, title: 'Same title', category: 'component', readiness: 'unverified', compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: 'Not accepted' }, rightsStatus: 'unknown', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'rights-blocked' }, adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: sourceId }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'No need decision' };
}
function result(items: ResourceResult[]) {
  return parseResourceSearchResponse({ results: items, sourceStatuses: [{ sourceId: 'react-bits', state: 'not-federated', reason: 'adapter-missing', itemCount: null, listingDigest: null }], context: { requested: true, applied: false, reason: 'context-not-implemented' }, contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null });
}
describe('Workbench Resources flyout', () => {
  it('groups duplicate titles by immutable source, exposes coverage and unavailable context', async () => {
    vi.mocked(searchWorkbenchResources).mockResolvedValue(result(['plugins', 'genui', 'sections'].map((s) => item(s as 'plugins' | 'genui' | 'sections'))));
    const selected = item('genui');
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: selected, sourceStatus: { sourceId: 'genui', state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
    render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    expect(await screen.findByRole('region', { name: 'GenUI' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Same title.*unverified/ })).toHaveLength(3);
    expect(searchWorkbenchResources).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p' }), undefined);
    expect(screen.getByText('Project context requested; not yet available.')).toHaveAttribute('data-context-applied', 'false');
    expect(screen.getByText(/react-bits: not-federated/)).toHaveTextContent('adapter-missing');
    fireEvent.click(screen.getAllByRole('button', { name: /Same title.*unverified/ })[1]!);
    expect(await screen.findByText('No need decision', { exact: false })).toBeTruthy();
    expect(getWorkbenchResource).toHaveBeenCalledWith('genui', 'p', undefined);
    // AC-R07.1: even an unrenderable (rights-blocked) entry still offers Enlarge,
    // showing a truthful explanation instead of hiding the affordance entirely.
    expect(screen.getByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
    expect(screen.getByText(/rights-blocked/)).toBeTruthy();
  });
  it('renders one result group per source present in the response, known sources first', async () => {
    const other = (sourceId: 'shadcn' | 'design-systems' | 'react-bits', title: string): ResourceResult => ({ ...item('genui'), ref: { sourceType: 'library', sourceId, itemId: sourceId, revisionOrDigest: 'digest' }, refKey: sourceId, title, category: sourceId === 'design-systems' ? 'design-system' : 'component', sourceAttribution: { title: sourceId } });
    vi.mocked(searchWorkbenchResources).mockResolvedValue(result([other('react-bits', 'Bits item'), other('design-systems', 'Neutral Product'), other('shadcn', 'Button'), item('genui')]));
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    expect(await screen.findByRole('region', { name: 'shadcn/ui' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Button.*unverified/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Neutral Product.*unverified/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bits item.*unverified/ })).toBeTruthy();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['GenUI', 'shadcn/ui', 'Design systems', 'Source: react-bits']);
  });
  it('ignores an old project response after the project scope changes', async () => {
    let resolveOld!: (value: ReturnType<typeof result>) => void;
    vi.mocked(searchWorkbenchResources).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue(result([]));
    const view = render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="old" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(1));
    view.rerender(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="new" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    await screen.findByText('No matching local resources.');
    resolveOld(result([item('genui')]));
    await waitFor(() => expect(screen.queryByText('Same title')).toBeNull());
  });
});

function preference(value: boolean, revision = 1, projectId = 'p') {
 return { projectId, revision, preferences: { schema: 'workbench-preferences/1' as const, projectId, revision, updatedAt: '2026-10-03T16:00:00.000Z', useProjectContext: value }, effective: { useProjectContext: value } };
}
it('persists default-on toggle before searching, omits override and retains query on off/reopen', async () => {
 vi.mocked(searchWorkbenchResources).mockResolvedValue(result([]));
 let finish!: (value: ReturnType<typeof preference>) => void;
 vi.mocked(putWorkbenchPreferences).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 const view = render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 const toggle = await screen.findByRole('checkbox', { name: 'Use project context' }); expect(toggle).toBeChecked();
 fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'dentistry appointment' } });
 await waitFor(() => expect(searchWorkbenchResources).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'dentistry appointment' }), undefined));
 const before = vi.mocked(searchWorkbenchResources).mock.calls.length;
 fireEvent.click(toggle);
 expect(screen.getByRole('textbox', { name: 'Search resources' })).toHaveValue('dentistry appointment');
 expect(putWorkbenchPreferences).toHaveBeenCalledWith('p', { expectedRevision: 0, useProjectContext: false }, undefined);
 await new Promise(resolve => setTimeout(resolve, 230)); expect(searchWorkbenchResources).toHaveBeenCalledTimes(before);
 finish(preference(false));
 await waitFor(() => expect(vi.mocked(searchWorkbenchResources).mock.calls.length).toBeGreaterThan(before));
 expect(vi.mocked(searchWorkbenchResources).mock.calls.at(-1)![0]).not.toHaveProperty('useProjectContext');
 view.unmount(); vi.mocked(getWorkbenchPreferences).mockResolvedValue(preference(false));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).not.toBeChecked());
});
it('preserves desired preference and query on409, displays saved choice and explicitly retries current CAS', async () => {
 vi.mocked(searchWorkbenchResources).mockResolvedValue(result([]));
 vi.mocked(putWorkbenchPreferences).mockRejectedValueOnce(Object.assign(new WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current: preference(true, 2) })).mockResolvedValue(preference(false, 3));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 const toggle = await screen.findByRole('checkbox', { name: 'Use project context' }); await waitFor(() => expect(toggle).not.toBeDisabled()); fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'keep draft query' } }); fireEvent.click(toggle);
 await screen.findByText(/Unsaved change/); expect(toggle).not.toBeChecked(); expect(screen.getByText(/Saved choice: on/)).toBeTruthy();
 expect(screen.getByRole('textbox', { name: 'Search resources' })).toHaveValue('keep draft query');
 fireEvent.click(screen.getByRole('button', { name: 'Retry my change' }));
 await waitFor(() => expect(putWorkbenchPreferences).toHaveBeenLastCalledWith('p', { expectedRevision: 2, useProjectContext: false }, undefined));
 await waitFor(() => expect(screen.queryByText(/Unsaved change/)).toBeNull());
});
it('discards search issued before a preference save and refuses mismatched preference revisions', async () => {
 let finishOld!: (value: ReturnType<typeof result>) => void;
 vi.mocked(searchWorkbenchResources).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(result([]));
 vi.mocked(putWorkbenchPreferences).mockResolvedValue(preference(false));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole('checkbox', { name: 'Use project context' }));
 await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(2));
 finishOld(result([item('genui')])); await waitFor(() => expect(screen.queryByText('Same title')).toBeNull());
});
it('refuses a completed-P2 response from a different saved preference revision and retains the query', async () => {
 const stale = parseResourceSearchResponse({ ...result([item('genui')]), excluded: [], context: { requested: true, applied: false, reason: 'context-absent', projectId: 'p', selection: 'saved', preferenceRevision: 3, observedContextRevision: 0, rankingVersion: 'local-context/1', resultMode: 'lexical' } });
 vi.mocked(searchWorkbenchResources).mockResolvedValue(stale);
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await screen.findByText(/Project settings changed/); expect(screen.queryByText('Same title')).toBeNull();
 fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'keep original query' } }); expect(screen.getByRole('textbox', { name: 'Search resources' })).toHaveValue('keep original query');
});
it('opens the actual goals sheet with the same authorized project and keeps fit evidence and source restrictions', async () => {
 const resource = { ...item('genui'), fitReasons: ['Primary booking conversion matches the booking section'] };
 vi.mocked(searchWorkbenchResources).mockResolvedValue(result([resource]));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await screen.findByText('Primary booking conversion matches the booking section');
 fireEvent.click(screen.getByRole('button', { name: 'Edit project goals and rubric' }));
 expect(await screen.findByRole('textbox', { name: 'Project purpose' })).toBeTruthy();
 expect(vi.mocked(getProjectDesignContext).mock.calls.every(([projectId]) => projectId === 'p')).toBe(true);
});
it('fences the same project after an account boundary even when context fields remain identical', async () => {
 let finish!: (value: ReturnType<typeof result>) => void;
 vi.mocked(searchWorkbenchResources).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(result([]));
 const node = <I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>;
 const rendered = render(node); await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(1));
 advanceWorkspaceAccountGeneration('new-account'); rendered.rerender(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(2)); finish(result([item('genui')])); await waitFor(() => expect(screen.queryByText('Same title')).toBeNull());
});
it('discards a late preference acknowledgement after project change without overwriting the new toggle', async () => {
 let finish!: (value: ReturnType<typeof preference>) => void; vi.mocked(putWorkbenchPreferences).mockImplementation(() => new Promise(resolve => { finish = resolve; })); vi.mocked(searchWorkbenchResources).mockResolvedValue(result([]));
 const rendered = render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).not.toBeDisabled());
 fireEvent.click(screen.getByRole('checkbox', { name: 'Use project context' }));
 rendered.rerender(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="q" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).not.toBeDisabled()); finish(preference(false));
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).toBeChecked()); expect(screen.queryByText(/Unsaved change/)).toBeNull();
});
it('discards delayed old settings before search', async () => {
 let old!: (value: ReturnType<typeof preference>) => void;
 vi.mocked(getWorkbenchPreferences).mockImplementationOnce(() => new Promise(resolve => { old = resolve; })).mockImplementation(async projectId => preference(false, 2, projectId));
 vi.mocked(searchWorkbenchResources).mockResolvedValue(result([]));
 const rendered = render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="old" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(getWorkbenchPreferences).toHaveBeenCalledWith('old', undefined));
 rendered.rerender(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="q" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).not.toBeChecked()); old(preference(true, 1, 'old'));
 await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalledTimes(1)); expect(vi.mocked(searchWorkbenchResources).mock.calls[0]![0].projectId).toBe('q');
});
it('explicitly reloads the saved preference after conflict while retaining the query', async () => {
 vi.mocked(searchWorkbenchResources).mockResolvedValue(result([])); vi.mocked(putWorkbenchPreferences).mockRejectedValue(Object.assign(new WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current: preference(true, 2) }));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).not.toBeDisabled()); fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'saved query' } }); fireEvent.click(screen.getByRole('checkbox', { name: 'Use project context' })); await screen.findByText(/Unsaved change/);
 vi.mocked(getWorkbenchPreferences).mockResolvedValue(preference(true, 2)); fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
 await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Use project context' })).toBeChecked()); expect(screen.getByRole('textbox', { name: 'Search resources' })).toHaveValue('saved query'); expect(putWorkbenchPreferences).toHaveBeenCalledTimes(1);
});
it('shows the truthful disabled lexical fallback from saved settings without a per-request override', async () => {
 vi.mocked(getWorkbenchPreferences).mockResolvedValue(preference(false, 2));
 vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({ ...result([item('genui')]), excluded: [], context: { requested: false, applied: false, reason: 'context-disabled', projectId: 'p', selection: 'saved', preferenceRevision: 2, observedContextRevision: 0, rankingVersion: 'local-context/1', resultMode: 'lexical' } }));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
 const notice = await screen.findByText('Project context is off. Showing literal matches.'); expect(notice).toHaveAttribute('data-context-applied', 'false'); expect(notice).toHaveAttribute('data-context-requested', 'false'); expect(screen.getByRole('button', { name: /Same title/ })).toBeTruthy(); expect(vi.mocked(searchWorkbenchResources).mock.calls[0]![0]).not.toHaveProperty('useProjectContext');
});
it('refuses a response whose observed goals revision differs from the loaded saved goals', async () => {
 vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({ ...result([item('genui')]), excluded: [], context: { requested: true, applied: false, reason: 'context-not-rankable', projectId: 'p', selection: 'saved', preferenceRevision: 0, observedContextRevision: 2, rankingVersion: 'local-context/1', resultMode: 'lexical' } }));
 render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>); await screen.findByText(/Project settings changed/); expect(screen.queryByText('Same title')).toBeNull();
});

it.each(['success', 'authorized409'] as const)('preserves goals saved while a delayed preference %s acknowledgement settles', async outcome => {
  const initialContext = { projectId: 'p', revision: 1, context: { schema: 'workbench-context/1' as const, projectId: 'p', revision: 1, updatedAt: '2026-10-03T16:00:00.000Z', purpose: 'Original goals', audience: [], conversions: [], brandDirection: null, constraints: [], factSources: [], assumptions: ['Other goals unknown'] } };
  vi.mocked(getProjectDesignContext).mockResolvedValue(initialContext);
  vi.mocked(putProjectDesignContext).mockImplementation(async (_projectId, input) => ({ projectId: 'p', revision: 2, context: { ...input.draft, schema: 'workbench-context/1', projectId: 'p', revision: 2, updatedAt: '2026-10-03T16:01:00.000Z' } }));
  let resolvePreference!: (value: ReturnType<typeof preference>) => void;
  let rejectPreference!: (error: Error) => void;
  vi.mocked(putWorkbenchPreferences).mockImplementationOnce(() => new Promise((resolve, reject) => { resolvePreference = resolve; rejectPreference = reject; })).mockResolvedValue(preference(false, 3));
  vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({ ...result([]), excluded: [], context: { requested: true, applied: false, reason: 'context-not-rankable', projectId: 'p', selection: 'saved', preferenceRevision: 0, observedContextRevision: 1, rankingVersion: 'local-context/1', resultMode: 'lexical' } }));
  render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
  await screen.findByText('No matching local resources.');
  fireEvent.click(screen.getByRole('button', { name: 'Edit project goals and rubric' }));
  const purpose = await screen.findByRole('textbox', { name: 'Project purpose' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Use project context' }));
  await waitFor(() => expect(putWorkbenchPreferences).toHaveBeenCalledTimes(1));
  fireEvent.change(purpose, { target: { value: 'Revision two goals' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save project goals' })).not.toBeDisabled());
  expect(putProjectDesignContext).toHaveBeenCalledWith('p', expect.objectContaining({ expectedRevision: 1, draft: expect.objectContaining({ purpose: 'Revision two goals' }) }), undefined);
  expect(searchWorkbenchResources).toHaveBeenCalledTimes(1);
  vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({ ...result([item('genui')]), excluded: [], context: { requested: false, applied: false, reason: 'context-disabled', projectId: 'p', selection: 'saved', preferenceRevision: outcome === 'success' ? 1 : 3, observedContextRevision: 2, rankingVersion: 'local-context/1', resultMode: 'lexical' } }));
  if (outcome === 'success') resolvePreference(preference(false));
  else {
    rejectPreference(Object.assign(new WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current: preference(true, 2) }));
    await screen.findByText(/Unsaved change/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry my change' }));
    await waitFor(() => expect(putWorkbenchPreferences).toHaveBeenLastCalledWith('p', { expectedRevision: 2, useProjectContext: false }, undefined));
  }
  expect(await screen.findByRole('button', { name: /Same title/ })).toBeTruthy();
  expect(screen.queryByText(/Project settings changed/)).toBeNull();
  expect(purpose).toHaveValue('Revision two goals');
  expect(vi.mocked(searchWorkbenchResources).mock.calls.at(-1)![0]).not.toHaveProperty('useProjectContext');
});
it('V06 defaults to fits, preserves the search words for Show all, and resets inspection mode per scope', async () => {
  vi.mocked(searchWorkbenchResources).mockResolvedValue(result([]));
  const view = render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
  await waitFor(() => expect(searchWorkbenchResources).toHaveBeenCalled());
  expect(screen.getByRole('checkbox', { name: 'Show all components' })).not.toBeChecked();
  expect(searchWorkbenchResources).toHaveBeenLastCalledWith(expect.objectContaining({ componentPicker: { showAll: false, mode: 'rank' } }), undefined);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: 'clinic booking' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show all components' }));
  await waitFor(() => expect(searchWorkbenchResources).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'clinic booking', componentPicker: { showAll: true, mode: 'rank' } }), undefined));
  expect(screen.getByRole('textbox', { name: 'Search resources' })).toHaveValue('clinic booking');
  view.rerender(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="other" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
  await waitFor(() => expect(searchWorkbenchResources).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'other', componentPicker: { showAll: false, mode: 'rank' } }), undefined));
});

it('V06 exposes fit status and informational acceptance in the accessible result name', async () => {
  const component = { ...item('genui'), category: 'component', componentFit: { version: 'kit-components/1', kitId: 'clinic', kitSourceId: 'design-systems', kitRevisionOrDigest: 'v1', status: 'fits', score: 30, reasons: [], acceptance: 'pending', apply: { allowed: true, blockers: [] } } };
  vi.mocked(searchWorkbenchResources).mockResolvedValue(result([component as ReturnType<typeof item>]));
  render(<I18nProvider initial="en"><WorkbenchResourceSearch projectId="p" plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
  expect(await screen.findByRole('button', { name: /Same title.*Fits active kit.*Acceptance pending/ })).toBeTruthy();
});
