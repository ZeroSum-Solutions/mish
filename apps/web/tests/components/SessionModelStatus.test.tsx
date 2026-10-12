// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelPreflightResult } from '@mish/contracts';
import { preflightAttachmentNames, SessionModelPreflightBanner, SessionModelStatus } from '../../src/components/workbench/SessionModelStatus';
import { I18nProvider } from '../../src/i18n';
afterEach(cleanup);
it('shows authorized current model and explicit recovery actions after a conflict', () => {
  const retry = vi.fn(); const settings = vi.fn();
  render(<I18nProvider initial="en"><SessionModelStatus state={{ status: 'conflict', error: new Error('fixture'), choice: { agentId: 'codex', modelId: 'pending' }, snapshot: { projectId: 'p', sessionId: 's', choice: { agentId: 'claude', modelId: 'opus' }, revision: 2, updatedAt: 0 } }} onRetry={retry} onOpenSettings={settings} /></I18nProvider>);
  expect(screen.getByRole('alert').textContent).toContain('Current saved model: claude · opus');
  fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(retry).toHaveBeenCalledTimes(1); expect(settings).toHaveBeenCalledTimes(1);
});
it('keeps credential-bearing transport errors out of the visible recovery notice', () => {
  render(<I18nProvider initial="en"><SessionModelStatus state={{ status: 'error', error: new Error('fixture-secret-key'), choice: null, snapshot: null }} onRetry={() => {}} onOpenSettings={() => {}} /></I18nProvider>);
  expect(screen.getByRole('alert').textContent).toContain('Your draft is kept');
  expect(screen.getByRole('alert').textContent).not.toContain('fixture-secret-key');
});

// AC-R02.3: pre-submit capability/attachment preflight banner.
const okResult: ModelPreflightResult = { agentId: 'claude', modelId: 'default', ok: true, mismatches: [] };
const mismatchResult: ModelPreflightResult = {
  agentId: 'hermes', modelId: 'default', ok: false,
  mismatches: [
    { code: 'image-attachments-unsupported', message: 'fallback', attachmentNames: ['brief.png'] },
    { code: 'attachment-too-large', message: 'fallback', attachmentNames: ['scene.mp4'] },
  ],
};
it('renders nothing for a passing or absent result, and a "checking" status while a request is in flight', () => {
  const { rerender } = render(<I18nProvider initial="en"><SessionModelPreflightBanner result={null} agentLabel="Hermes" modelLabel="default" /></I18nProvider>);
  expect(screen.queryByTestId('session-model-preflight-mismatch')).toBeNull();
  rerender(<I18nProvider initial="en"><SessionModelPreflightBanner result={okResult} agentLabel="Claude Code" modelLabel="default" /></I18nProvider>);
  expect(screen.queryByTestId('session-model-preflight-mismatch')).toBeNull();
  rerender(<I18nProvider initial="en"><SessionModelPreflightBanner result={null} agentLabel="Hermes" modelLabel="default" checking /></I18nProvider>);
  expect(screen.getByTestId('session-model-preflight-checking').textContent).toContain('Checking model and attachment compatibility');
});
it('surfaces every mismatch with the attachment it names, and offers a retry action', () => {
  const onRetry = vi.fn();
  render(<I18nProvider initial="en"><SessionModelPreflightBanner result={mismatchResult} agentLabel="Hermes" modelLabel="default" onRetry={onRetry} /></I18nProvider>);
  const banner = screen.getByTestId('session-model-preflight-mismatch');
  expect(banner.textContent).toContain("Hermes can't receive image attachments (brief.png)");
  expect(banner.textContent).toContain('scene.mp4 exceeds the 200 MiB attachment limit');
  fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
// AC-R02.3 select-time gate: the preflight CALL itself failed (network),
// distinct from a capability mismatch — no `result` exists to describe.
it('renders a truthful "couldn\'t verify" message when the preflight call itself failed', () => {
  render(<I18nProvider initial="en"><SessionModelPreflightBanner result={null} agentLabel="Hermes" modelLabel="opus" verificationFailed /></I18nProvider>);
  const banner = screen.getByTestId('session-model-preflight-verification-failed');
  expect(banner.textContent).toContain("Couldn't verify opus for Hermes");
  expect(screen.queryByTestId('session-model-preflight-mismatch')).toBeNull();
});
it('collects the distinct attachment names a result calls out, for badging staged attachment chips', () => {
  expect(preflightAttachmentNames(null)).toEqual([]);
  expect(preflightAttachmentNames(okResult)).toEqual([]);
  expect(preflightAttachmentNames(mismatchResult)).toEqual(['brief.png', 'scene.mp4']);
});
