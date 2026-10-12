// @vitest-environment jsdom
// AC-R11.3 in the canvas: the font constraint report the daemon returns (and `od
// workbench search --json` prints) is shown beside the results, including a
// requirement no font meets and constraints that are not font requirements.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseResourceSearchResponse, type ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceSearch } from '../../../src/components/workbench/WorkbenchResourceSearch';
import { getProjectDesignContext, getWorkbenchPreferences, searchWorkbenchResources } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  searchWorkbenchResources: vi.fn(), getWorkbenchPreferences: vi.fn(), getProjectDesignContext: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(getWorkbenchPreferences).mockImplementation(async projectId => ({ projectId, revision: 0, preferences: null, effective: { useProjectContext: true } }));
  vi.mocked(getProjectDesignContext).mockImplementation(async projectId => ({ projectId, revision: 0, context: null }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const font: ResourceResult = {
  ref: { sourceType: 'font', sourceId: 'fonts', itemId: 'inter', revisionOrDigest: 'sha256:x' }, refKey: 'inter', title: 'Inter', category: 'font', readiness: 'unverified',
  compatibility: { nativeFormat: 'fontsource-metadata', targets: [], state: 'unverified', reason: null }, rightsStatus: 'permitted',
  fitReasons: ['Meets project constraint /constraints/0/value: greek script support (declares the greek subset)', 'Counter-fit for project constraint /constraints/0/value: georgian script support (no georgian subset in the Fontsource metadata)'],
  previewCapability: { available: false, kind: 'none', reason: 'no-local-font-file' }, adoptionCapability: { available: false, reason: 'adapter-missing' },
  sourceAttribution: { title: 'Inter' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
};

describe('AC-R11.3 font constraint report in the Resources flyout', () => {
  it('shows met, unmet and unread constraints with the same text the daemon returns', async () => {
    vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({
      results: [font], sourceStatuses: [], contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null,
      context: { requested: true, applied: false, reason: 'context-not-implemented' },
      fontConstraints: {
        requirements: [
          { id: 'script:greek', kind: 'script', value: 'greek', source: '/constraints/0/value', strength: 'required', satisfiedCount: 5, message: '5 of 22 fonts meet greek script support (/constraints/0/value).' },
          { id: 'script:georgian', kind: 'script', value: 'georgian', source: '/constraints/0/value', strength: 'required', satisfiedCount: 0, message: 'No catalogued font meets georgian script support required by /constraints/0/value; the other fit signals still rank the fonts.' },
        ],
        uninterpreted: [{ source: '/constraints/1/value', message: 'Constraint /constraints/1/value is not read as a font requirement, so it does not rerank fonts.' }],
        fontsConsidered: 22, fontsMeetingAllRequired: 0,
      },
    }));
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    const report = await screen.findByRole('region', { name: 'Font constraints' });
    expect(within(report).getByText(/^No catalogued font meets georgian script support/)).toBeTruthy();
    expect(within(report).getByText(/^5 of 22 fonts meet greek script support/)).toBeTruthy();
    expect(within(report).getByText(/is not read as a font requirement/)).toBeTruthy();
    expect(within(report).getByText(/0 of 22 fonts meet every required constraint/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Inter/ })).toHaveTextContent('Counter-fit for project constraint /constraints/0/value: georgian script support');
  });
});
