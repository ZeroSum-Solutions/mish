// @vitest-environment jsdom
// AC-R04.3/AC-R04.4 — the detail panel's Apply action: prepare shows the
// declared output (files, licence notice) before anything is written, Confirm
// applies, Undo restores; missing/incompatible packages and a pending
// replacement diff are shown as the daemon reports them. `od workbench
// adoption catalogue-prepare|apply|undo` drives the same endpoints.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdoptionOperationView, CatalogueAdoptionResponse, PreparedAdoptionPlan, ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchApplyAction } from '../../../src/components/workbench/WorkbenchApplyAction';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';
import { AdoptionRequestError, applyAdoptionPlan, prepareCatalogueAdoption, undoAdoptionOperation } from '../../../src/providers/workbench-adoption';
import { copyWorkbenchCode, getAdoptionStatus } from '../../../src/providers/workbench-adoption';

vi.mock('../../../src/providers/workbench-adoption', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench-adoption')>(),
  prepareCatalogueAdoption: vi.fn(), applyAdoptionPlan: vi.fn(), undoAdoptionOperation: vi.fn(), copyWorkbenchCode: vi.fn(), getAdoptionStatus: vi.fn(),
}));
vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
vi.mocked(getAdoptionStatus).mockResolvedValue({ status: { executor: 'provisioned', placementMode: 'coordinated-open', optIn: { env: true, labs: true }, host: { platform: 'darwin', arch: 'arm64', supported: true }, gates: [] } });

const resource = (overrides: Partial<ResourceResult> = {}): ResourceResult => ({
  ref: { sourceType: 'library', sourceId: 'shadcn', itemId: 'button', revisionOrDigest: 'sha256:1' }, refKey: 'ref-key',
  title: 'Button', category: 'component', readiness: 'unverified',
  compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'compatible', reason: null },
  rightsStatus: 'permitted', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' },
  adoptionCapability: { available: true, reason: null }, sourceAttribution: { title: 'shadcn/ui · Button' },
  operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }], admissionStage: 'admitted',
  needDecision: 'justified', needReason: 'n',
  acceptanceEvidence: { sourceDigest: 'sha256:1', receiptId: 'fixture:admission', passed: true },
  componentFit: { version: 'kit-components/1', kitSourceId: 'design-systems', acceptance: 'pending', kitId: null, kitRevisionOrDigest: null, status: 'unknown', score: 0, reasons: [], apply: { allowed: true, blockers: [] } }, ...overrides,
});
const plan = { id: 'plan-1', digest: 'd'.repeat(64), projectId: 'p1' } as PreparedAdoptionPlan;
const prepared: CatalogueAdoptionResponse = { plan, catalogue: {
  refKey: 'ref-key', identity: { sourceId: 'shadcn', itemId: 'button', title: 'Button', packageName: 'shadcn/ui', sourceUrl: 'https://ui.shadcn.com/r/button.json', licence: 'MIT' },
  files: [{ path: 'src/components/ui/button.tsx', role: 'source' }, { path: 'src/components/ui/NOTICE.shadcn-button.md', role: 'notice' }, { path: 'src/App.tsx', role: 'entry' }],
  notices: ['src/components/ui/NOTICE.shadcn-button.md'], dependencies: { satisfied: [] },
} };
const operation = (kind: 'apply' | 'undo'): AdoptionOperationView => ({ operationId: `${kind}-1`, kind, planId: 'plan-1', projectId: 'p1', state: 'done', stage: 'complete', undoOf: null, undoneBy: null, reason: null, writes: [{ path: 'src/App.tsx', kind: 'replace', sha256: 'a'.repeat(64), bytes: 1 }] });
const view = (r: ResourceResult, projectId?: string) => render(<I18nProvider initial="en"><WorkbenchApplyAction resource={r} {...(projectId ? { projectId } : {})} /></I18nProvider>);

describe('WorkbenchApplyAction', () => {
  it('turns the default-runtime 422 into an Apply-off card with Copy code as its primary action', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED',
      'Adoption is unavailable (ordinary-uncoordinated: controlled-writers-unmigrated, adoption-executor-unprovisioned)',
      'unsupported-capability', { kind: 'placement', reason: 'unsupported-capability', gates: ['adoption-executor-unprovisioned'] }));
    vi.mocked(copyWorkbenchCode).mockResolvedValue('export function Button() {}');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText('Apply is off on this machine')).toBeTruthy();
    expect(screen.getByText('Apply needs the placement helper, which is off here. Use Copy code, or start Mishh with apply enabled (see setup).')).toBeTruthy();
    expect(screen.queryByText(/controlled-writers-unmigrated/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const disclosure = screen.getByText('Details');
    expect(disclosure.closest('details')?.textContent).toContain('adoption-executor-unprovisioned');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(copyWorkbenchCode).toHaveBeenCalledWith('ref-key');
    expect(await screen.findByText('Code copied')).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('export function Button() {}');
  });

  it('shows the same card when adoption status is closed before an Apply attempt', async () => {
    vi.mocked(getAdoptionStatus).mockResolvedValueOnce({ status: { executor: 'closed', placementMode: 'ordinary-uncoordinated', optIn: { env: false, labs: false }, host: { platform: 'darwin', arch: 'arm64', supported: true }, gates: ['adoption-opt-in-env-off'] } });
    view(resource(), 'p1');
    expect(await screen.findByText('Apply is off on this machine')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(prepareCatalogueAdoption).not.toHaveBeenCalled();
  });

  it('maps an adoption-unprovisioned 422 even when the daemon reports no gate list', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED',
      'Adoption is unavailable (adoption-executor-unprovisioned)', 'adoption-executor-unprovisioned', { kind: 'adoption', reason: 'adoption-executor-unprovisioned' }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText('Apply is off on this machine')).toBeTruthy();
    expect(screen.queryByText(/Adoption is unavailable/)).toBeNull();
  });

  it('keeps an imported-project refusal distinct from an Apply-off machine', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED',
      'Adoption into imported project roots is unsupported', 'unsupported-capability', { kind: 'placement', reason: 'unsupported-capability' }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText(/Adoption into imported project roots is unsupported/)).toBeTruthy();
    expect(screen.queryByText('Apply is off on this machine')).toBeNull();
  });

  it('does not let a late closed-status response replace a prepared plan', async () => {
    let resolveStatus!: (value: Awaited<ReturnType<typeof getAdoptionStatus>>) => void;
    vi.mocked(getAdoptionStatus).mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
    vi.mocked(prepareCatalogueAdoption).mockResolvedValue(prepared);
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByRole('button', { name: 'Confirm apply' })).toBeTruthy();
    resolveStatus({ status: { executor: 'closed', placementMode: 'ordinary-uncoordinated', optIn: { env: false, labs: false }, host: { platform: 'darwin', arch: 'arm64', supported: true }, gates: ['adoption-executor-unprovisioned'] } });
    expect(await screen.findByRole('button', { name: 'Confirm apply' })).toBeTruthy();
    expect(screen.queryByText('Apply is off on this machine')).toBeNull();
  });
  it('is not offered for reference-only or unpermitted resources, and asks for a project otherwise', () => {
    view(resource({ rightsStatus: 'unknown', operationGrants: [] }), 'p1');
    expect(screen.queryByTestId('workbench-apply-action')).toBeNull();
    cleanup();
    view(resource());
    expect(screen.getByText('Open a project to apply this item')).toBeTruthy();
  });

  it('shows the declared output before applying, then applies and undoes through the adoption endpoints', async () => {
    vi.mocked(prepareCatalogueAdoption).mockResolvedValue(prepared);
    vi.mocked(applyAdoptionPlan).mockResolvedValue(operation('apply'));
    vi.mocked(undoAdoptionOperation).mockResolvedValue(operation('undo'));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText('src/components/ui/button.tsx')).toBeTruthy();
    expect(screen.getByText(/shadcn\/ui · MIT/)).toBeTruthy();
    expect(prepareCatalogueAdoption).toHaveBeenCalledWith({ projectId: 'p1', refKey: 'ref-key', entryPath: 'src/App.tsx' }, undefined);
    expect(applyAdoptionPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm apply' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(applyAdoptionPlan).toHaveBeenCalledWith(plan, undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Undone; the project files are restored')).toBeTruthy();
    expect(undoAdoptionOperation).toHaveBeenCalledWith(operation('apply'), undefined);
  });

  it.each([
    ['interrupted', 'recovery-required'],
    ['failed', 'recovery-required'],
  ] as const)('a replayed %s apply shows a recovery status and offers no Undo', async (state, stage) => {
    vi.mocked(prepareCatalogueAdoption).mockResolvedValue(prepared);
    vi.mocked(applyAdoptionPlan).mockResolvedValue({ ...operation('apply'), state, stage, reason: 'interrupted' });
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm apply' }));
    expect(await screen.findByText(/Apply did not complete/)).toBeTruthy();
    expect(screen.getByTestId('workbench-apply-action').getAttribute('data-step')).toBe('recovery');
    expect(screen.queryByText('Applied files', { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('retains a daemon capability reason even when admission and target gates pass', () => {
    view(resource({ adoptionCapability: { available: false, reason: 'executor-unavailable' } }), 'p1');
    expect(screen.getByTestId('workbench-apply-capability').textContent).toContain('executor-unavailable');
  });
  it('states the verified admission and target next to Apply', () => {
    view(resource(), 'p1');
    const capability = screen.getByTestId('workbench-apply-capability').textContent ?? '';
    expect(capability).toContain('Admission and target verified');
    expect(capability).toContain('prepare checks files and dependencies');
    expect(capability).not.toMatch(/unavailable|usable/i);
    expect(screen.getByRole('button', { name: 'Apply to project' })).toBeTruthy();
  });

  it.each(['status', 'prepare'] as const)('keeps the detail status consistent when %s turns Apply off', async (source) => {
    const r = resource();
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: r, sourceStatus: { sourceId: 'shadcn', state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
    if (source === 'status') {
      vi.mocked(getAdoptionStatus).mockResolvedValueOnce({ status: { executor: 'closed', placementMode: 'ordinary-uncoordinated', optIn: { env: false, labs: false }, host: { platform: 'darwin', arch: 'arm64', supported: true }, gates: ['adoption-executor-unprovisioned'] } });
    } else {
      vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'Apply off', 'adoption-executor-unprovisioned', {}));
    }
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={r} projectId="p1" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    if (source === 'prepare') fireEvent.click(await screen.findByRole('button', { name: 'Apply to project' }));
    await screen.findByText('Apply is off on this machine', { selector: 'h4' });
    expect(screen.getByTestId('workbench-resource-detail').textContent).not.toContain('apply allowed');
    expect(screen.getAllByText('Apply is off on this machine').length).toBe(2);
  });

  it('the detail panel states the same capability as the offered Apply, never "Adoption unavailable"', async () => {
    const r = resource();
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: r, sourceStatus: { sourceId: 'shadcn', state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={r} projectId="p1" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    expect(await screen.findByRole('button', { name: 'Apply to project' })).toBeTruthy();
    const detail = screen.getByTestId('workbench-resource-detail');
    expect(detail.textContent).not.toContain('Adoption unavailable');
    expect(screen.getAllByText(/Admission and target verified; prepare checks files and dependencies/).length).toBe(2);
  });

  it('lists missing and incompatible packages from the daemon refusal', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'Install or align', 'dependencies-unsatisfied', {
      missing: [{ name: 'class-variance-authority', range: '*' }], incompatible: [{ name: 'tailwind-merge', required: '^3.0.0', installed: '^2.5.0' }],
    }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText('Missing packages')).toBeTruthy();
    expect(screen.getByText(/^class-variance-authority · requires any version · found not installed$/)).toBeTruthy();
    expect(screen.getByText('Incompatible packages')).toBeTruthy();
    expect(screen.getByText(/requires \^3\.0\.0 · found \^2\.5\.0/)).toBeTruthy();
  });

  it('[W1] lists every missing and incompatible package with its required range and found version', async () => {
    // The witness payload: the live shadcn button declares `cn` and `radix-ui` with no range.
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'Install or align', 'dependencies-unsatisfied', {
      missing: [{ name: 'cn', range: '*' }, { name: 'radix-ui', range: '^1.4.0' }],
      incompatible: [{ name: 'tailwind-merge', required: '^3.0.0', installed: '^2.5.0' }],
    }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    const missing = await screen.findByRole('list', { name: 'Missing packages' });
    const rows = (list: HTMLElement) => Array.from(list.querySelectorAll('[data-testid="workbench-apply-package"]')).map(row => row.textContent);
    expect(rows(missing)).toEqual(['cn · requires any version · found not installed', 'radix-ui · requires ^1.4.0 · found not installed']);
    expect(rows(screen.getByRole('list', { name: 'Incompatible packages' }))).toEqual(['tailwind-merge · requires ^3.0.0 · found ^2.5.0']);
  });

  it('[W1] an incompatible-only or missing-only report still lists its packages (no parse drop)', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValueOnce(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'Install or align', 'dependencies-unsatisfied', {
      incompatible: [{ name: 'tailwind-merge', required: '^3.0.0', installed: '^2.5.0' }],
    }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect((await screen.findByRole('list', { name: 'Incompatible packages' })).textContent).toContain('tailwind-merge');
    expect(screen.queryByRole('list', { name: 'Missing packages' })).toBeNull();
    cleanup();
    vi.mocked(prepareCatalogueAdoption).mockRejectedValueOnce(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'Install or align', 'dependencies-unsatisfied', {
      missing: [{ name: 'cn', range: '*' }, { bogus: true }],
    }));
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect((await screen.findByRole('list', { name: 'Missing packages' })).textContent).toContain('cn');
  });

  it('shows the replacement diff and re-prepares only with the reviewed digest', async () => {
    vi.mocked(prepareCatalogueAdoption)
      .mockRejectedValueOnce(new AdoptionRequestError(409, 'CONFLICT', 'Review', 'replacement-review-required', { review: {
        replacementDigest: 'r'.repeat(64), files: [{ path: 'src/components/ui/button.tsx', currentSha256: 'a'.repeat(64), incomingSha256: 'b'.repeat(64), diff: '-v1\n+v2' }],
      } }))
      .mockResolvedValueOnce(prepared);
    view(resource(), 'p1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect((await screen.findByTestId('workbench-apply-diff')).textContent).toBe('-v1\n+v2');
    fireEvent.click(screen.getByRole('button', { name: 'Accept and replace' }));
    expect(await screen.findByRole('button', { name: 'Confirm apply' })).toBeTruthy();
    expect(prepareCatalogueAdoption).toHaveBeenLastCalledWith({ projectId: 'p1', refKey: 'ref-key', entryPath: 'src/App.tsx', acceptReplacement: 'r'.repeat(64) }, undefined);
  });
});
it('V06 never offers Apply for an inspected component with a failed gate or missing target assessment', () => {
  const blocked = resource({ componentFit: { version: 'kit-components/1', kitSourceId: 'design-systems', acceptance: 'pending', kitId: 'clinic', kitRevisionOrDigest: 'v1', status: 'unknown', score: 0, reasons: [{ code: 'apply-blocked', fact: 'admission-unverified' }], apply: { allowed: false, blockers: ['admission-unverified'] } } });
  const rendered = view(blocked, 'p1'); expect(screen.queryByRole('button', { name: 'Apply to project' })).toBeNull();
  rendered.unmount(); view(resource({ componentFit: undefined }), 'p1');
  expect(screen.queryByRole('button', { name: 'Apply to project' })).toBeNull();
  expect(prepareCatalogueAdoption).not.toHaveBeenCalled();
});
