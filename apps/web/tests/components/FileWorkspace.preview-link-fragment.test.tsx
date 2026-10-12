// @vitest-environment jsdom
// Loam Room finding (a): the workspace must hand a same-project link's
// search/hash from the source preview to the preview it opens. FileViewer is
// stubbed so this spec observes only the workspace's open-file plumbing.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileWorkspace } from '../../src/components/FileWorkspace';
import type { OpenTabsState, ProjectFile } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectFileText: vi.fn().mockResolvedValue(''),
    uploadProjectFiles: vi.fn(),
    writeProjectBase64File: vi.fn(),
    writeProjectTextFile: vi.fn(),
    fetchProjectFolders: vi.fn().mockResolvedValue([]),
  };
});

type StubProps = {
  file: ProjectFile;
  workspaceActive?: boolean;
  previewLocationRequest?: { search: string; hash: string; nonce: number } | null;
  onOpenFileReplacing?: (
    openName: string,
    closeName: string,
    location?: { search: string; hash: string },
  ) => void;
};

vi.mock('../../src/components/FileViewer', () => ({
  LiveArtifactViewer: () => null,
  FileViewer: ({ file, previewLocationRequest, onOpenFileReplacing }: StubProps) => (
    <div
      data-testid={`stub-viewer-${file.name}`}
      data-location={previewLocationRequest
        ? `${previewLocationRequest.search}${previewLocationRequest.hash}`
        : ''}
      data-nonce={previewLocationRequest ? String(previewLocationRequest.nonce) : 'none'}
    >
      <button
        type="button"
        onClick={() => onOpenFileReplacing?.('index.html', file.name, { search: '', hash: '' })}
      >
        {`plain-link-from-${file.name}`}
      </button>
      <button
        type="button"
        onClick={() => onOpenFileReplacing?.('index.html', file.name, { search: '', hash: '#work' })}
      >
        {`link-from-${file.name}`}
      </button>
    </div>
  ),
}));

function htmlFile(name: string, mtime: number): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 128,
    mtime,
    kind: 'html',
    mime: 'text/html',
  } as ProjectFile;
}

const FILES = [htmlFile('about.html', 1), htmlFile('index.html', 2)];

// The first FileWorkspace mount in a worker is slow on a loaded machine.
describe('FileWorkspace same-project link fragment (Loam Room finding a)', { timeout: 20_000 }, () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('passes the clicked link fragment to the preview it opens', async () => {
    function ControlledWorkspace() {
      const [tabs, setTabs] = useState<OpenTabsState>({ tabs: ['about.html'], active: 'about.html' });
      return (
        <FileWorkspace
          projectId="project-1"
          projectKind="prototype"
          files={FILES}
          liveArtifacts={[]}
          onRefreshFiles={vi.fn()}
          isDeck={false}
          tabsState={tabs}
          onTabsStateChange={setTabs}
        />
      );
    }
    render(<ControlledWorkspace />);

    const link = await screen.findByRole('button', { name: 'link-from-about.html' });
    act(() => {
      fireEvent.click(link);
    });

    await waitFor(() => {
      expect(screen.getByTestId('stub-viewer-index.html').getAttribute('data-location')).toBe('#work');
    });
  });

  it('turns a later plain link to the same file into a fresh request for the top', async () => {
    function ControlledWorkspace() {
      const [tabs, setTabs] = useState<OpenTabsState>({ tabs: ['about.html'], active: 'about.html' });
      return (
        <FileWorkspace
          projectId="project-1"
          projectKind="prototype"
          files={FILES}
          liveArtifacts={[]}
          onRefreshFiles={vi.fn()}
          isDeck={false}
          tabsState={tabs}
          onTabsStateChange={setTabs}
        />
      );
    }
    render(<ControlledWorkspace />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'link-from-about.html' }));
    });
    const viewer = await screen.findByTestId('stub-viewer-index.html');
    await waitFor(() => expect(viewer.getAttribute('data-location')).toBe('#work'));
    const fragmentNonce = viewer.getAttribute('data-nonce');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'plain-link-from-index.html' }));
    });

    await waitFor(() => {
      const current = screen.getByTestId('stub-viewer-index.html');
      expect(current.getAttribute('data-nonce')).not.toBe('none');
      expect(current.getAttribute('data-nonce')).not.toBe(fragmentNonce);
      expect(current.getAttribute('data-location')).toBe('');
    });
  });
});
