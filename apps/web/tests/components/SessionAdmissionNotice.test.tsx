// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionAdmissionNotice } from '../../src/components/chat/SessionAdmissionNotice';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import { loadConversationTranscript } from '../../src/state/load-conversation-transcript';
import { admission } from '../fixtures/session-admission';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('renders the admitted pair and bounded replay facts after persisted-message HTTP reload', async () => {
  const persisted = JSON.parse(JSON.stringify({ id: 'assistant', role: 'assistant', content: 'Finished', runId: admission.runId, modelAdmission: admission, events: [], createdAt: 0 }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [persisted] })));
  const [loaded] = await loadConversationTranscript(admission.projectId, admission.sessionId, null, new AbortController().signal);
  expect(loaded?.modelAdmission).toEqual(admission);
  render(<I18nProvider initial="en"><AssistantMessage message={loaded!} streaming={false} /></I18nProvider>);
  const note = screen.getByRole('note');
  expect(note.textContent).toContain('Used for this turn: codex · default');
  expect(note.textContent).toContain('Runtime model: codex-effective');
  expect(note.textContent).toContain('Model switch: claude · opus → codex · default');
  expect(note.textContent).toContain('Messages included: 4. Attachments included: 1');
  expect(note.textContent).toContain('Earlier messages left out: 2. Bytes left out: 300');
  expect(note.textContent).toContain('The selected context was shortened');
  expect(note.textContent).toContain('Estimated context tokens: 300');
  expect(note.textContent).toContain('Actual token count and remaining input budget are unverified');
});
it('does not infer a replay or native resume notice from absent or wrong-run facts', () => {
  const { rerender } = render(<SessionAdmissionNotice />);
  expect(screen.queryByRole('note')).toBeNull();
  rerender(<SessionAdmissionNotice admission={admission} runId="another-run" />);
  expect(screen.queryByRole('note')).toBeNull();
  rerender(<SessionAdmissionNotice admission={{ ...admission, replayNotice: null }} runId={admission.runId} />);
  expect(screen.getByRole('note').textContent).toContain('codex');
  expect(screen.queryByText(/Model switch/)).toBeNull();
  expect(screen.queryByText(/native|resume/i)).toBeNull();
});
