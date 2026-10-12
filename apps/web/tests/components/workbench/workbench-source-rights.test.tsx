// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_OPERATIONS, type ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async original => ({ ...await original<typeof import('../../../src/providers/workbench')>(), getWorkbenchResource: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * AC-R18.6 / G38: inspect shows who assessed a project-fetch source's rights, on what
 * basis and against which terms, plus each operation's decision with its cited reason.
 */
const decision = (operation: string) => operation === 'incorporate-project' ? 'allowed' as const : operation === 'redistribute-unit' ? 'blocked' as const : 'unknown' as const;
const resource: ResourceResult = {
  refKey: 'k', ref: { sourceType: 'reference', sourceId: 'aceternity', itemId: 'bento-grid', revisionOrDigest: 'sha256:9d98' },
  title: 'Bento Grid', category: 'layout', readiness: 'unverified',
  compatibility: { nativeFormat: 'react-tsx', targets: ['react'], state: 'unverified', reason: 'react-source/v1 pending' },
  rightsStatus: 'restricted', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'host-preview grant unknown (G38)' },
  adoptionCapability: { available: false, reason: 'operation-rights-unknown' }, sourceAttribution: { title: 'Aceternity UI', url: 'https://ui.aceternity.com/components/bento-grid' },
  operationGrants: [], admissionStage: 'discovered', needDecision: 'justified', needReason: 'Owner-requested priority source.',
  sourceIdentity: {
    repositoryUrl: 'https://ui.aceternity.com', commit: null, registryLocator: 'https://ui.aceternity.com/registry/bento-grid.json', contentSha256: 'a'.repeat(64),
    acquisitionMode: 'project-fetch', documentedConnector: null,
    operationRights: SOURCE_OPERATIONS.map(operation => ({ operation, decision: decision(operation), reason: `${operation} because licence#permitted.create-end-products` })),
    nextGate: 'G38 repairs', evidenceRefs: ['docs/x.json'],
    rightsAssessment: {
      id: 'aceternity-free-rights:bento-grid', revision: 1, evaluatorRole: 'source-curator', basis: 'published-license',
      termsUrl: 'https://ui.aceternity.com/licence', termsSha256: 'd'.repeat(64), clauseRefs: ['licence#permitted.create-end-products'], evaluatedAt: '2026-10-09T02:00:00.000Z',
    },
  },
};

describe('source rights in inspect (AC-R18.6)', () => {
  it('shows the assessment evaluator, basis and terms, and each operation decision with its reason', async () => {
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: 'aceternity', state: 'searched', reason: null, itemCount: 3, listingDigest: 'd' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={resource} plugins={[]} onPickPlugin={() => undefined} onClose={() => undefined} onRefresh={() => undefined} /></I18nProvider>);
    const identity = await screen.findByTestId('workbench-source-identity');
    expect(identity).toHaveTextContent('Rights assessment: source-curator · published-license');
    expect(within(identity).getByRole('link', { name: 'ui.aceternity.com/licence' })).toHaveAttribute('href', 'https://ui.aceternity.com/licence');
    const rights = within(identity).getByTestId('workbench-source-rights');
    expect(within(rights).getAllByRole('listitem')).toHaveLength(SOURCE_OPERATIONS.length);
    expect(rights).toHaveTextContent('incorporate-project: allowed — incorporate-project because licence#permitted.create-end-products');
    expect(rights).toHaveTextContent('redistribute-unit: blocked');
  });
  it('shows the dated owner decision behind an owner-accepted private-use basis', async () => {
    const owner: ResourceResult = { ...resource, sourceIdentity: { ...resource.sourceIdentity!, rightsAssessment: {
      ...resource.sourceIdentity!.rightsAssessment!, basis: 'owner-accepted-private-use',
      ownerDecision: { decidedAt: '2026-10-08', decidedBy: 'owner', citation: 'Private repository; licences are ignored for now.' },
    } } };
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: owner, sourceStatus: { sourceId: 'aceternity', state: 'searched', reason: null, itemCount: 3, listingDigest: 'd' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={owner} plugins={[]} onPickPlugin={() => undefined} onClose={() => undefined} onRefresh={() => undefined} /></I18nProvider>);
    const identity = await screen.findByTestId('workbench-source-identity');
    expect(identity).toHaveTextContent('Rights assessment: source-curator · owner-accepted-private-use');
    expect(identity).toHaveTextContent('Owner decision 2026-10-08: Private repository; licences are ignored for now.');
  });
});
