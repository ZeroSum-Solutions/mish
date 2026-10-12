// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { licenceOperationStatuses, type IntegrationRoster, type IntegrationRosterEntry, type LicenceRecordSnapshot } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { WorkbenchIntegrationRoster } from '../../src/components/workbench/WorkbenchIntegrationRoster';
import { getIntegrationRoster, putLicenceRecord, testIntegration } from '../../src/providers/workbench-integrations';
import { WorkbenchRequestError } from '../../src/providers/workbench';

vi.mock('../../src/providers/workbench-integrations', async original => ({ ...await original<typeof import('../../src/providers/workbench-integrations')>(), getIntegrationRoster: vi.fn(), putLicenceRecord: vi.fn(), testIntegration: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const base: IntegrationRosterEntry = {
  id: 'gsap', name: 'GSAP', kind: 'design-integration', role: 'required', requirementIds: ['R08'], resourceSourceId: 'gsap',
  purpose: 'Required motion integration as a project-selected declared dependency.', urls: ['https://gsap.com'],
  version: { value: 'gsap 3.15.0', basis: 'package', note: null },
  rights: { status: 'published-licence', summary: 'GSAP standard no-charge licence.', evidenceRefs: [] },
  inputs: ['Recipe'], outputs: ['Project animation code'],
  account: { required: 'none', summary: 'No account.', principal: null }, dependencyScope: 'project-selected',
  installState: { state: 'not-installed', basis: 'none', reason: 'No manifest declares GSAP.' }, daemonBinding: 'not-applicable',
  availability: { state: 'unverified', reason: 'Implementation-unverified.' }, need: { decision: 'need-confirmed', reason: 'Owner-confirmed.' },
  readiness: 'unverified', operations: [{ operation: 'visual-animation-editor', status: 'deferred', evidenceRefs: [], reason: 'Assessed separately.' }],
  lastVerifiedUse: null, pendingReceipts: ['G10 fixtures'], gateIds: ['G10'],
  siteEvaluation: { namedIn: 'Batch1', existingMcp: { result: 'no-mcp', endpoint: null, summary: 'No MCP needed.', evidenceRefs: [] }, toolSchema: { state: 'not-applicable', summary: 'Packages.', evidenceRefs: [] }, terms: { summary: 'Standard licence.', evidenceRefs: [] }, auth: { kind: 'none', summary: 'None.' }, cost: { kind: 'free', summary: 'Free.' }, decision: 'use-existing', decisionReason: 'Pinned packages.', missingCapability: null, lastProof: null },
};
const reactBits: IntegrationRosterEntry = {
  ...base, id: 'react-bits', name: 'React Bits', role: 'required', requirementIds: ['R16'], resourceSourceId: 'react-bits', dependencyScope: 'project-selected',
  rights: { status: 'held-licence', summary: 'Owner-confirmed held licence.', evidenceRefs: [] },
  account: { required: 'held-licence', summary: 'Held licence.', principal: null }, operations: [{ operation: 'apply-to-project', status: 'unverified', evidenceRefs: [], reason: 'Pending.' }],
  lastVerifiedUse: { at: '2026-10-03T00:00:00.000Z', operation: 'registry probe', surfaces: ['fixture'], evidenceRef: 'docs/x.json' }, pendingReceipts: ['Licence record in Settings'], siteEvaluation: null,
};
const emptyLicence: LicenceRecordSnapshot = { schema: 'licence-record-snapshot/1', sourceId: 'react-bits', revision: 0, recordState: 'none', licenceExistence: 'owner-confirmed', record: null, operations: licenceOperationStatuses(null) };
const roster = (licence = emptyLicence): IntegrationRoster => ({ schema: 'integration-roster/1', rosterDigest: 'd'.repeat(64), generatedAt: '2026-10-08T00:00:00.000Z', entries: [base, reactBits], licences: [licence], knownGaps: ['Per-operation notices are not recorded yet.'], exclusions: [{ name: 'Material UI', reason: 'Repository candidate 43, not a named website.' }] });
const view = (locale: 'en' = 'en') => render(<I18nProvider initial={locale}><WorkbenchIntegrationRoster /></I18nProvider>);
const stored = (holder: string, revision: number) => ({ schema: 'licence-record/1' as const, sourceId: 'react-bits' as const, revision, holder, termsVersion: '2026-01', termsEvidence: null, operationScope: [], changes: [],
  recordedBy: { role: 'source-curator' as const, basis: 'specific-grant' as const, surface: 'settings' as const }, recordedAt: '2026-10-08T00:00:00.000Z' });

describe('Settings integration roster (AC-R08.1, AC-R12.1)', () => {
  it('publishes version, rights, account, install/availability, decision and the honest missing receipt per row', async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue(roster());
    view();
    const gsap = await screen.findByRole('article', { name: 'GSAP' });
    expect(within(gsap).getByText('gsap 3.15.0')).toBeTruthy();
    expect(within(gsap).getByText('GSAP standard no-charge licence.')).toBeTruthy();
    expect(within(gsap).getByText('Unverified')).toBeTruthy();
    expect(within(gsap).getByText('Required · Project-selected dependency · R08')).toBeTruthy();
    expect(within(gsap).getByText(/Not installed/)).toBeTruthy();
    expect(within(gsap).getByText(/Use existing/)).toBeTruthy();
    expect(within(gsap).getByText('No verified use yet. Missing: G10 fixtures')).toBeTruthy();
    const bits = screen.getByRole('article', { name: 'React Bits' });
    expect(within(bits).getByText(/registry probe/)).toBeTruthy();
    expect(within(bits).getByText(/fixture/)).toBeTruthy();
  });
  it("translates enum values in English and lists the known gaps and exclusions", async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue(roster());
    view("en");
    const gsap = await screen.findByRole('article', { name: 'GSAP' });
    expect(within(gsap).getByText("Unverified")).toBeTruthy();
    expect(within(gsap).getByText(/Not installed/)).toBeTruthy();
    expect(within(gsap).getByText(/Use existing/)).toBeTruthy();
    expect(screen.getByText(/Per-operation notices are not recorded yet\./)).toBeTruthy();
    expect(screen.getByText(/Material UI/)).toBeTruthy();
  });
  it('shows a truthful error when the roster cannot load', async () => {
    vi.mocked(getIntegrationRoster).mockRejectedValue(new Error('offline'));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('The integration roster could not be loaded.');
  });
});

describe('Settings React Bits licence record (R16)', () => {
  it('starts with owner-confirmed existence and every operation pending, then records the holder', async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue(roster());
    const recorded = stored('Example Owner', 1);
    vi.mocked(putLicenceRecord).mockResolvedValue({ ...emptyLicence, revision: 1, recordState: 'current', record: recorded, operations: licenceOperationStatuses(recorded) });
    view();
    const form = await screen.findByRole('form', { name: 'React Bits licence record' });
    expect(within(form).getByText('Licence held (owner-confirmed). No licence record yet.')).toBeTruthy();
    expect(within(form).getAllByText(/Pending · no licence record/)).toHaveLength(9);
    fireEvent.change(within(form).getByLabelText('Licence holder'), { target: { value: 'Example Owner' } });
    fireEvent.change(within(form).getByLabelText('Held terms version'), { target: { value: '2026-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save licence record' }));
    await waitFor(() => expect(putLicenceRecord).toHaveBeenCalledWith('react-bits', { expectedRevision: 0, draft: { holder: 'Example Owner', termsVersion: '2026-01', termsEvidence: null, operationScope: [] } }));
    expect(await within(form).findAllByText(/Pending · no terms evidence/)).toHaveLength(9);
    expect(within(form).getByText('Recorded holder: Example Owner (revision 1, Settings)')).toBeTruthy();
    // W7: the roster is read again after a save, so its missing-receipt list is current.
    await waitFor(() => expect(getIntegrationRoster).toHaveBeenCalledTimes(2));
  });
  it('on a 409 re-seeds the form from the saved record, shows what changed and holds Save until reviewed', async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue(roster());
    const current = stored('Other Owner', 1);
    vi.mocked(putLicenceRecord).mockRejectedValue(new WorkbenchRequestError(409, 'CONFLICT', 'changed', [], { ...emptyLicence, revision: 1, recordState: 'current', record: current, operations: licenceOperationStatuses(current) }));
    view();
    const form = await screen.findByRole('form', { name: 'React Bits licence record' });
    fireEvent.change(within(form).getByLabelText('Licence holder'), { target: { value: 'Example Owner' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save licence record' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('The licence record changed elsewhere');
    expect(alert).toHaveTextContent('Licence holder: yours “Example Owner”, saved “Other Owner”');
    expect((within(form).getByLabelText('Licence holder') as HTMLInputElement).value).toBe('Other Owner');
    expect((within(form).getByRole('button', { name: 'Save licence record' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('button', { name: 'Edit from the saved record' }));
    expect((within(form).getByRole('button', { name: 'Save licence record' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('sends cited terms and per-operation scope, and explains a widening refusal without losing input', async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue(roster());
    vi.mocked(putLicenceRecord).mockRejectedValue(new WorkbenchRequestError(422, 'VALIDATION_FAILED', 'widening'));
    view();
    const form = await screen.findByRole('form', { name: 'React Bits licence record' });
    fireEvent.change(within(form).getByLabelText('Licence holder'), { target: { value: 'Example Owner' } });
    fireEvent.change(within(form).getByLabelText('Held terms version'), { target: { value: '2026-01' } });
    fireEvent.change(within(form).getByLabelText('Terms digest (SHA-256)'), { target: { value: 'e'.repeat(64) } });
    fireEvent.change(within(form).getByLabelText('Cited clauses'), { target: { value: '2.1, 2.4' } });
    fireEvent.change(within(form).getByLabelText('host-preview decision'), { target: { value: 'allowed' } });
    fireEvent.change(within(form).getByLabelText('host-preview clauses'), { target: { value: '2.1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save licence record' }));
    await waitFor(() => expect(putLicenceRecord).toHaveBeenCalledWith('react-bits', { expectedRevision: 0, draft: {
      holder: 'Example Owner', termsVersion: '2026-01',
      termsEvidence: { kind: 'terms-version', sha256: 'e'.repeat(64), citationUrl: null, clauseRefs: ['2.1', '2.4'] },
      operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }],
    } }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('The held terms do not support that scope. Cite a clause from the recorded terms or leave the operation pending.');
    expect((within(form).getByLabelText('Licence holder') as HTMLInputElement).value).toBe('Example Owner');
  });
});

describe('D5 Settings Test action', () => {
  it("does not show an unverified account badge for accountless GSAP in English", async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...base,
      runtime: { installed: 'installed', connection: 'connected', accountLabel: null, version: '3.15.0', reason: 'No account required.', fix: { label: 'Restore', url: null, command: null }, workflow: { lastSuccess: { at: '2026-10-09T01:00:00Z', operation: 'local-tween' }, lastTest: null } },
    }] });
    view("en"); const row = await screen.findByRole('article', { name: 'GSAP' });
    expect(within(row).queryByText("Unverified")).toBeNull();
    expect(row).toHaveTextContent("Workflow verified at 2026-10-09T01:00:00Z");
  });
  it.each(['en'] as const)('disables reference-only testing with a clear reason in %s', async locale => {
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...base, id: 'awesome-design-md', name: 'Awesome DESIGN.md', kind: 'reference-source', readiness: 'reference-only' }] });
    view(locale);
    const row = await screen.findByRole('article', { name: 'Awesome DESIGN.md' });
    const button = within(row).getByRole('button', { name: locale === 'en' ? 'Test Awesome DESIGN.md' : "Test Awesome DESIGN.md" });
    expect(button).toBeDisabled();
    expect(row).toHaveTextContent(locale === 'en' ? 'Reference only: no live connection to test' : "Reference only: no live connection to test");
    fireEvent.click(button);
    expect(testIntegration).not.toHaveBeenCalled();
  });
  it('shows connection separately from workflow and replaces the row with the returned receipt', async () => {
    const runtime = { installed: 'installed' as const, connection: 'connected' as const, accountLabel: null, version: '3.15.0', reason: 'Local dependency', fix: { label: 'Restore', url: null, command: 'pnpm install --frozen-lockfile' }, workflow: { lastSuccess: null, lastTest: null } };
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...base, runtime }] });
    vi.mocked(testIntegration).mockResolvedValue({ ...base, runtime: { ...runtime, workflow: { lastSuccess: { at: '2026-10-09T01:00:00Z', operation: 'local-tween' }, lastTest: { at: '2026-10-09T01:00:00Z', outcome: 'passed', kind: 'workflow', code: 'check-passed', message: 'Read-only workflow call succeeded.' } } } });
    view(); const row = await screen.findByRole('article', { name: 'GSAP' });
    expect(within(row).getAllByText('Workflow not verified').length).toBeGreaterThan(0);
    fireEvent.click(within(row).getByRole('button', { name: 'GSAP details' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Test GSAP' }));
    await waitFor(() => expect(within(row).getByRole('status').textContent).toContain('Read-only workflow call succeeded.'));
    expect(vi.mocked(testIntegration)).toHaveBeenCalledWith('gsap');
    expect(within(row).getByText('Connection')).toBeTruthy();
    expect(within(row).getAllByText('Workflow verified at 2026-10-09T01:00:00Z').length).toBeGreaterThan(0);
    expect(row).not.toHaveTextContent('No verified use yet');
    expect(row).not.toHaveTextContent('Unverified');
    expect(row).not.toHaveTextContent('pnpm install --frozen-lockfile');
    expect(row).not.toHaveTextContent('Live installation');
    expect(row).toHaveTextContent('local-tween');
    expect(row).toHaveTextContent('Pending adoption evidence');
    expect(row).toHaveTextContent('G10 fixtures');
  });
  it.each([
    ['higgsfield', 'Higgsfield', null, 'not-applicable'],
    ['claude', 'Claude CLI', null, 'not-applicable'],
    ['refero', 'Refero', 'refero', 'enabled'],
    ['hallmark', 'Hallmark', 'design-skills', 'not-applicable'],
  ] as const)('keeps %s installation separate from an untested connection without conflicting badges', async (id, name, resourceSourceId, daemonBinding) => {
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...base, id, name, resourceSourceId, daemonBinding, kind: id === 'hallmark' ? 'design-skill' : 'design-integration',
      installState: { state: 'configured', basis: 'agent-runtime-receipt', reason: 'Detected on this machine.' },
      runtime: { installed: 'installed', connection: 'missing', accountLabel: null, version: '1.0.0', reason: 'Run Test to check the account.', fix: { label: 'Sign in', url: null, command: null }, workflow: { lastSuccess: null, lastTest: null } },
    }] });
    view(); const row = await screen.findByRole('article', { name });
    expect(row).toHaveTextContent('Not checked');
    expect(within(row).queryAllByText('Missing')).toHaveLength(0);
    expect(row).not.toHaveTextContent('Not installed');
    expect(row).not.toHaveTextContent('Live installation');
    expect(within(row).getByRole('button', { name: `Test ${name}` })).toBeEnabled();
  });
  it('keeps deferred connector availability visible alongside live connection status', async () => {
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...base, id: 'figma', name: 'Figma', kind: 'website-connector', role: 'deferred', resourceSourceId: null,
      daemonBinding: 'not-configured', readiness: 'unavailable', availability: { state: 'deferred', reason: 'Deferred from the first release.' },
      runtime: { installed: 'missing', connection: 'missing', accountLabel: null, version: null, reason: 'No matching MCP server.', fix: { label: 'Setup', url: null, command: null }, workflow: { lastSuccess: null, lastTest: null } },
    }] });
    view(); const row = await screen.findByRole('article', { name: 'Figma' });
    expect(row).toHaveTextContent('Deferred · Deferred from the first release.');
  });
  it.each(['component-registry', 'font-source', 'reference-source', 'website-connector'] as const)('retains recorded %s installation and verified use without a competing live badge', async kind => {
    const bound = kind === 'component-registry';
    vi.mocked(getIntegrationRoster).mockResolvedValue({ ...roster(), entries: [{ ...reactBits, kind, daemonBinding: bound ? 'not-configured' : 'not-applicable',
      runtime: { installed: 'missing', connection: 'missing', accountLabel: null, version: null, reason: 'No daemon MCP binding.', fix: { label: 'Setup', url: null, command: null }, workflow: { lastSuccess: null, lastTest: null } },
    }] });
    view(); const row = await screen.findByRole('article', { name: 'React Bits' });
    expect(row).toHaveTextContent('Workflow verified at 2026-10-03T00:00:00.000Z');
    expect(row).not.toHaveTextContent('Workflow not verified');
    expect(row).not.toHaveTextContent('Live installation');
    if (bound) {
      expect(row).toHaveTextContent('No daemon MCP binding');
      expect(within(row).getByRole('button', { name: 'Test React Bits' })).toBeEnabled();
    } else {
      expect(row).not.toHaveTextContent('No daemon MCP binding');
      expect(within(row).getByRole('button', { name: 'Test React Bits' })).toBeDisabled();
    }
    expect(row).toHaveTextContent('Not installed');
  });
});
