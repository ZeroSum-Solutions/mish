// @vitest-environment jsdom
/**
 * Atlas Digest pilot (G5): a media cell refused by a content-safety policy
 * said only "Failed". The daemon now records WHY on the task
 * (`error.category`: `safety.nsfw` when the provider flagged the request as
 * NSFW, `safety.unspecified` when it named no reason), and the failed cell
 * says it in words — in both the locked (run still live) and the retry state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render as rtlRender } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { PersistedAgentEvent, ProjectMediaTask } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import type { Locale } from '../../../src/i18n/types';
import { ImageRow } from '../../../src/components/chat/primitives/ImageRow';
import { buildTurnBlocks } from '../../../src/runtime/chat/build-turn-blocks';
import type {
  ExecutionShell,
  ImageRow as ImageRowData,
  ShellItem,
} from '../../../src/runtime/chat/contract';

afterEach(cleanup);

const render = (ui: ReactElement, locale: Locale = 'en') =>
  rtlRender(<I18nProvider initial={locale}>{ui}</I18nProvider>);

const failedTask = (over: Partial<ProjectMediaTask> = {}): ProjectMediaTask => ({
  taskId: 'refused',
  runId: 'run',
  surface: 'image',
  status: 'failed',
  startedAt: 100,
  endedAt: 200,
  elapsed: 0,
  progress: [],
  progressCount: 0,
  error: {
    message: 'HiggsField generation nsfw',
    status: 400,
    code: 'safety_rejection',
    category: 'safety.nsfw',
    retryable: false,
    nextStep: 'revise-request',
  },
  ...over,
});

/** One `od media generate` call whose task the daemon recorded as refused. */
function imageRows(tasks: ProjectMediaTask[]): ImageRowData[] {
  const events: PersistedAgentEvent[] = [
    { kind: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'od media generate --surface image --prompt x' }, startedAt: 0 },
    { kind: 'tool_result', toolUseId: 'g1', content: '{"taskId":"refused","status":"failed"}', isError: false, completedAt: 1200 },
  ] as PersistedAgentEvent[];
  const blocks = buildTurnBlocks({ events, mediaTasks: tasks, runStatus: 'failed' });
  const shell = blocks.find((block): block is ExecutionShell => block.kind === 'shell');
  if (!shell) throw new Error('no execution shell');
  return shell.items.filter((item: ShellItem): item is ImageRowData => item.kind === 'image');
}

const row = (category?: 'safety.nsfw' | 'safety.unspecified'): ImageRowData => ({
  kind: 'image',
  id: 'media:refused',
  surface: 'image',
  total: 1,
  done: 0,
  failed: 1,
  thumbs: [],
  cells: [{ taskId: 'refused', status: 'failed', ...(category ? { safetyCategory: category } : {}) }],
  pending: false,
  elapsedMs: null,
});

const failedCell = (root: HTMLElement): HTMLElement => {
  const cell = root.querySelector<HTMLElement>('[data-image-cell="failed"]');
  if (!cell) throw new Error('no failed cell');
  return cell;
};

describe('a safety-refused media cell names the reason', () => {
  it('carries the task error category onto its cell', () => {
    expect(imageRows([failedTask()])[0]?.cells?.[0]).toMatchObject({
      taskId: 'refused',
      status: 'failed',
      safetyCategory: 'safety.nsfw',
    });
    const plain = failedTask({ error: { message: 'upstream 500', status: 500, nextStep: 'retry-later' } });
    expect(imageRows([plain])[0]?.cells?.[0]).not.toHaveProperty('safetyCategory');
  });

  it('says why in the locked state and in the retry state', () => {
    const locked = render(<ImageRow row={row('safety.nsfw')} running />);
    expect(failedCell(locked.container).textContent).toContain('Blocked: flagged as NSFW');
    cleanup();

    const retryable = render(<ImageRow row={row('safety.nsfw')} onRetry={() => {}} />);
    const cell = failedCell(retryable.container);
    expect(cell.textContent).toContain('Blocked: flagged as NSFW');
    // N1: the reason sits beside the button, not inside it; the button's
    // accessible name stays "Retry" and the reason describes it.
    const button = retryable.getByRole('button', { name: 'Retry' });
    expect(button.textContent).toBe('Retry');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(cell.querySelector(`[id="${describedBy}"]`)?.textContent).toBe('Blocked: flagged as NSFW');
    cleanup();

    const unspecified = render(<ImageRow row={row('safety.unspecified')} running />);
    expect(failedCell(unspecified.container).textContent).toContain('Blocked by content safety');
  });

  it('keeps the plain failure text when no category was recorded', () => {
    const plain = render(<ImageRow row={row()} running />);
    expect(failedCell(plain.container).textContent).toBe('Failed');
  });

  it('renders the category label through the dictionary', () => {
    const view = render(<ImageRow row={row('safety.nsfw')} running />, "en");
    expect(failedCell(view.container).textContent).toContain("Blocked: flagged as NSFW");
  });
});
