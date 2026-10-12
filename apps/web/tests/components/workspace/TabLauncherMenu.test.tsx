// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../../../src/types';
import { TabLauncherMenu } from '../../../src/components/workspace/TabLauncherMenu';

// Resolved via node:path/node:url (not a literal `new URL('./*.module.css',
// import.meta.url)`) — that pattern is a Vite static-asset-URL convention,
// and Vite's CSS Modules plugin intercepts it for a `.module.css` target
// instead of leaving it a plain file path, which breaks `readFileSync`.
const menuCss = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../src/components/workspace/TabLauncherMenu.module.css',
  ),
  'utf8',
);

function file(name: string, kind: ProjectFile['kind']): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1700000000,
    kind,
    mime: kind === 'html' ? 'text/html' : 'text/plain',
  };
}

function renderMenu() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onOpenTab = vi.fn();
  render(
    <TabLauncherMenu
      anchor={anchor}
      files={[file('cover.html', 'html'), file('notes.md', 'text')]}
      workspaceContexts={[
        { id: 'design-files', kind: 'design-files', label: 'Design Files', tabId: 'design-files' },
      ]}
      openTabNames={['cover.html']}
      actions={[]}
      launcherContext={{ projectId: 'p1', openTab: vi.fn() }}
      onOpenFile={vi.fn()}
      onOpenTab={onOpenTab}
      onClose={vi.fn()}
    />,
  );
  return { onOpenTab };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('TabLauncherMenu rows', () => {
  it('labels open tabs by name only, with no per-row "Open" pill', () => {
    const { onOpenTab } = renderMenu();
    const tabRow = screen.getByTestId('tab-launcher-tab-result');

    expect(tabRow.textContent).toBe('Design Files');
    fireEvent.click(tabRow);
    expect(onOpenTab).toHaveBeenCalledWith('design-files');
  });

  it('marks a file that is already open with quiet state text', () => {
    renderMenu();
    const [openFile, closedFile] = screen.getAllByTestId('tab-launcher-result');

    expect(within(openFile!).getByText('Open')).toBeTruthy();
    expect(within(closedFile!).queryByText('Open')).toBeNull();
  });

  it('renders kind filters as toggle chips that announce their state', () => {
    renderMenu();
    const all = screen.getByRole('button', { name: 'All' });
    expect(all.getAttribute('aria-pressed')).toBe('true');

    const html = screen.getByRole('button', { name: 'HTML page' });
    expect(html.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(html);
    expect(html.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByTestId('tab-launcher-result')).toHaveLength(1);
  });

  it('wraps the search input in the shared field shell', () => {
    renderMenu();
    const input = screen.getByTestId('tab-launcher-search');
    expect(input.closest('[data-ui-field-shell]')).not.toBeNull();
  });

  it('guards the row hover fill against the selected row, so a row never shows two highlights', () => {
    // Pinned style invariant (docs/design/ui-system.md § 7): the hover fill
    // and the segmented-thumb selection marker must be mutually exclusive by
    // selector, not by relying on CSS source order to break the tie.
    expect(menuCss).toMatch(/\.row:hover:not\(\.rowSelected\)\s*\{/);
    expect(menuCss).not.toMatch(/\.row:hover\s*\{/);
  });
});
