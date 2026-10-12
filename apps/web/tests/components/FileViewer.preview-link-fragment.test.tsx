// @vitest-environment jsdom
// Loam Room finding (a): a same-project link such as `index.html#work`
// clicked inside the preview opened index.html at the top. The injected
// bridge posts `od:preview-open-file` with `{ fileName, search, hash }`, but
// the host forwarded only `fileName`, so the fragment never reached the
// opened preview. These specs pin each hop: the listener forwards a validated
// location, and the opened preview applies it on both render paths.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function htmlFile(name: string, overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: name,
      entry: name,
      renderer: 'html',
      exports: ['html'],
    },
    ...overrides,
  };
}

function deckFile(): ProjectFile {
  return htmlFile('deck.html', {
    artifactManifest: {
      version: 1,
      kind: 'deck',
      title: 'Deck',
      entry: 'deck.html',
      renderer: 'deck-html',
      exports: ['html'],
    },
  });
}

const PAGE_HTML = '<html><body><main><section id="work">Work</section></main></body></html>';
const DECK_HTML = '<html><body><section class="slide" id="work">one</section><section class="slide">two</section></body></html>';

function activeFrame(): HTMLIFrameElement {
  return screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
}

function postFromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
}

function restoreMessagesTo(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls
    .map((call: unknown[]) => call[0] as { type?: string; hash?: string })
    .filter((message: { type?: string }) => message?.type === 'od:preview-scroll-restore');
}

describe('FileViewer same-project link fragment (Loam Room finding a)', () => {
  it('forwards the validated search and hash of an od:preview-open-file message', () => {
    const onOpenFileReplacing = vi.fn();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile('about.html')}
        liveHtml={PAGE_HTML}
        onOpenFileReplacing={onOpenFileReplacing}
      />,
    );
    const frame = activeFrame();
    expect(frame.getAttribute('data-od-render-mode')).toBe('url-load');

    postFromFrame(frame, {
      type: 'od:preview-open-file',
      fileName: 'index.html',
      search: '?tab=2',
      hash: '#work',
    });

    expect(onOpenFileReplacing).toHaveBeenCalledWith('index.html', 'about.html', {
      search: '?tab=2',
      hash: '#work',
    });
  });

  it.each([
    ['a hash with markup', { search: '', hash: '#"><img src=x>' }, { search: '', hash: '' }],
    ['an over-long hash', { search: '', hash: `#${'a'.repeat(256)}` }, { search: '', hash: '' }],
    ['a search carrying a fragment', { search: '?a=1#b', hash: '#work' }, { search: '', hash: '#work' }],
    ['a search with control characters', { search: '?a=\n1', hash: '' }, { search: '', hash: '' }],
    ['a search without its leading ?', { search: 'a=1', hash: '' }, { search: '', hash: '' }],
    ['non-string values', { search: 7, hash: { toString: (): string => '#work' } }, { search: '', hash: '' }],
  ])('drops %s but still opens the file', (_label, location, expected) => {
    const onOpenFileReplacing = vi.fn();
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile('about.html')}
        liveHtml={PAGE_HTML}
        onOpenFileReplacing={onOpenFileReplacing}
      />,
    );

    postFromFrame(activeFrame(), { type: 'od:preview-open-file', fileName: 'index.html', ...location });

    expect(onOpenFileReplacing).toHaveBeenCalledWith('index.html', 'about.html', expected);
  });

  it('URL-load: carries the fragment on the iframe src and answers the load-time scroll request with it', async () => {
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile('index.html')}
        liveHtml={PAGE_HTML}
        previewLocationRequest={{ search: '?tab=2', hash: '#work', nonce: 1 }}
      />,
    );
    const frame = activeFrame();
    expect(frame.getAttribute('data-od-render-mode')).toBe('url-load');
    const src = frame.getAttribute('src') ?? '';
    expect(src.endsWith('#work')).toBe(true);
    expect(new URL(src, window.location.href).searchParams.get('tab')).toBe('2');
    expect(src).toContain('odPreviewBridge=scroll');

    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    postFromFrame(frame, { type: 'od:preview-scroll-request' });

    await waitFor(() => {
      expect(restoreMessagesTo(postSpy)).toContainEqual(
        expect.objectContaining({ type: 'od:preview-scroll-restore', hash: '#work' }),
      );
    });
  });

  it('srcDoc: answers the load-time scroll request with the fragment so the frame navigates to it', async () => {
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={deckFile()}
        isDeck
        liveHtml={DECK_HTML}
        previewLocationRequest={{ search: '', hash: '#work', nonce: 1 }}
      />,
    );
    const frame = activeFrame();
    expect(frame.getAttribute('data-od-render-mode')).toBe('srcdoc');

    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    postFromFrame(frame, { type: 'od:preview-scroll-request' });

    await waitFor(() => {
      expect(restoreMessagesTo(postSpy)).toContainEqual(
        expect.objectContaining({ type: 'od:preview-scroll-restore', hash: '#work' }),
      );
    });
  });

  it('a plain open restores coordinates without a fragment', async () => {
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile('index.html')}
        liveHtml={PAGE_HTML}
      />,
    );
    const frame = activeFrame();
    expect(frame.getAttribute('src') ?? '').not.toContain('#');
    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    postFromFrame(frame, { type: 'od:preview-scroll-request' });

    await waitFor(() => expect(restoreMessagesTo(postSpy).length).toBeGreaterThan(0));
    expect(restoreMessagesTo(postSpy).every((message: { hash?: string }) => message.hash === undefined)).toBe(true);
  });

  it('an already-open file navigates its live document when a new fragment arrives', async () => {
    // srcDoc keeps the same document across the request, so the live
    // document must be told to navigate. (On the URL path a fragment-only src
    // change is a same-document navigation in a real browser; jsdom replaces
    // the window instead, so the Playwright spec covers that path.)
    const { rerender } = render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={deckFile()}
        isDeck
        liveHtml={DECK_HTML}
      />,
    );
    const frame = activeFrame();
    expect(frame.getAttribute('data-od-render-mode')).toBe('srcdoc');
    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');

    rerender(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={deckFile()}
        isDeck
        liveHtml={DECK_HTML}
        previewLocationRequest={{ search: '', hash: '#work', nonce: 2 }}
      />,
    );

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'od:preview-navigate-fragment', hash: '#work', fragmentNonce: 2 }),
        '*',
      );
    });
  });

  it('hands scroll ownership back to the frame once it confirms the fragment', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile('index.html')}
        liveHtml={PAGE_HTML}
        previewLocationRequest={{ search: '', hash: '#work', nonce: 3 }}
      />,
    );
    const frame = activeFrame();
    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');

    postFromFrame(frame, { type: 'od:preview-scroll-request' });
    await waitFor(() => expect(restoreMessagesTo(postSpy).at(-1)?.hash).toBe('#work'));
    postFromFrame(frame, { type: 'od:preview-fragment-applied', fragmentNonce: 3 });

    now += 5_000;
    postSpy.mockClear();
    postFromFrame(frame, { type: 'od:preview-scroll-request' });
    await waitFor(() => expect(restoreMessagesTo(postSpy).length).toBeGreaterThan(0));
    expect(restoreMessagesTo(postSpy).at(-1)?.hash).toBeUndefined();
  });

  it('a retained viewer\'s saved scroll snapshot does not undo the link fragment when it is reactivated', async () => {
    // srcDoc keeps one document across the whole sequence, so every restore
    // the host sends is observable. (jsdom swaps the URL-load window on a src
    // change; the URL path shares the same host-side rule.)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const props = {
      projectId: 'project-1',
      projectKind: 'prototype' as const,
      file: deckFile(),
      isDeck: true,
      liveHtml: DECK_HTML,
    };
    const { rerender } = render(<FileViewer {...props} />);
    const frame = activeFrame();
    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    postFromFrame(frame, {
      type: 'od:preview-scroll',
      frameLeft: 0,
      frameTop: 640,
      canvasLeft: 0,
      canvasTop: 640,
    });
    // Toggling Draw saves a scroll snapshot that the activation restore replays.
    fireEvent.click(screen.getByTestId('draw-overlay-toggle'));
    fireEvent.click(screen.getByTestId('draw-overlay-toggle'));
    await waitFor(() => {
      expect(restoreMessagesTo(postSpy)).toContainEqual(
        expect.objectContaining({ frameTop: 640 }),
      );
    });

    rerender(<FileViewer {...props} workspaceActive={false} />);
    postSpy.mockClear();
    rerender(
      <FileViewer
        {...props}
        workspaceActive
        previewLocationRequest={{ search: '', hash: '#work', nonce: 1 }}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    // No restore may carry the saved coordinates without the fragment, and
    // the frame is told to land on #work.
    const restores = restoreMessagesTo(postSpy);
    expect(restores.every((message: { hash?: string }) => message.hash === '#work')).toBe(true);
    const navigations = postSpy.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; hash?: string })
      .filter((message: { type?: string; hash?: string }) => message?.hash === '#work');
    expect(navigations.length).toBeGreaterThan(0);
  });

  it('srcDoc: a later plain link to the same file navigates to the top instead of keeping the old fragment', async () => {
    const props = {
      projectId: 'project-1',
      projectKind: 'prototype' as const,
      file: deckFile(),
      isDeck: true,
      liveHtml: DECK_HTML,
    };
    const { rerender } = render(
      <FileViewer {...props} previewLocationRequest={{ search: '', hash: '#work', nonce: 1 }} />,
    );
    const frame = activeFrame();
    const postSpy = vi.spyOn(frame.contentWindow!, 'postMessage');
    postFromFrame(frame, { type: 'od:preview-fragment-applied', fragmentNonce: 1 });

    rerender(<FileViewer {...props} previewLocationRequest={{ search: '', hash: '', nonce: 2 }} />);

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'od:preview-navigate-fragment', hash: '', fragmentNonce: 2 }),
        '*',
      );
    });
    postFromFrame(frame, { type: 'od:preview-scroll-request' });
    await waitFor(() => {
      expect(restoreMessagesTo(postSpy).at(-1)).toEqual(
        expect.objectContaining({ hash: '', fragmentNonce: 2 }),
      );
    });
  });

  it('URL-load: a later plain link to the same file drops the old fragment from the src', () => {
    const props = {
      projectId: 'project-1',
      projectKind: 'prototype' as const,
      file: htmlFile('index.html'),
      liveHtml: PAGE_HTML,
    };
    const { rerender } = render(
      <FileViewer {...props} previewLocationRequest={{ search: '?tab=2', hash: '#work', nonce: 1 }} />,
    );
    expect(activeFrame().getAttribute('src')).toMatch(/tab=2#work$/);

    rerender(<FileViewer {...props} previewLocationRequest={{ search: '', hash: '', nonce: 2 }} />);

    const src = activeFrame().getAttribute('src') ?? '';
    expect(src).not.toContain('#');
    expect(src).not.toContain('tab=2');
  });
});
