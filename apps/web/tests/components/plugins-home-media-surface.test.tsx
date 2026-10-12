// @vitest-environment jsdom

// Plugins-home media preview surface — broken-poster fallback.
//
// Before #2955 the MediaSurface card rendered `preview.poster`
// straight into an `<img>` with no error handler. When an official
// project's poster URL pointed at an asset the browser could not
// fetch (404, decode error, CSP/CORS reject, or just a dead host),
// the card was left with the browser's default broken-image glyph
// instead of the typographic fallback that no-poster cards already
// use. On the Home page that turned the discovery surface into a
// row of "looks-broken" tiles for official content (issue #2955).
//
// This file pins the new behavior: a failed poster load swaps in
// the same `plugins-home__media-fallback` element that runs for
// poster-less entries, so the discovery surface degrades cleanly
// instead of leaving a broken-image state.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MediaSurface } from '../../src/components/plugins-home/cards/MediaSurface';
import type { MediaPreviewSpec } from '../../src/components/plugins-home/preview';

const POSTER: MediaPreviewSpec = {
  kind: 'media',
  mediaType: 'image',
  poster: 'https://example.invalid/poster.png',
  videoUrl: null,
  audioUrl: null,
  imageOnly: true,
};

const VIDEO_POSTER: MediaPreviewSpec = {
  ...POSTER,
  mediaType: 'video',
  videoUrl: 'https://example.invalid/preview.mp4',
  imageOnly: false,
};

// A baked hover-pan clip: `loopHoldMs` set => idlePlays, so the <video> mounts
// across the wide margin and we can assert its tiered preload.
const BAKED_CLIP: MediaPreviewSpec = {
  ...VIDEO_POSTER,
  videoUrl: 'https://example.invalid/clip.mp4',
  loopHoldMs: 2500,
};

// `URL.createObjectURL` / `revokeObjectURL` do not exist in jsdom, and the
// controlled clip path is defined by exactly three calls: the request, the
// object URL it produces, and the revoke that releases it. Stubbing all three
// is what makes those calls observable.
function stubObjectUrls() {
  let issued = 0;
  const revoked: string[] = [];
  const createObjectURL = vi.fn(() => `blob:clip-${++issued}`);
  const revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  return { createObjectURL, revokeObjectURL, revoked };
}

/** The shape the clip effect reads off a `fetch` response. */
function clipResponse(ok = true, status = 200) {
  return { ok, status, blob: async () => new Blob(['clip-bytes']) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('MediaSurface broken-poster fallback (#2955)', () => {
  it('renders the poster <img> by default when a poster URL is provided and the card is in view', () => {
    const { container } = render(
      <MediaSurface preview={POSTER} pluginTitle="Example" inView={true} />,
    );
    const img = container.querySelector('img.plugins-home__media-img');
    expect(img).not.toBeNull();
    expect((img as HTMLImageElement).src).toContain('poster.png');
    expect(container.querySelector('.plugins-home__media-fallback')).toBeNull();
  });

  it('swaps in the typographic fallback when the poster fails to load (the headline #2955 scenario)', () => {
    // Browsers emit an `error` event on the <img> when the URL 404s,
    // the decode fails, or the host is unreachable. Without an
    // onError handler the element stayed in the DOM and the browser
    // painted its default broken-image glyph — the broken tile users
    // were seeing on official Home cards.
    const { container } = render(
      <MediaSurface preview={POSTER} pluginTitle="Example" inView={true} />,
    );
    const img = container.querySelector('img.plugins-home__media-img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    // After the error, the broken <img> is gone and the typographic
    // fallback element is mounted in its place.
    expect(container.querySelector('img.plugins-home__media-img')).toBeNull();
    expect(container.querySelector('.plugins-home__media-fallback')).not.toBeNull();
  });

  it('resets the failed-state when the poster URL changes so a recovered/different poster gets a fresh attempt', () => {
    // Two real-world scenarios that hit this path:
    //   1. The Home page rotates through filters and the same
    //      `MediaSurface` instance gets a different plugin's poster
    //      assigned. The previous failure must not poison the new
    //      URL.
    //   2. An offline-then-online flip where the daemon repopulates
    //      poster URLs. The card has to recover instead of staying
    //      stuck on the fallback for the session.
    const { container, rerender } = render(
      <MediaSurface preview={POSTER} pluginTitle="Example" inView={true} />,
    );
    const img = container.querySelector('img.plugins-home__media-img');
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector('.plugins-home__media-fallback')).not.toBeNull();

    const recovered: MediaPreviewSpec = {
      ...POSTER,
      poster: 'https://example.invalid/different-poster.png',
    };
    rerender(<MediaSurface preview={recovered} pluginTitle="Example" inView={true} />);
    expect(container.querySelector('img.plugins-home__media-img')).not.toBeNull();
    expect(container.querySelector('.plugins-home__media-fallback')).toBeNull();
  });

  it('still renders the typographic fallback directly when the spec has no poster URL (no regression for poster-less entries)', () => {
    // Regression guard for the original `!hasPoster` branch — the new
    // error-handling logic must not break entries that never had a
    // poster URL to begin with.
    const noPoster: MediaPreviewSpec = { ...POSTER, poster: null };
    const { container } = render(
      <MediaSurface preview={noPoster} pluginTitle="Example" inView={true} />,
    );
    expect(container.querySelector('img.plugins-home__media-img')).toBeNull();
    expect(container.querySelector('.plugins-home__media-fallback')).not.toBeNull();
  });

  it('does not render a passive play badge for video cards that already auto-play on hover', () => {
    const { container } = render(
      <MediaSurface preview={VIDEO_POSTER} pluginTitle="Video example" inView={true} />,
    );
    expect(container.querySelector('.plugins-home__media-badge')).toBeNull();
  });
});

describe('MediaSurface remote-media privacy and failure (no-referrer, dead clip)', () => {
  it('sends no referrer from the poster element', () => {
    // `referrerpolicy` is defined on <img> and honoured there. It is NOT an
    // attribute HTML defines on media elements, so the clip's policy cannot be
    // stated on the element — see the controlled-retrieval block below.
    const { container } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
    );
    expect(container.querySelector('img.plugins-home__media-img')!
      .getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('drops a dead clip and raises onMediaError so the caller can swap surfaces', () => {
    const onMediaError = vi.fn();
    const { container } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        onMediaError={onMediaError}
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent.error(video);
    expect(onMediaError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('video')).toBeNull();
  });

  it('raises onMediaError for a dead poster too', () => {
    const onMediaError = vi.fn();
    const { container } = render(
      <MediaSurface
        preview={POSTER}
        pluginTitle="Example"
        inView={true}
        onMediaError={onMediaError}
      />,
    );
    fireEvent.error(container.querySelector('img.plugins-home__media-img') as HTMLImageElement);
    expect(onMediaError).toHaveBeenCalledTimes(1);
  });

  it('gives a replaced clip URL its own attempt after a failure', () => {
    const { container, rerender } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
    );
    fireEvent.error(container.querySelector('video') as HTMLVideoElement);
    expect(container.querySelector('video')).toBeNull();

    rerender(
      <MediaSurface
        preview={{ ...BAKED_CLIP, videoUrl: 'https://example.invalid/clip-next.mp4' }}
        pluginTitle="Clip"
        inView={true}
      />,
    );
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('delivers a late observer callback and a late play rejection after unmount without a state update', async () => {
    // The clip mounts, autoplay is kicked off, and the tile scrolls away
    // before `loadeddata` or `error` ever arrives. Both of the things still
    // queued at that moment — the prefetch observer's callback and the
    // `play()` promise — are delivered here AFTER the unmount, which is the
    // only way to prove the cleanup actually holds. Unmounting alone proves
    // nothing: it leaves the queued work untouched.
    const errors: unknown[] = [];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    let disconnects = 0;
    const originalObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        disconnects += 1;
      }
    } as unknown as typeof IntersectionObserver;
    let rejectPlay: ((reason: unknown) => void) | null = null;
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => new Promise<void>((_resolve, reject) => {
        rejectPlay = reject;
      }),
    );

    try {
      const { container, unmount } = render(
        <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
      );
      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video.style.opacity).toBe('0');
      expect(playSpy).toHaveBeenCalled();

      unmount();
      // The observer is disconnected by the effect cleanup …
      expect(disconnects).toBe(1);

      // … and a callback the browser had already queued, plus the pending
      // play promise, still arrive afterwards. Neither may write state or
      // surface an unhandled rejection.
      await act(async () => {
        observerCallback?.([{ isIntersecting: true }]);
        rejectPlay?.(new DOMException('play() interrupted', 'AbortError'));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(errors).toEqual([]);
      expect(container.querySelector('video')).toBeNull();
    } finally {
      playSpy.mockRestore();
      consoleSpy.mockRestore();
      globalThis.IntersectionObserver = originalObserver;
    }
  });
});

// `referrerpolicy` is defined by HTML on img / a / area / iframe / link /
// script — not on media elements. A `<video src>` therefore cannot state a
// policy and hands the document URL to the media host as Referer. Reference
// cards point at third-party catalog hosts, so their clips are retrieved with
// an explicit policy and played back from the buffered copy.
describe('MediaSurface controlled clip retrieval (clipFetch)', () => {
  it('requests the clip with no referrer and plays the buffered copy', async () => {
    const urls = stubObjectUrls();
    const fetchMock = vi.fn(async () => clipResponse());
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:clip-1');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/clip.mp4',
      expect.objectContaining({
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
    // The element's own poster request cannot carry a policy either, and the
    // <img> above already paints that URL with one.
    expect(container.querySelector('video')?.hasAttribute('poster')).toBe(false);
  });

  it('leaves every other caller on the direct source', async () => {
    const fetchMock = vi.fn(async () => clipResponse());
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
    );

    expect(container.querySelector('video')?.getAttribute('src'))
      .toBe('https://example.invalid/clip.mp4');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an obsolete download when the card goes away mid-request', async () => {
    const urls = stubObjectUrls();
    type ClipResponse = ReturnType<typeof clipResponse>;
    let release: (response: ClipResponse) => void = () => {};
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<ClipResponse>((resolve, reject) => {
          release = resolve;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onMediaError = vi.fn();

    const { unmount } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
        onMediaError={onMediaError}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);

    // A response that still arrives builds nothing and raises nothing.
    release(clipResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(onMediaError).not.toHaveBeenCalled();
  });

  it('requests nothing for a card that is not in view', () => {
    const fetchMock = vi.fn(async () => clipResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={false}
        clipFetch="no-referrer"
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a non-ok response as a media error', async () => {
    stubObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async () => clipResponse(false, 403)));
    const onMediaError = vi.fn();

    const { container } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
        onMediaError={onMediaError}
      />,
    );

    await waitFor(() => expect(onMediaError).toHaveBeenCalledTimes(1));
    expect(container.querySelector('video')).toBeNull();
  });

  it('treats a failed request as a media error', async () => {
    stubObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down');
    }));
    const onMediaError = vi.fn();

    const { container } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
        onMediaError={onMediaError}
      />,
    );

    await waitFor(() => expect(onMediaError).toHaveBeenCalledTimes(1));
    expect(container.querySelector('video')).toBeNull();
  });

  it('releases the buffered copy when the card goes away', async () => {
    const urls = stubObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async () => clipResponse()));

    const { container, unmount } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
      />,
    );
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());

    unmount();
    expect(urls.revoked).toEqual(['blob:clip-1']);
  });

  it('releases the old copy and requests again when the clip URL changes', async () => {
    const urls = stubObjectUrls();
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      requested.push(input);
      return clipResponse();
    }));

    const { container, rerender } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:clip-1');
    });

    rerender(
      <MediaSurface
        preview={{ ...BAKED_CLIP, videoUrl: 'https://example.invalid/clip-next.mp4' }}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:clip-2');
    });
    expect(urls.revoked).toEqual(['blob:clip-1']);
    expect(requested).toEqual([
      'https://example.invalid/clip.mp4',
      'https://example.invalid/clip-next.mp4',
    ]);
  });

  it('buffers nothing when the response arrives after the card is gone', async () => {
    const urls = stubObjectUrls();
    let deliver: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      deliver = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <MediaSurface
        preview={BAKED_CLIP}
        pluginTitle="Clip"
        inView={true}
        clipFetch="no-referrer"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      deliver?.(clipResponse());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(urls.revoked).toEqual([]);
  });
});

describe('MediaSurface video-ready opacity gate (black first-frame flash)', () => {
  it('keeps a freshly-mounted video transparent until it reports a decoded frame', () => {
    // Some Chromium builds paint a solid black frame for an instant right as
    // autoplay starts decoding a freshly-mounted <video>, before any real
    // frame is ready. The video sits above the poster <img> (z-index), so
    // without this gate that flash blacks out the whole card — reported
    // against the community template gallery (recvqaaFFCGPBC). The poster
    // underneath must stay visible (video invisible) until `loadeddata`.
    const { container } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.style.opacity).toBe('0');

    fireEvent.loadedData(video);
    expect(video.style.opacity).toBe('1');
  });

  it('resets the ready gate when the video source itself changes', () => {
    const { container, rerender } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    fireEvent.loadedData(video);
    expect(video.style.opacity).toBe('1');

    const nextClip: MediaPreviewSpec = { ...BAKED_CLIP, videoUrl: 'https://example.invalid/clip-2.mp4' };
    rerender(<MediaSurface preview={nextClip} pluginTitle="Clip" inView={true} />);
    const nextVideo = container.querySelector('video') as HTMLVideoElement;
    expect(nextVideo.style.opacity).toBe('0');
  });
});

describe('MediaSurface tiered clip preload (scroll-in prefetch)', () => {
  it('keeps preload at metadata while mounted but before the prefetch zone is reached', () => {
    // A non-firing IntersectionObserver models the tile being mounted in the
    // wide margin but not yet in the prefetch zone: the observer never reports
    // in-view, so the internal `approaching` signal stays false.
    const orig = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      const { container } = render(
        <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} visible={false} />,
      );
      const video = container.querySelector('video');
      expect(video).not.toBeNull();
      expect(video!.getAttribute('preload')).toBe('metadata');
    } finally {
      globalThis.IntersectionObserver = orig;
    }
  });

  it('warms the full clip (preload=auto) once the prefetch zone is reached', () => {
    // jsdom ships no IntersectionObserver, so MediaSurface treats the prefetch
    // zone as reached immediately. The whole point of the
    // tier: the bytes are warmed into the HTTP cache a row or two ahead, so
    // playback starts instantly on scroll-in instead of buffering from the
    // +faststart header at the moment the tile appears.
    const { container } = render(
      <MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} visible={false} />,
    );
    const video = container.querySelector('video');
    expect(video!.getAttribute('preload')).toBe('auto');
  });

  it('starts observing when a reused media card becomes a baked clip', () => {
    // React can reuse the same MediaSurface instance while filters/feeds rotate
    // cards. A plain video card should not pay for the prefetch observer, but if
    // that same instance later receives a baked clip, the stable ref + idlePlays
    // effect dependency must subscribe then; otherwise it would stay stuck at
    // preload=metadata forever.
    const orig = globalThis.IntersectionObserver;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class {
      observe(node: Element) {
        observed.push(node);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      const { rerender } = render(
        <MediaSurface preview={VIDEO_POSTER} pluginTitle="Video" inView={true} visible={false} />,
      );
      expect(observed).toHaveLength(0);

      rerender(<MediaSurface preview={BAKED_CLIP} pluginTitle="Clip" inView={true} visible={false} />);
      expect(observed).toHaveLength(1);
    } finally {
      globalThis.IntersectionObserver = orig;
    }
  });
});
