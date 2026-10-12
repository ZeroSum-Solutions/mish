// @vitest-environment jsdom
/**
 * Atlas Digest G4, Sol review. When another generation overwrote, moved away
 * or deleted a done task's file, the daemon lists that task as
 * `status: "done"` with `error.code: "MEDIA_OUTPUT_SUPERSEDED"` and no `file`.
 * The chat counted it as a success and drew an empty thumbnail. It is a
 * visible failure now: the cell says the output was replaced and to
 * regenerate it, and the row never collapses into the all-done strip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PersistedAgentEvent, ProjectMediaTask } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import type { Locale } from '../../../src/i18n/types';
import { ImageRow } from '../../../src/components/chat/primitives/ImageRow';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type { ExecutionShell, ImageRow as ImageRowData, ShellItem } from '../../../src/runtime/chat/contract';

afterEach(cleanup);

const render = (ui: ReactElement, locale: Locale = 'en') =>
  rtlRender(<I18nProvider initial={locale}>{ui}</I18nProvider>);

const supersededTask: ProjectMediaTask = {
  taskId: 'replaced',
  runId: 'run',
  surface: 'image',
  status: 'done',
  startedAt: 100,
  endedAt: 200,
  elapsed: 0,
  progress: [],
  progressCount: 0,
  error: {
    message: 'hero.png was replaced after this task wrote it',
    code: 'MEDIA_OUTPUT_SUPERSEDED',
    nextStep: 'output-superseded',
  },
};

function imageRow(tasks: ProjectMediaTask[]): ImageRowData {
  const events = [
    { kind: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'od media generate --surface image --prompt x --output hero.png' }, startedAt: 0 },
    { kind: 'tool_result', toolUseId: 'g1', content: '{"taskId":"replaced","status":"done","file":{"name":"hero.png"}}', isError: false, completedAt: 1200 },
  ] as PersistedAgentEvent[];
  const shell = buildTurnBlocks({ events, mediaTasks: tasks, runStatus: 'succeeded' })
    .find((block): block is ExecutionShell => block.kind === 'shell');
  const row = shell?.items.find((item: ShellItem): item is ImageRowData => item.kind === 'image');
  if (!row) throw new Error('no image row');
  return row;
}

describe('a done task whose output was replaced', () => {
  it('is counted as a failure, not a success', () => {
    const row = imageRow([supersededTask]);
    expect([row.done, row.failed]).toEqual([0, 1]);
    expect(row.thumbs).toEqual([]);
    expect(row.cells?.[0]).toMatchObject({ taskId: 'replaced', status: 'failed', superseded: true });
  });

  it('renders a visible "replaced" failure instead of an empty thumbnail', () => {
    const view = render(<ImageRow row={imageRow([supersededTask])} onRetry={() => {}} />);
    expect(view.container.querySelector('[data-image-cell="done"]')).toBeNull();
    const cell = view.container.querySelector<HTMLElement>('[data-image-cell="failed"]');
    expect(cell?.textContent).toContain('Output replaced: regenerate it');
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it("says so in English", () => {
    const view = render(<ImageRow row={imageRow([supersededTask])} running />, "en");
    const cell = view.container.querySelector<HTMLElement>('[data-image-cell="failed"]');
    expect(cell?.textContent).toContain("Output replaced: regenerate it");
  });
});
