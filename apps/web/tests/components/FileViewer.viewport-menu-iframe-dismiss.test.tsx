// @vitest-environment jsdom
//
// OPEND-2035 red spec: the preview device/viewport dropdown stays open when
// the user clicks the preview.
//
// The menu already implements a textbook click-outside on the host document:
//
//   document.addEventListener('pointerdown', e => {
//     if (!menuRef.current.contains(e.target)) setOpen(false);
//   });
//
// That handler is correct and it works — but it can only see pointer events
// that reach THIS document. The preview is rendered into a sandboxed iframe
// (`sandbox="allow-scripts allow-downloads"`, i.e. an opaque origin), so a
// click that lands on the preview dispatches inside the frame's own document
// and never reaches the host. Measured live against a real runtime: clicking
// host chrome delivered 1 host pointerdown and closed the menu; clicking the
// preview delivered 0 and left the menu open — and the preview is by far the
// largest, most natural place to click when dismissing a menu.
//
// The one signal the host does reliably get is focus leaving the top-level
// document for the frame, which is exactly what a click on the preview does.
// This spec freezes that: focus moving into an iframe must dismiss the menu.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { CollabProvider, type CollabContextValue } from '../../src/collab/collab-context';
import { FileViewer } from '../../src/components/FileViewer';
import { resetSharedCancellableGet } from '../../src/lib/shared-cancellable-get';
import type { ProjectFile } from '../../src/types';
import { workspaceContextFixture } from '../helpers/workspace-context';

const WORKSPACE_CONTEXT = workspaceContextFixture({
  workspaceId: 'ws-viewport-menu',
  workspaceMemberId: 'member-viewport-menu',
});

function collabValue(): CollabContextValue {
  return {
    workspaceContext: WORKSPACE_CONTEXT,
    workspaceContextLoading: false,
    projectResourceAuthority: 'workspace',
    enabled: false,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'pending',
    isOwner: false,
    isEffectiveOwner: false,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
}

function Wrap({ children }: { children: ReactNode }) {
  return <CollabProvider value={collabValue()}>{children}</CollabProvider>;
}

function pageFile(): ProjectFile {
  return {
    name: 'page.html',
    path: 'page.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
  };
}

const PAGE_HTML = '<html><body><h1>preview</h1></body></html>';

function installFetchMock(projectId: string) {
  const filesUrl = `/api/projects/${encodeURIComponent(projectId)}/files`;
  const rawUrl = `/api/projects/${encodeURIComponent(projectId)}/raw/page.html`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (url.split('?')[0] === filesUrl) {
      return new Response(
        JSON.stringify({ files: [pageFile()] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(rawUrl)) return new Response(PAGE_HTML, { status: 200 });
    return new Response('', { status: 404 });
  }));
}

function viewportTrigger(): HTMLButtonElement {
  const trigger = document.querySelector('.viewer-viewport-trigger');
  if (!(trigger instanceof HTMLButtonElement)) throw new Error('viewport trigger not rendered');
  return trigger;
}

function menuIsOpen(): boolean {
  return viewportTrigger().getAttribute('aria-expanded') === 'true';
}

beforeEach(() => {
  resetSharedCancellableGet();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview viewport menu dismissal (OPEND-2035)', () => {
  it('closes when a click lands in the preview iframe (focus leaves the host document)', async () => {
    const projectId = 'proj-viewport-menu-iframe';
    installFetchMock(projectId);

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={pageFile()} />
      </Wrap>,
    );

    await waitFor(() => expect(document.querySelector('.viewer-viewport-trigger')).not.toBeNull());
    fireEvent.click(viewportTrigger());
    await waitFor(() => expect(menuIsOpen()).toBe(true));

    // A click that lands on the sandboxed preview: the host document sees no
    // pointerdown at all, only focus moving to the frame element.
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    act(() => {
      frame!.focus();
      window.dispatchEvent(new Event('blur'));
    });

    await waitFor(() => expect(menuIsOpen()).toBe(false));
  });

  it('stays open when the window merely loses focus without the preview taking it', async () => {
    const projectId = 'proj-viewport-menu-app-switch';
    installFetchMock(projectId);

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={pageFile()} />
      </Wrap>,
    );

    await waitFor(() => expect(document.querySelector('.viewer-viewport-trigger')).not.toBeNull());
    fireEvent.click(viewportTrigger());
    await waitFor(() => expect(menuIsOpen()).toBe(true));

    // Switching to another application blurs the window too. The menu is not
    // being dismissed by the user in that case, so it must survive — dropping
    // it would make the menu vanish every time the user alt-tabs away.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(menuIsOpen()).toBe(true);
  });
});

describe('preview viewport document transition', () => {
  it('navigates the active URL preview after switching Mobile to Desktop', async () => {
    const projectId = 'proj-viewport-document-transition';
    installFetchMock(projectId);

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={pageFile()} />
      </Wrap>,
    );

    const frame = await waitFor(() => {
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="url-load"][data-od-active="true"]');
      if (!node?.getAttribute('src') || node.getAttribute('src') === 'about:blank') {
        throw new Error('active URL preview has not loaded');
      }
      return node;
    });
    const initialSrc = frame.getAttribute('src');

    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-mobile')).not.toBeNull());
    const mobileSrc = frame.getAttribute('src');
    expect(mobileSrc).not.toBe(initialSrc);

    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Desktop' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-desktop')).not.toBeNull());
    const desktopSrc = frame.getAttribute('src');
    expect(desktopSrc).not.toBe(mobileSrc);
    expect(desktopSrc).toContain(`/api/projects/${projectId}/`);

    // Selecting the already active viewport should leave the document alone.
    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Desktop' }));
    expect(frame.getAttribute('src')).toBe(desktopSrc);
  });

  it('replaces an active srcDoc document after a device viewport change', async () => {
    const projectId = 'proj-srcdoc-viewport-transition';
    installFetchMock(projectId);
    const file: ProjectFile = {
      ...pageFile(),
      artifactManifest: {
        version: 1,
        kind: 'deck',
        title: 'Deck',
        entry: 'page.html',
        renderer: 'deck-html',
        exports: ['html'],
      },
    };

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={file} isDeck />
      </Wrap>,
    );

    const initialFrame = await waitFor(() => {
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      if (!node?.getAttribute('srcdoc')) throw new Error('active srcDoc preview has not loaded');
      return node;
    });

    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));

    await waitFor(() => {
      const nextFrame = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      expect(nextFrame).not.toBe(initialFrame);
      expect(nextFrame?.getAttribute('srcdoc')).not.toBeNull();
    });
  });

  it('keeps an in-progress Manual Edit document when the viewport changes', async () => {
    const projectId = 'proj-edit-viewport-transition';
    installFetchMock(projectId);
    const file: ProjectFile = {
      ...pageFile(),
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: 'Page',
        entry: 'page.html',
        renderer: 'html',
        exports: ['html'],
      },
    };

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={file} />
      </Wrap>,
    );
    const editToggle = await screen.findByTestId('manual-edit-mode-toggle');
    await waitFor(() => expect(editToggle).not.toBeDisabled());
    fireEvent.click(editToggle);
    const editFrame = await waitFor(() => {
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      if (!node) throw new Error('Manual Edit document is not active');
      return node;
    });
    // Represents authored startup layout bound to the original browsing
    // context. jsdom does not execute the site's layout script in this frame.
    editFrame.dataset.startupViewport = 'desktop';

    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-mobile')).not.toBeNull());
    expect(document.querySelector('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]')).toBe(editFrame);
    expect(editFrame.dataset.startupViewport).toBe('desktop');

    // The first switch preserves the live editing document. Once its safe
    // exit completes, a later Edit entry must not reuse that Desktop-sized
    // browsing context for the selected Mobile viewport.
    fireEvent.click(editToggle);
    await waitFor(() => {
      expect(editToggle.getAttribute('aria-pressed')).toBe('false');
      expect(document.querySelector('iframe[data-od-render-mode="url-load"][data-od-active="true"]')).not.toBeNull();
    });
    fireEvent.click(editToggle);
    await waitFor(() => {
      expect(editToggle.getAttribute('aria-pressed')).toBe('true');
      const returnedFrame = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      expect(returnedFrame).not.toBe(editFrame);
      expect(returnedFrame?.dataset.startupViewport).toBeUndefined();
    });
  });

  it('uses the current viewport when an Edit capture resolves after a device switch', async () => {
    const projectId = 'proj-delayed-edit-viewport';
    installFetchMock(projectId);
    const file: ProjectFile = {
      ...pageFile(),
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: 'Page',
        entry: 'page.html',
        renderer: 'html',
        exports: ['html'],
      },
    };

    render(
      <Wrap>
        <FileViewer projectId={projectId} projectKind="prototype" file={file} />
      </Wrap>,
    );
    const editToggle = await screen.findByTestId('manual-edit-mode-toggle');
    await waitFor(() => expect(editToggle).not.toBeDisabled());
    const desktopUrlFrame = await waitFor(() => {
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="url-load"][data-od-active="true"]');
      if (!node?.contentWindow) throw new Error('Desktop URL preview is not active');
      return node;
    });
    const desktopSourceWindow = desktopUrlFrame.contentWindow!;
    const firstPostMessage = vi.spyOn(desktopSourceWindow, 'postMessage');
    fireEvent.click(editToggle);
    const firstCapture = await waitFor(() => {
      const request = firstPostMessage.mock.calls.map(([value]) => value).find((value) => (
        typeof value === 'object' && value !== null
        && (value as { type?: unknown }).type === 'od:preview-runtime-state-capture'
      )) as { id: string } | undefined;
      if (!request?.id) throw new Error('Edit capture did not start');
      return request;
    });
    expect(editToggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-mobile')).not.toBeNull());
    const staleDesktopState = {
      version: 1 as const,
      hash: '',
      bodyHtml: '<main data-startup-viewport="desktop">old layout</main>',
      roots: [],
      htmlAttrs: {},
      bodyAttrs: {},
      entries: [],
    };
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: desktopSourceWindow,
        data: { type: 'od:preview-runtime-state-captured', id: firstCapture.id, state: staleDesktopState },
      }));
    });
    const mobileEditFrame = await waitFor(() => {
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      if (!node) throw new Error('Mobile Edit preview did not become active');
      return node;
    });
    mobileEditFrame.dataset.startupViewport = 'mobile';
    const mobilePostMessage = vi.spyOn(mobileEditFrame.contentWindow!, 'postMessage');
    fireEvent.load(mobileEditFrame);
    expect(document.querySelector('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]')).toBe(mobileEditFrame);
    const mobileGeneration = mobileEditFrame.srcdoc.match(
      /data-od-srcdoc-transport-activation>[\s\S]*?var generation = "([^"]+)";/,
    )?.[1];
    expect(mobileGeneration).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: mobileEditFrame.contentWindow,
        data: { type: 'od:preview-runtime-state-restore-ready', generation: mobileGeneration },
      }));
    });
    expect(mobilePostMessage.mock.calls.some(([message]) => (
      typeof message === 'object' && message !== null
      && (message as { type?: unknown }).type === 'od:preview-runtime-state-restore'
    ))).toBe(false);

    fireEvent.click(editToggle);
    await waitFor(() => expect(editToggle.getAttribute('aria-pressed')).toBe('false'));
    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Desktop' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-desktop')).not.toBeNull());

    const currentUrlFrame = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="url-load"][data-od-active="true"]');
    if (!currentUrlFrame?.contentWindow) throw new Error('Desktop URL preview did not return');
    const secondCaptureWindow = currentUrlFrame.contentWindow;
    const secondPostMessage = vi.spyOn(secondCaptureWindow, 'postMessage');
    fireEvent.click(editToggle);
    const secondCapture = await waitFor(() => {
      const request = secondPostMessage.mock.calls.map(([value]) => value).find((value) => (
        typeof value === 'object' && value !== null
        && (value as { type?: unknown }).type === 'od:preview-runtime-state-capture'
        && (value as { id?: unknown }).id !== firstCapture.id
      )) as { id: string } | undefined;
      if (!request?.id) throw new Error('Second Edit capture did not start');
      return request;
    });
    // Return to the same preset before the old document answers. Comparing
    // only the current viewport value would accept this stale Desktop state.
    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Mobile' }));
    fireEvent.click(viewportTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Desktop' }));
    await waitFor(() => expect(document.querySelector('.preview-viewport-desktop')).not.toBeNull());
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: secondCaptureWindow,
        data: { type: 'od:preview-runtime-state-captured', id: secondCapture.id, state: staleDesktopState },
      }));
    });
    const desktopEditFrame = await waitFor(() => {
      expect(editToggle.getAttribute('aria-pressed')).toBe('true');
      const node = document.querySelector<HTMLIFrameElement>('iframe[data-od-render-mode="srcdoc"][data-od-active="true"]');
      if (!node) throw new Error('Desktop Edit preview did not become active');
      return node;
    });
    expect(desktopEditFrame).not.toBe(mobileEditFrame);
    expect(desktopEditFrame.dataset.startupViewport).toBeUndefined();
    const desktopPostMessage = vi.spyOn(desktopEditFrame.contentWindow!, 'postMessage');
    fireEvent.load(desktopEditFrame);
    const desktopGeneration = desktopEditFrame.srcdoc.match(
      /data-od-srcdoc-transport-activation>[\s\S]*?var generation = "([^"]+)";/,
    )?.[1];
    expect(desktopGeneration).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: desktopEditFrame.contentWindow,
        data: { type: 'od:preview-runtime-state-restore-ready', generation: desktopGeneration },
      }));
    });
    expect(desktopPostMessage.mock.calls.some(([message]) => (
      typeof message === 'object' && message !== null
      && (message as { type?: unknown }).type === 'od:preview-runtime-state-restore'
    ))).toBe(false);
  });
});
