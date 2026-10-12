// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AgencyBuildSnapshot } from '@open-design/contracts';
import { AgencyBuildProgress } from '../../src/components/AgencyBuildProgress';
import { I18nProvider, useT } from '../../src/i18n';

afterEach(cleanup);
function Harness({ build }: { build: AgencyBuildSnapshot }) {
  const t = useT();
  return <AgencyBuildProgress build={build} events={build.events} liveState={null} steps={null} error={null} t={t} />;
}
it('shows page structure checks separately from the build success', () => {
  const build = { id: 'q', status: 'done', startedAt: '', events: [], renderQuality: { passed: true, scope: 'site', checks: ['page-heading', 'unique-ids', 'form-labels', 'link-destinations'], issueCounts: [] } } as unknown as AgencyBuildSnapshot;
  render(<I18nProvider><Harness build={build} /></I18nProvider>);
  expect(screen.getByTestId('design-index-build-render-quality').textContent).toBe('Page structure checks passed (4 checks).');
});
it('names a structure failure without claiming the page passed', () => {
  const build = { id: 'q', status: 'failed', startedAt: '', events: [], error: { code: 'RENDER_QUALITY_FAILED', message: 'ignored' }, renderQuality: { passed: false, scope: 'site', checks: ['unique-ids'], issueCounts: [{ check: 'unique-ids', count: 2 }] } } as unknown as AgencyBuildSnapshot;
  render(<I18nProvider><Harness build={build} /></I18nProvider>);
  expect(screen.getByTestId('design-index-build-render-quality').textContent).toBe('Page structure checks failed (2 issues).');
  expect(screen.getByTestId('design-index-build-outcome').textContent).toContain('structure checks');
});
