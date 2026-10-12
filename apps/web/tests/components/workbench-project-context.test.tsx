// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseProjectDesignContextDraft, parseProjectRubricDraft, type ProjectDesignContextSnapshot, type ProjectRubricDraft, type ProjectRubricSnapshot } from '@mish/contracts';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';
import { I18nProvider } from '../../src/i18n';
import { WorkbenchProjectContext } from '../../src/components/workbench/WorkbenchProjectContext';
import * as api from '../../src/providers/workbench';
vi.mock('../../src/providers/workbench', async original => ({ ...await original<typeof import('../../src/providers/workbench')>(), getProjectDesignContext: vi.fn(), getProjectRubric: vi.fn(), putProjectDesignContext: vi.fn(), putProjectRubric: vi.fn() }));
const draft = { purpose: null, audience: [], conversions: [], brandDirection: null, constraints: [], factSources: [], assumptions: ['Purpose, audience and brand are unknown'] };
function context(purpose: string | null = null, revision = 1, projectId = 'p'): ProjectDesignContextSnapshot {
 return { projectId, revision, context: { ...draft, purpose, factSources: purpose ? [{ fieldPath: '/purpose', value: purpose, origin: 'inferred', source: null, confidence: 0.5, rationale: 'Imported suggestion' }] : [], schema: 'workbench-context/1', projectId, revision, updatedAt: '2026-10-03T16:00:00.000Z' } };
}
beforeEach(() => { vi.mocked(api.getProjectDesignContext).mockImplementation(async projectId => ({ projectId, revision: 0, context: null })); vi.mocked(api.getProjectRubric).mockImplementation(async projectId => ({ projectId, revision: 0, rubric: null, linkage: null })); });
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); vi.resetAllMocks(); });
const view = (projectId = 'p') => <I18nProvider initial="en"><WorkbenchProjectContext projectId={projectId} onClose={vi.fn()} onContextSaved={vi.fn()} /></I18nProvider>;
it('saves explicit goals with truthful provenance and displays mandatory checks as pending', async () => {
 vi.mocked(api.putProjectDesignContext).mockResolvedValue(context('Book appointments'));
 render(view()); const purpose = await screen.findByRole('textbox', { name: 'Project purpose' });
 fireEvent.change(purpose, { target: { value: 'Book appointments' } }); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
 await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalled());
 const input = vi.mocked(api.putProjectDesignContext).mock.calls[0]![1];
 expect(input.expectedRevision).toBe(0); expect(parseProjectDesignContextDraft(input.draft).purpose).toBe('Book appointments');
 expect(input.draft.factSources).toContainEqual(expect.objectContaining({ fieldPath: '/purpose', origin: 'user-confirmed', source: null, value: 'Book appointments' }));
 expect(screen.getByText('Text contrast — verification pending')).toBeTruthy();
});
it('preserves a losing goals draft and uses authorized conflict revision for explicit retry', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Suggested goal'));
 vi.mocked(api.putProjectDesignContext).mockRejectedValueOnce(Object.assign(new api.WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current: context('Other editor goal', 2) })).mockResolvedValue(context('My goal', 3));
 render(view()); const purpose = await screen.findByRole('textbox', { name: 'Project purpose' }); fireEvent.change(purpose, { target: { value: 'My goal' } });
 fireEvent.click(screen.getByRole('button', { name: 'Save project goals' })); await screen.findByText(/Unsaved goals/);
 expect(purpose).toHaveValue('My goal'); expect(screen.getByText(/Saved revision: 2/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Retry goals' }));
 await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenLastCalledWith('p', expect.objectContaining({ expectedRevision: 2, draft: expect.objectContaining({ purpose: 'My goal' }) }), undefined));
});
it('retains imported facts on an untouched save, and preserves Windows95 and no-motion intent', async () => {
 const saved = context('Suggested goal'); saved.context!.styleDirection = 'Windows95'; saved.context!.constraints = [{ id: 'motion', kind: 'motion', value: 'none' }];
 saved.context!.factSources.push({ fieldPath: '/styleDirection', value: 'Windows95', origin: 'imported', source: { assetId: 'a' }, confidence: null, rationale: 'Original reference' }, { fieldPath: '/constraints/0/value', value: 'none', origin: 'user-confirmed', source: null, confidence: null, rationale: 'No motion' });
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(saved); vi.mocked(api.putProjectDesignContext).mockResolvedValue(saved);
 render(view()); await screen.findByDisplayValue('Windows95'); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
 await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalled());
 expect(vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft).toMatchObject({ styleDirection: 'Windows95', constraints: [{ kind: 'motion', value: 'none' }] });
 expect(vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft.factSources).toEqual(expect.arrayContaining(saved.context!.factSources));
});
it('shows stale rubric linkage without silently retargeting it; explicit rubric save before goals exposes422', async () => {
 vi.mocked(api.putProjectRubric).mockRejectedValue(new api.WorkbenchRequestError(422, 'VALIDATION_FAILED', 'Invalid reference'));
 render(view()); await screen.findByRole('button', { name: 'Save rubric' }); fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
 await screen.findByText('Save project goals first.'); expect(api.putProjectRubric).toHaveBeenCalled();
});
it('discards an old project read while retaining only the new project editor', async () => {
 let finish!: (value: ProjectDesignContextSnapshot) => void;
 vi.mocked(api.getProjectDesignContext).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(context('New scope', 1, 'q'));
 const rendered = render(view()); await waitFor(() => expect(api.getProjectDesignContext).toHaveBeenCalled()); rendered.rerender(view('q'));
 await screen.findByDisplayValue('New scope'); finish(context('Old scope'));
 await waitFor(() => expect(screen.queryByDisplayValue('Old scope')).toBeNull());
});
it('saves a manual declaration, preserves stale linkage until an explicit relink, and keeps all core checks pending', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Current goals', 2));
 vi.mocked(api.getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 1, rubric: { projectId: 'p', schema: 'workbench-rubric/1', revision: 1, updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [] }, linkage: { state: 'stale', referencedContextRevision: 1, currentContextRevision: 2 } });
 vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ projectId: 'p', revision: 2, rubric: { ...input.draft, schema: 'workbench-rubric/1', projectId: 'p', revision: 2, updatedAt: '2026-10-03T16:00:00.000Z' }, linkage: { state: 'stale', referencedContextRevision: 1, currentContextRevision: 2 } }));
 render(view()); await screen.findByText(/Rubric still refers to earlier goals/);
 fireEvent.change(screen.getByRole('combobox', { name: 'New check type' }), { target: { value: 'manual' } }); fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
 fireEvent.change(screen.getByRole('textbox', { name: 'Manual procedure' }), { target: { value: 'Use keyboard only to book' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Test environment' }), { target: { value: 'Windows95 target' } });
 fireEvent.click(screen.getByRole('button', { name: 'Save rubric' })); await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalled());
 expect(vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft).toMatchObject({ contextRevision: 1, checks: [{ kind: 'manual', required: false, parameters: { procedure: 'Use keyboard only to book', environment: 'Windows95 target' } }] });
 expect(screen.getByText('Keyboard and focus — verification pending')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Link to current goals' })); expect(screen.queryByText(/Rubric still refers to earlier goals/)).toBeNull();
});
it('keeps the losing rubric criteria on409 and explicitly reloads only its saved draft', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
 const current = { projectId: 'p', revision: 2, rubric: { projectId: 'p', schema: 'workbench-rubric/1' as const, revision: 2, updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [] }, linkage: { state: 'current' as const, referencedContextRevision: 1, currentContextRevision: 1 } };
 vi.mocked(api.putProjectRubric).mockRejectedValue(Object.assign(new api.WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current }));
 render(view()); await screen.findByRole('button', { name: 'Add check' }); fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
 const criterion = screen.getByRole('textbox', { name: 'Quality criterion' }); fireEvent.change(criterion, { target: { value: 'Keep the original brand voice' } }); fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
 await screen.findByText(/Unsaved rubric/); expect(criterion).toHaveValue('Keep the original brand voice'); expect(screen.getByText(/Saved revision: 2/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Reload saved rubric' })); expect(screen.queryByRole('textbox', { name: 'Quality criterion' })).toBeNull(); expect(screen.getByRole('textbox', { name: 'Project purpose' })).toHaveValue('Goals');
});
it('keeps a trailing audience line usable and saves its normalized values with exact provenance', async () => {
 vi.mocked(api.putProjectDesignContext).mockResolvedValue(context()); render(view());
 const audience = await screen.findByRole('textbox', { name: 'Audience (one per line)' }); fireEvent.change(audience, { target: { value: 'Patients\n' } }); expect(audience).toHaveValue('Patients\n');
 fireEvent.change(audience, { target: { value: 'Patients\nFamilies' } }); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' })); await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalled());
 const saved = vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft; expect(parseProjectDesignContextDraft(saved).audience).toEqual(['Patients','Families']); expect(saved.factSources).toContainEqual(expect.objectContaining({ fieldPath: '/audience/1', value: 'Families' }));
});
it('discards a late save after the same-project account changes, including callbacks and settlement', async () => {
 let finish!: (value: ProjectDesignContextSnapshot) => void; const callback = vi.fn();
 vi.mocked(api.getProjectDesignContext).mockResolvedValueOnce(context('Old account goal')).mockResolvedValue(context('New account goal'));
 vi.mocked(api.putProjectDesignContext).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 const node = () => <I18nProvider initial="en"><WorkbenchProjectContext projectId="p" onClose={vi.fn()} onContextSaved={callback} /></I18nProvider>;
 const rendered = render(node()); await screen.findByDisplayValue('Old account goal'); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
 advanceWorkspaceAccountGeneration('account-switched'); rendered.rerender(node()); await screen.findByDisplayValue('New account goal'); finish(context('Late old save', 2));
 await waitFor(() => expect(screen.queryByDisplayValue('Late old save')).toBeNull()); expect(callback).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Save project goals' })).not.toBeDisabled();
});
it('remaps untouched imported constraint provenance after removing an earlier constraint', async () => {
 const saved = context('Goals'); saved.context!.constraints = [{ id: 'old', kind: 'other', value: 'Remove me' }, { id: 'runtime', kind: 'runtime', value: 'Windows95 browser' }];
 saved.context!.factSources.push({ fieldPath: '/constraints/0/value', value: 'Remove me', origin: 'user-confirmed', source: null, confidence: null, rationale: 'Old constraint' }, { fieldPath: '/constraints/1/value', value: 'Windows95 browser', origin: 'imported', source: { assetId: 'runtime-reference' }, confidence: null, rationale: 'Exact source' });
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(saved); vi.mocked(api.putProjectDesignContext).mockResolvedValue(saved);
 render(view()); const removed = await screen.findByDisplayValue('Remove me'); fireEvent.click(within(removed.closest('label')!).getByRole('button', { name: 'Remove' })); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
 await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalled());
 expect(vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft.factSources).toContainEqual(expect.objectContaining({ fieldPath: '/constraints/0/value', value: 'Windows95 browser', origin: 'imported', source: { assetId: 'runtime-reference' } }));
});
it('shows provenance for the edited draft value before saving', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Suggested goal')); render(view());
 const purpose = await screen.findByRole('textbox', { name: 'Project purpose' }); fireEvent.change(purpose, { target: { value: 'Explicit goal' } }); fireEvent.click(screen.getByText('Facts and their origins'));
 expect(screen.getByText(/Explicit goal · Confirmed/)).toBeTruthy(); expect(screen.queryByText(/Suggested goal · Suggestion/)).toBeNull();
});
it('reloads authorized goals after conflict while retaining the separate rubric draft', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Original goals')); vi.mocked(api.putProjectDesignContext).mockRejectedValue(Object.assign(new api.WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current: context('Authorized saved goals', 2) })); render(view());
 const purpose = await screen.findByRole('textbox', { name: 'Project purpose' }); fireEvent.change(purpose, { target: { value: 'Losing goals' } }); fireEvent.click(screen.getByRole('button', { name: 'Add check' })); fireEvent.change(screen.getByRole('textbox', { name: 'Quality criterion' }), { target: { value: 'Keep my rubric draft' } }); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' })); await screen.findByText(/Unsaved goals/);
 fireEvent.click(screen.getByRole('button', { name: 'Reload saved goals' })); expect(purpose).toHaveValue('Authorized saved goals'); expect(screen.getByRole('textbox', { name: 'Quality criterion' })).toHaveValue('Keep my rubric draft'); expect(screen.getByText(/Rubric still refers to earlier goals/)).toBeTruthy();
});
it('remaps source-bound audience annotations after an explicit line reorder', async () => {
 const saved = context('Goals'); saved.context!.audience = ['Patients', 'Families']; saved.context!.factSources.push({ fieldPath: '/audience/0', value: 'Patients', origin: 'inferred', source: null, confidence: 0.5, rationale: 'Audience suggestion' }, { fieldPath: '/audience/1', value: 'Families', origin: 'imported', source: { assetId: 'brief' }, confidence: null, rationale: 'Brief audience' }); vi.mocked(api.getProjectDesignContext).mockResolvedValue(saved); vi.mocked(api.putProjectDesignContext).mockResolvedValue(saved);
 render(view()); fireEvent.change(await screen.findByRole('textbox', { name: 'Audience (one per line)' }), { target: { value: 'Families\nPatients' } }); fireEvent.click(screen.getByRole('button', { name: 'Save project goals' })); await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalled());
 expect(vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft.factSources).toContainEqual(expect.objectContaining({ fieldPath: '/audience/0', value: 'Families', origin: 'imported', source: { assetId: 'brief' } }));
});

it.each(['imported', 'inferred'] as const)('preserves %s rubric provenance through ordinary edits until explicit acceptance', async origin => {
 const check: ProjectRubricDraft['checks'][number] = { checkId: 'derived-check', kind: 'judgment', required: false,
   severity: 'medium', requiredBasis: null, provenance: { origin, derivation: 'brand-analysis', source: { assetId: 'brand-brief' }, rationale: 'Derived from the exact brand brief' },
   sourceCriteria: [], evidenceTypes: ['judgment-rationale'], intent: 'Original intent', parameters: { type: 'criterion', criterion: 'Keep the calm brand voice' } };
 const saved: ProjectRubricSnapshot = { projectId: 'p', revision: 1, rubric: { schema: 'workbench-rubric/1', projectId: 'p', revision: 1,
   updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [check] }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } };
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
 vi.mocked(api.getProjectRubric).mockResolvedValue(saved);
 vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ ...saved, revision: 2, rubric: { ...saved.rubric!, ...input.draft, revision: 2 } }));
 render(view());
 fireEvent.change(await screen.findByRole('textbox', { name: 'Quality criterion' }), { target: { value: 'Use the calm voice in each heading' } });
 fireEvent.change(screen.getByRole('textbox', { name: 'Check intent' }), { target: { value: 'Check the heading voice' } });
 fireEvent.change(screen.getByRole('combobox', { name: 'Severity' }), { target: { value: 'high' } });
 fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
 await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(1));
 const edited = vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft;
 expect(edited.checks[0]).toMatchObject({ required: false, requiredBasis: null, severity: 'high', intent: 'Check the heading voice', parameters: { criterion: 'Use the calm voice in each heading' } });
 expect(edited.checks[0]!.provenance).toEqual(check.provenance);
 expect(() => parseProjectRubricDraft({ ...edited, checks: [{ ...edited.checks[0], required: true, requiredBasis: { type: 'project-acceptance', requirementId: check.checkId, rationale: 'Unaccepted proposal' } }] })).toThrow();
 await waitFor(() => expect(screen.getByRole('button', { name: 'Save rubric' })).toBeEnabled());
 fireEvent.click(screen.getByRole('checkbox', { name: 'Required for project acceptance' }));
 fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
 await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(2));
 const accepted = vi.mocked(api.putProjectRubric).mock.calls[1]![1].draft;
 expect(accepted.checks[0]).toMatchObject({ required: true, requiredBasis: { type: 'project-acceptance', requirementId: check.checkId }, provenance: {
   ...check.provenance, origin: 'user-confirmed', rationale: 'Explicitly required for project acceptance',
 } });
 expect(parseProjectRubricDraft(accepted)).toEqual(accepted);
});

it.each(['imported', 'inferred'] as const)('restores optional %s provenance when acceptance is checked and withdrawn before save', async origin => {
  const check: ProjectRubricDraft['checks'][number] = { checkId: 'withdrawn-check', kind: 'judgment', required: false,
    severity: 'medium', requiredBasis: null, provenance: { origin, derivation: 'brand-analysis', source: { assetId: 'brand-brief' }, rationale: 'Derived from the exact brand brief' },
    sourceCriteria: [], evidenceTypes: ['judgment-rationale'], parameters: { type: 'criterion', criterion: 'Keep the calm brand voice' } };
  const saved: ProjectRubricSnapshot = { projectId: 'p', revision: 1, rubric: { schema: 'workbench-rubric/1', projectId: 'p', revision: 1,
    updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [check] }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } };
  vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
  vi.mocked(api.getProjectRubric).mockResolvedValue(saved);
  vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ ...saved, revision: 2, rubric: { ...saved.rubric!, ...input.draft, revision: 2 } }));
  render(view());
  const required = await screen.findByRole('checkbox', { name: 'Required for project acceptance' });
  fireEvent.click(required); fireEvent.click(required);
  fireEvent.change(screen.getByRole('textbox', { name: 'Quality criterion' }), { target: { value: 'Keep the headings calm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
  await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft;
  expect(sent.checks[0]).toMatchObject({ required: false, requiredBasis: null, parameters: { criterion: 'Keep the headings calm' } });
  expect(sent.checks[0]!.provenance).toEqual(check.provenance);
  expect(parseProjectRubricDraft(sent)).toEqual(sent);
});

it('withdraws a saved acceptance without continuing to claim the optional check is required', async () => {
  const check: ProjectRubricDraft['checks'][number] = { checkId: 'saved-acceptance', kind: 'judgment', required: true,
    severity: 'medium', requiredBasis: { type: 'project-acceptance', requirementId: 'saved-acceptance', rationale: 'Explicitly required for project acceptance' },
    provenance: { origin: 'user-confirmed', derivation: 'brand-analysis', source: { assetId: 'brand-brief' }, rationale: 'Explicitly required for project acceptance' },
    sourceCriteria: [], evidenceTypes: ['judgment-rationale'], parameters: { type: 'criterion', criterion: 'Keep the calm brand voice' } };
  const saved: ProjectRubricSnapshot = { projectId: 'p', revision: 1, rubric: { schema: 'workbench-rubric/1', projectId: 'p', revision: 1,
    updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [check] }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } };
  vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
  vi.mocked(api.getProjectRubric).mockResolvedValue(saved);
  vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ ...saved, revision: 2, rubric: { ...saved.rubric!, ...input.draft, revision: 2 } }));
  render(view());
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Required for project acceptance' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
  await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft;
  expect(sent.checks[0]).toMatchObject({ required: false, requiredBasis: null, provenance: { origin: 'user-confirmed', derivation: 'brand-analysis', source: check.provenance.source } });
  expect(sent.checks[0]!.provenance.rationale).not.toContain('Explicitly required');
  expect(parseProjectRubricDraft(sent)).toEqual(sent);
});

it('keeps local provenance when a conflict snapshot has an imported check with the same id', async () => {
  const foreign: ProjectRubricDraft['checks'][number] = { checkId: 'check-1', kind: 'judgment', required: false,
    severity: 'medium', requiredBasis: null, provenance: { origin: 'imported', derivation: 'brand-analysis', source: { assetId: 'foreign-brief' }, rationale: 'Other editor reference' },
    sourceCriteria: [], evidenceTypes: ['judgment-rationale'], parameters: { type: 'criterion', criterion: 'Other editor criterion' } };
  const current: ProjectRubricSnapshot = { projectId: 'p', revision: 2, rubric: { schema: 'workbench-rubric/1', projectId: 'p', revision: 2,
    updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [foreign] }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } };
  vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
  vi.mocked(api.putProjectRubric).mockRejectedValueOnce(Object.assign(new api.WorkbenchRequestError(409, 'CONFLICT', 'Changed'), { current }))
    .mockImplementation(async (_id, input) => ({ ...current, revision: 3, rubric: { ...current.rubric!, ...input.draft, revision: 3 } }));
  render(view()); await screen.findByRole('button', { name: 'Add check' });
  fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Quality criterion' }), { target: { value: 'My local criterion' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save rubric' })); await screen.findByText(/Unsaved rubric/);
  const required = screen.getByRole('checkbox', { name: 'Required for project acceptance' });
  fireEvent.click(required); fireEvent.click(required); fireEvent.click(screen.getByRole('button', { name: 'Retry rubric' }));
  await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(2));
  const sent = vi.mocked(api.putProjectRubric).mock.calls[1]![1];
  expect(sent.expectedRevision).toBe(2);
  expect(sent.draft.checks[0]).toMatchObject({ checkId: foreign.checkId, required: false, requiredBasis: null,
    parameters: { criterion: 'My local criterion' }, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null } });
  expect(parseProjectRubricDraft(sent.draft)).toEqual(sent.draft);
});

it('keeps a recreated check independent of the removed check provenance', async () => {
  const removed: ProjectRubricDraft['checks'][number] = { checkId: 'check-1', kind: 'manual', required: false,
    severity: 'medium', requiredBasis: null, provenance: { origin: 'imported', derivation: 'brand-analysis', source: { assetId: 'removed-brief' }, rationale: 'Removed reference' },
    sourceCriteria: [], evidenceTypes: ['manual-observation'], parameters: { type: 'manual-procedure', procedure: 'Old procedure', environment: 'Old environment' } };
  const saved: ProjectRubricSnapshot = { projectId: 'p', revision: 1, rubric: { schema: 'workbench-rubric/1', projectId: 'p', revision: 1,
    updatedAt: '2026-10-03T16:00:00.000Z', contextRevision: 1, checks: [removed] }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } };
  vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals')); vi.mocked(api.getProjectRubric).mockResolvedValue(saved);
  vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ ...saved, revision: 2, rubric: { ...saved.rubric!, ...input.draft, revision: 2 } }));
  render(view()); await screen.findByDisplayValue('Old procedure'); fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Quality criterion' }), { target: { value: 'A new criterion' } });
  const required = screen.getByRole('checkbox', { name: 'Required for project acceptance' });
  fireEvent.click(required); fireEvent.click(required); fireEvent.click(screen.getByRole('button', { name: 'Save rubric' }));
  await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft;
  expect(sent.checks[0]).toMatchObject({ checkId: removed.checkId, kind: 'judgment', required: false, requiredBasis: null,
    provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null } });
  expect(parseProjectRubricDraft(sent)).toEqual(sent);
});

it.each([0, 1])('preserves conversion roles and reindexes exact provenance when removing conversion %i', async removedIndex => {
 const saved = context('Goals');
 saved.context!.conversions = [
   { id: 'book', kind: 'booking', role: 'primary', label: 'Book an appointment', target: '/book' },
   { id: 'call', kind: 'call', role: 'secondary', label: 'Call the office', target: '/call' },
   { id: 'contact', kind: 'contact', role: 'secondary', label: 'Contact the office', target: '/contact' },
 ];
 const conversionFacts = saved.context!.conversions.flatMap((item, index) => (['kind', 'role', 'label', 'target'] as const).map(field => ({
   fieldPath: `/conversions/${index}/${field}`, value: item[field]!, origin: 'imported' as const,
   source: { assetId: `brief-${item.id}` }, confidence: null, rationale: `Exact ${item.id} source`,
 })));
 saved.context!.factSources.push(...conversionFacts);
 expect(parseProjectDesignContextDraft({ ...draft, purpose: saved.context!.purpose, conversions: saved.context!.conversions, factSources: saved.context!.factSources })).toBeTruthy();
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(saved);
 vi.mocked(api.putProjectDesignContext).mockResolvedValue(saved);
 render(view());
 const labels = await screen.findAllByRole('textbox', { name: 'Conversion label' });
 fireEvent.click(within(labels[removedIndex]!.closest('div')!).getByRole('button', { name: 'Remove' }));
 const primaryChoices = screen.getAllByRole('radio', { name: 'Primary conversion' });
 const survivors = saved.context!.conversions.filter((_, index) => index !== removedIndex);
 primaryChoices.forEach((choice, index) => expect(choice).toHaveProperty('checked', survivors[index]!.role === 'primary'));
 fireEvent.click(screen.getByText('Facts and their origins'));
 for (const survivor of survivors) expect(screen.getByText(`${survivor.role} · Imported · Exact ${survivor.id} source`, { exact: false })).toBeTruthy();
 if (removedIndex === 0) {
   fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
   await screen.findByRole('alert');
   expect(api.putProjectDesignContext).not.toHaveBeenCalled();
   fireEvent.click(primaryChoices[0]!);
 }
 fireEvent.click(screen.getByRole('button', { name: 'Save project goals' }));
 await waitFor(() => expect(api.putProjectDesignContext).toHaveBeenCalledTimes(1));
 const sent = vi.mocked(api.putProjectDesignContext).mock.calls[0]![1].draft;
 expect(sent.conversions).toEqual(survivors.map((item, index) => removedIndex === 0 && index === 0 ? { ...item, role: 'primary' } : item));
 for (const [index, survivor] of survivors.entries()) {
   const originalIndex = saved.context!.conversions.findIndex(item => item.id === survivor.id);
   for (const field of ['kind', 'role', 'label', 'target'] as const) {
     const fact = sent.factSources.find(item => item.fieldPath === `/conversions/${index}/${field}`);
     if (removedIndex === 0 && index === 0 && field === 'role') expect(fact).toMatchObject({ value: 'primary', origin: 'user-confirmed', source: null });
     else expect(fact).toEqual({ ...conversionFacts.find(item => item.fieldPath === `/conversions/${originalIndex}/${field}`), fieldPath: `/conversions/${index}/${field}` });
   }
 }
 expect(parseProjectDesignContextDraft(sent)).toEqual(sent);
});
it('enables the opt-in motion check and saves its chosen requirements (B4-2b)', async () => {
 vi.mocked(api.getProjectDesignContext).mockResolvedValue(context('Goals'));
 vi.mocked(api.putProjectRubric).mockImplementation(async (_id, input) => ({ projectId: 'p', revision: 1, rubric: { ...input.draft, schema: 'workbench-rubric/1', projectId: 'p', revision: 1, updatedAt: '2026-10-08T16:00:00.000Z' }, linkage: { state: 'current', referencedContextRevision: 1, currentContextRevision: 1 } }));
 render(view()); await screen.findByRole('button', { name: 'Add check' });
 fireEvent.change(screen.getByRole('combobox', { name: 'New check type' }), { target: { value: 'motion' } });
 expect(screen.getByRole('option', { name: 'Motion: pause control and reduced motion' })).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Add check' }));
 const pause = screen.getByRole('checkbox', { name: 'Require a keyboard-reachable pause, stop or hide control' });
 const reduced = screen.getByRole('checkbox', { name: 'Require a static or reduced page under reduced motion' });
 const live = screen.getByRole('checkbox', { name: 'Require a live switch to reduced motion to be honoured' });
 expect([pause, reduced, live].map(box => (box as HTMLInputElement).checked)).toEqual([true, true, true]);
 expect(screen.getByText('Motion: pause control and reduced motion · 375, 1440 px')).toBeTruthy();
 fireEvent.click(live); fireEvent.click(pause);
 // The last remaining requirement cannot be switched off: a motion check must require something.
 expect(reduced).toBeDisabled();
 fireEvent.click(screen.getByRole('button', { name: 'Save rubric' })); await waitFor(() => expect(api.putProjectRubric).toHaveBeenCalled());
 const sent = parseProjectRubricDraft(vi.mocked(api.putProjectRubric).mock.calls[0]![1].draft);
 expect(sent.checks).toEqual([expect.objectContaining({ kind: 'mechanical', required: false, requiredBasis: null, parameters: { type: 'motion', requirePauseControl: false, requireReducedMotionFallback: true, requireLivePreferenceChange: false, viewports: [375, 1440] } })]);
});
