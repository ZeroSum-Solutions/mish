// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalViewer } from '../../src/components/workspace/TerminalViewer';
import { I18nProvider } from '../../src/i18n';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};

    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('../../src/state/projects', () => ({
  createTerminal: vi.fn(),
  killTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  sendTerminalStdin: vi.fn(),
  terminalStreamUrl: vi.fn(
    (projectId: string, terminalId: string) =>
      `/api/projects/${projectId}/terminals/${terminalId}/stream`,
  ),
}));

class StubEventSource {
  static CLOSED = 2;

  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener() {}

  close() {
    this.readyState = StubEventSource.CLOSED;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('EventSource', StubEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TerminalViewer', () => {
  it('shows localized loading copy while the initial terminal connection is pending', () => {
    render(
      <I18nProvider initial="en">
        <TerminalViewer terminalId="term-1" projectId="project-1" onClose={vi.fn()} />
      </I18nProvider>,
    );

    const loading = screen.getByTestId('terminal-loading');
    expect(loading.textContent).toContain('Mishh Mashh shell');
    expect(loading.textContent).not.toContain('open-design shell');
    expect(loading.textContent).toContain("Starting terminal…");
    expect(loading.textContent).toContain("Preparing the project shell. This usually takes a few seconds.");
  });
});
