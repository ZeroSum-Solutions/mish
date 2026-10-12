// @vitest-environment jsdom
// AC-R15.2 entry point: the composer's Improve prompt opens the brief review;
// Use prompt binds the accepted revision to the next send without rewriting
// the typed text, and the binding is cleared after that one turn.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../src/components/ChatComposer';
import { flushMounts, typeAndSettle } from '../helpers/lexical-composer';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

vi.mock('../../src/components/workbench/WorkbenchImprovePrompt', () => ({
  WorkbenchImprovePrompt: ({ draft, onUse }: { draft: string; onUse: (b: { id: string; revision: number; hash: string }) => void }) => (
    <div data-testid="improve-dialog">
      <span>{draft}</span>
      <button type="button" onClick={() => onUse({ id: 'brief_1', revision: 2, hash: 'a'.repeat(64) })}>Use prompt</button>
    </div>
  ),
}));

it('binds the accepted brief to the next send and keeps the typed text', async () => {
  const onSend = vi.fn();
  render(<ChatComposer projectId="p1" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p1'} onSend={onSend} onStop={vi.fn()} />);
  await flushMounts();
  expect((screen.getByTestId('improve-prompt-button') as HTMLButtonElement).disabled).toBe(true);
  await typeAndSettle('A Windows 95 bakery site');
  fireEvent.click(screen.getByTestId('improve-prompt-button'));
  expect(screen.getByTestId('improve-dialog')).toHaveTextContent('A Windows 95 bakery site');
  fireEvent.click(screen.getByRole('button', { name: 'Use prompt' }));
  expect(screen.queryByTestId('improve-dialog')).toBeNull();
  expect(screen.getByTestId('improve-prompt-attached')).toHaveTextContent('Brief revision 2 attached');
  fireEvent.click(screen.getByTestId('chat-send'));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0]![0]).toBe('A Windows 95 bakery site');
  expect(onSend.mock.calls[0]![3]).toMatchObject({ designBrief: { id: 'brief_1', revision: 2, hash: 'a'.repeat(64) } });
  await waitFor(() => expect(screen.queryByTestId('improve-prompt-attached')).toBeNull());
});
