// @vitest-environment jsdom
// B4-2 round 7 canary audit, web surface: the review panel renders a bundle
// produced by the daemon's canary audit (apps/daemon/tests/workbench/
// review-canary-audit.test.ts, refreshed with OD_REVIEW_CANARY_BUNDLE_OUT).
// No page-planted canary may appear in the rendered panel, and a console
// source whose origin the daemon could not vouch for shows only its digest.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVerificationBundle, type VerificationBundle } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReviewBundle } from '../../../src/components/workbench/WorkbenchReviewRun';

afterEach(() => { cleanup(); });

const bundle: VerificationBundle = parseVerificationBundle(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../fixtures/workbench/review-canary-bundle.json'), 'utf8')));

function rendered(value: VerificationBundle, locale: 'en' = 'en'): HTMLElement {
  render(<I18nProvider initial={locale}><WorkbenchReviewBundle bundle={value} /></I18nProvider>);
  const panel = screen.getByTestId('workbench-review-bundle');
  for (const details of panel.querySelectorAll('details')) details.open = true;
  return panel;
}

describe('WorkbenchReviewBundle canary audit', () => {
  it('renders the canary bundle with no canary in its text or markup', () => {
    const panel = rendered(bundle);
    expect(panel.textContent).toMatch(/good\.review-egress\.com/u);
    expect(`${panel.textContent}\n${panel.outerHTML}`).not.toMatch(/canary/iu);
  });

  it("renders every reason from the evidence template table, in English (round 9)", () => {
    expect(bundle.evidenceVersion).toBe('workbench-review-evidence/2');
    expect(bundle.results.every(result => typeof result.reason === 'object')).toBe(true);
    const english = rendered(bundle).textContent ?? '';
    expect(english).toMatch(/leads to a missing page \(404\)/u);
    expect(english).toMatch(/<page text: \d+ chars, sha256 [0-9a-f]{12}> is \d\.\d{2}:1, below 4\.5:1 for normal text/u);
    cleanup();
    const englishAgain = rendered(bundle, "en").textContent ?? '';
    expect(`${english}\n${englishAgain}`).not.toMatch(/canary|\[object Object\]/iu);
  });

  it('marks a bundle recorded before evidence redaction, and only that bundle', () => {
    expect(rendered(bundle).querySelector('[data-testid="workbench-review-legacy"]')).toBeNull();
    cleanup();
    const note = rendered({ ...bundle, legacy: true }).querySelector('[data-testid="workbench-review-legacy"]');
    expect(note?.textContent).toMatch(/Recorded before evidence redaction/u);
  });

  it('shows an unvouched console source origin as its digest, never "null"', () => {
    const source = bundle.console!.entries.map(entry => entry.source).find(found => found !== null && found.origin === null);
    const digest = source && 'originSha256' in source ? source.originSha256 : null;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    const panel = rendered(bundle);
    expect(panel.textContent).toContain(`~origin:${digest!.slice(0, 12)}`);
    expect(panel.textContent).not.toMatch(/\bnull\b/u);
  });
});
