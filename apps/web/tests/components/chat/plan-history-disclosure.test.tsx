// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import { I18nProvider } from '../../../src/i18n';
import type {
  ExecutionShell as Shell,
  ShellItem,
  TodoSegment,
} from '../../../src/runtime/chat/contract';

afterEach(cleanup);

const evidence = (text: string): ShellItem => ({ kind: 'text', text });
const toolEvidence = (): ShellItem => ({
  kind: 'tool',
  id: 'history-tool',
  tool: 'read',
  title: 'Read archived draft',
  name: 'Read',
  rawTitle: false,
  file: null,
  delta: null,
  hits: null,
  pattern: null,
  elapsedMs: 400,
  failed: false,
  failReason: null,
  command: null,
  terminal: null,
  pending: false,
});

const todo = (
  content: string,
  status: TodoSegment['status'],
  items: ShellItem[] = [],
  abandoned = false,
): ShellItem => ({
  kind: 'todo',
  segment: {
    content,
    status,
    recalled: false,
    abandoned,
    implicit: false,
    items,
    elapsedMs: null,
  },
});

const latest = [
  'Restate the visual system',
  'Lock the ten-beat narrative',
  'Replace all fictional content',
  'Fill the ten slides',
  'Run the delivery self-check',
];

const shell: Shell = {
  kind: 'shell',
  id: 'plan-history-shell',
  status: 'running',
  thinking: false,
  stopped: false,
  elapsedMs: 8_000,
  quietMs: null,
  segments: latest.map((content, index) => ({
    content,
    status: index === 0 ? 'in_progress' : 'pending',
    recalled: false,
    abandoned: false,
    implicit: false,
    items: [],
    elapsedMs: null,
  })),
  items: [
    { kind: 'plan', steps: latest },
    todo('Old nine-beat narrative', 'completed', [toolEvidence()], true),
    todo('Old gemstone copy pass', 'completed', [evidence('Kept text evidence')], true),
    todo('Empty abandoned step', 'pending', [], true),
    ...latest.map((content, index) => todo(content, index === 0 ? 'in_progress' : 'pending')),
  ],
};

function show(): ReturnType<typeof render> {
  return render(
    <I18nProvider initial="en">
      <ExecutionShell shell={shell} />
    </I18nProvider>,
  );
}

describe('superseded plan history', () => {
  it('keeps the primary plan count and rows aligned with the latest snapshot', () => {
    const { container } = show();

    expect(screen.getByText('Plan · 5 steps')).toBeTruthy();
    const outerBody = container.querySelector('details[class*="flat"] > div[class*="stack"]');
    expect(outerBody).not.toBeNull();
    const directSummaries = [...outerBody!.children]
      .map((node) => node.querySelector(':scope > summary')?.textContent ?? '')
      .filter((label) => latest.includes(label));
    expect(directSummaries).toEqual(latest);
    expect(screen.queryByText('Old nine-beat narrative')).toBeNull();
    expect(screen.queryByText('Old gemstone copy pass')).toBeNull();
    expect(screen.queryByText('Empty abandoned step')).toBeNull();
  });

  it('reveals only evidence-bearing abandoned rows inside one collapsed disclosure', () => {
    const { container } = show();
    const label = screen.getByText('Plan changed');
    const disclosure = label.closest('details');

    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.queryByText('Read archived draft')).toBeNull();

    fireEvent.click(disclosure!.querySelector('summary')!);

    expect(screen.getByText('Old nine-beat narrative')).toBeTruthy();
    expect(screen.getByText('Old gemstone copy pass')).toBeTruthy();
    expect(screen.queryByText('Empty abandoned step')).toBeNull();

    const abandoned = [...container.querySelectorAll('details')]
      .filter((node) => node.querySelector('summary')?.textContent?.includes('Old '));
    expect(abandoned).toHaveLength(2);

    fireEvent.click(abandoned[0]!.querySelector('summary')!);
    expect(screen.getByText('Read archived draft')).toBeTruthy();
  });
});
