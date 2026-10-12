// @vitest-environment jsdom
// B6-3 canvas mount: the project's file canvas exposes the media workbench to
// editors only, and opening it is the first thing that touches the media API.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignFilesPanel } from '../../../src/components/DesignFilesPanel';
import { I18nProvider } from '../../../src/i18n';

const lsStore = new Map<string, string>();

beforeEach(() => {
  lsStore.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => lsStore.get(key) ?? null,
    setItem: (key: string, value: string) => { lsStore.set(key, value); },
    removeItem: (key: string) => { lsStore.delete(key); },
    clear: () => { lsStore.clear(); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel(viewerOnly: boolean) {
  return render(
    <I18nProvider>
      <DesignFilesPanel
        projectId="p"
        projectKind="prototype"
        viewerOnly={viewerOnly}
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenLiveArtifact={vi.fn()}
        onRenameFile={vi.fn()}
        onDeleteFile={vi.fn()}
        onDeleteFiles={vi.fn()}
        onUpload={vi.fn()}
        onUploadFiles={vi.fn()}
        onPaste={vi.fn()}
        onNewSketch={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('DesignFilesPanel media workbench mount', () => {
  it('offers the media workbench to editors and loads nothing from the media API until it is opened', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/media/models') return new Response(JSON.stringify({ providers: [], image: [], video: [], aspects: [], videoLengthsSec: [] }));
      if (url.startsWith('/api/projects/p/media/gallery')) return new Response(JSON.stringify({ entries: [], nextCursor: null, limit: 50 }));
      return new Response('{}');
    }));
    renderPanel(false);
    const trigger = screen.getByTestId('media-workbench-trigger');
    expect(urls.some((url) => url.includes('/media/'))).toBe(false);
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Media workbench' });
    await waitFor(() => expect(urls).toContain('/api/media/models'));
    await waitFor(() => expect(urls.some((url) => url.startsWith('/api/projects/p/media/gallery'))).toBe(true));
  });

  it('does not offer media generation in a read-only canvas', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    renderPanel(true);
    expect(screen.queryByTestId('media-workbench-trigger')).toBeNull();
  });
});
