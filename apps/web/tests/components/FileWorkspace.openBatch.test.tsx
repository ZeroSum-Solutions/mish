// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

function imageFile(name: string, mtime: number): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 128,
    mtime,
    kind: 'image',
    mime: 'image/png',
  } as ProjectFile;
}

const FILES = [
  imageFile('image-01.png', 1),
  imageFile('image-02.png', 2),
  imageFile('image-03.png', 3),
  imageFile('image-04.png', 4),
];

// OPEND-2588: the host asks for a whole finished turn's artifacts in ONE
// request. ProjectView's own suite mocks FileWorkspace away, so this is the
// only place that proves the workspace actually materializes N tabs.
describe('FileWorkspace batched open request', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens every file in the batch and activates the requested one', async () => {
    const onTabsStateChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={FILES}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={onTabsStateChange}
        openRequest={{
          name: 'image-04.png',
          nonce: 1,
          openBatch: ['image-01.png', 'image-02.png', 'image-03.png', 'image-04.png'],
        }}
      />,
    );

    await waitFor(() =>
      expect(onTabsStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          tabs: ['image-01.png', 'image-02.png', 'image-03.png', 'image-04.png'],
          active: 'image-04.png',
        }),
      ),
    );
  });

  it('does not duplicate a tab the turn already opened mid-stream', async () => {
    const onTabsStateChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={FILES}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['image-02.png'], active: 'image-02.png' }}
        onTabsStateChange={onTabsStateChange}
        openRequest={{
          name: 'image-04.png',
          nonce: 1,
          openBatch: ['image-01.png', 'image-02.png', 'image-03.png', 'image-04.png'],
        }}
      />,
    );

    await waitFor(() =>
      expect(onTabsStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          tabs: ['image-02.png', 'image-01.png', 'image-03.png', 'image-04.png'],
          active: 'image-04.png',
        }),
      ),
    );
  });

  it.each(['single', 'batch'] as const)('opens a late %s delivery without replacing the active tab', async (mode) => {
    const onTabsStateChange = vi.fn();
    const request = {
      name: 'image-01.png',
      nonce: 1,
      background: true,
      ...(mode === 'batch' ? { openBatch: ['image-01.png', 'image-02.png'] } : {}),
    };
    function ControlledWorkspace() {
      const [tabs, setTabs] = useState<OpenTabsState>({ tabs: ['image-04.png'], active: 'image-04.png' });
      return <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={FILES}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={tabs}
        onTabsStateChange={(next) => { onTabsStateChange(next); setTabs(next); }}
        openRequest={request}
      />;
    }
    render(<ControlledWorkspace />);
    await waitFor(() => expect(onTabsStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tabs: mode === 'batch'
          ? ['image-04.png', 'image-01.png', 'image-02.png']
          : ['image-04.png', 'image-01.png'],
        active: 'image-04.png',
      }),
    ));
    expect(screen.getByRole('tab', { name: /image-04\.png/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /image-01\.png/i }).getAttribute('aria-selected')).toBe('false');
  });

  it('still opens a single-file request the old way', async () => {
    const onTabsStateChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={FILES}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={onTabsStateChange}
        openRequest={{ name: 'image-02.png', nonce: 1 }}
      />,
    );

    await waitFor(() =>
      expect(onTabsStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ tabs: ['image-02.png'], active: 'image-02.png' }),
      ),
    );
  });
});
