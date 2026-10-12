/**
 * scroll-locked-video-hero — clean-room implementation from component-specs.md §9 only. No
 * upstream (21st.dev) source was fetched, read or recalled; only the spec's prose description
 * was used.
 *
 * A full-viewport hero stays pinned while the user scrolls through a tall track, and the scroll
 * position scrubs the media: a `<video>`'s `currentTime`, or a procedural `<canvas>` scene when
 * no media is supplied. The headline overlay fades and lifts in over the first `overlayOut`
 * fraction of the track.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`, adds
 * `.genui-scroll-locked-video-hero` and `data-genui-mounted`, and returns a handle whose
 * `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'scroll-locked-video-hero';
const PREFIX = `genui-${id}`;
const STAGE_CLASS = `${PREFIX}__stage`;
const CANVAS_CLASS = `${PREFIX}__canvas`;
const OVERLAY_CLASS = `${PREFIX}__overlay`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const P_VAR = `--${PREFIX}-p`;
/** Snap the eased position to the target once the gap is this small, so it settles exactly. */
const SETTLE_EPSILON = 0.0005;

export interface ScrollLockedVideoHeroOptions {
  [key: string]: string | number | boolean;
  trackHeight: string;
  source: 'auto' | 'video' | 'canvas';
  smoothing: number;
  overlayOut: number;
  canvasScene: 'gradient-orbit' | 'none';
  poster: string;
}

export const defaults: ScrollLockedVideoHeroOptions = {
  trackHeight: '300vh',
  source: 'auto',
  smoothing: 0.15,
  overlayOut: 0.3,
  canvasScene: 'gradient-orbit',
  poster: '#0b0d12',
};

/** A procedural, dependency-free "gradient orbit" frame for hosts with no video source. */
function drawGradientOrbit(canvas: HTMLCanvasElement, progress: number, poster: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // no 2D canvas support (e.g. jsdom without the optional `canvas` package)
  const w = canvas.width || 1;
  const h = canvas.height || 1;
  ctx.fillStyle = poster;
  ctx.fillRect(0, 0, w, h);
  const angle = progress * Math.PI * 2;
  const cx = w / 2 + Math.cos(angle) * w * 0.22;
  const cy = h / 2 + Math.sin(angle) * h * 0.22;
  const radius = Math.max(w, h) * (0.35 + progress * 0.15);
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, `hsla(${Math.round((progress * 280) % 360)}, 85%, 60%, 0.9)`);
  gradient.addColorStop(1, 'transparent');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

export function mount(el: HTMLElement, opts: Partial<ScrollLockedVideoHeroOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, { 'overlay-out': options.overlayOut });

    // Snapshot the original children so destroy() can put them back in the same order.
    const originalChildren = Array.from(el.childNodes);

    let media: HTMLVideoElement | HTMLCanvasElement | null = null;
    let mediaKind: 'video' | 'canvas' | null = null;
    if (options.source !== 'canvas') {
      const video = el.querySelector(':scope > video');
      if (video) { media = video as HTMLVideoElement; mediaKind = 'video'; }
    }
    if (!media && options.source !== 'video') {
      const canvas = el.querySelector(':scope > canvas');
      if (canvas) { media = canvas as HTMLCanvasElement; mediaKind = 'canvas'; }
    }

    let ownCanvas: HTMLCanvasElement | null = null;
    if (!media) {
      ownCanvas = document.createElement('canvas');
      ownCanvas.className = CANVAS_CLASS;
      ownCanvas.setAttribute('aria-hidden', 'true');
      media = ownCanvas;
      mediaKind = 'canvas';
    }

    let restoreVideo: (() => void) | null = null;
    if (mediaKind === 'video') {
      const video = media as HTMLVideoElement;
      restoreVideo = snapshotAttributes(video, ['muted', 'playsinline', 'preload', 'controls', 'aria-hidden']);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.removeAttribute('controls');
      if (!video.hasAttribute('aria-label')) video.setAttribute('aria-hidden', 'true');
      video.pause();
    }

    const stage = document.createElement('div');
    stage.className = STAGE_CLASS;
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    for (const node of originalChildren) {
      if (node === media) continue;
      overlay.append(node);
    }
    stage.append(media, overlay);
    el.append(stage);

    onDestroy(() => {
      for (const node of originalChildren) el.append(node);
      stage.remove();
      restoreVideo?.();
    });

    // --- sizing (canvas only) ---------------------------------------------------------------
    const resizeCanvas = (canvas: HTMLCanvasElement): void => {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
      canvas.width = Math.max(1, Math.round((rect.width || canvas.clientWidth || 1) * dpr));
      canvas.height = Math.max(1, Math.round((rect.height || canvas.clientHeight || 1) * dpr));
    };
    if (mediaKind === 'canvas') {
      const canvas = media as HTMLCanvasElement;
      resizeCanvas(canvas);
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => resizeCanvas(canvas));
        ro.observe(stage);
        onDestroy(() => ro.disconnect());
      }
    }

    // --- progress: scroll -> target -> eased current ----------------------------------------
    let current = 0;
    let target = 0;
    let raf = 0;
    let intersecting = true;

    const applyFrame = (p: number): void => {
      el.style.setProperty(P_VAR, p.toFixed(4));
      if (mediaKind === 'video') {
        const video = media as HTMLVideoElement;
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = p * video.duration;
      } else if (mediaKind === 'canvas' && options.canvasScene !== 'none') {
        drawGradientOrbit(media as HTMLCanvasElement, p, options.poster);
      }
    };

    const tick = (): void => {
      raf = 0;
      current += (target - current) * options.smoothing;
      if (Math.abs(target - current) < SETTLE_EPSILON) current = target;
      applyFrame(current);
      if (current !== target) schedule();
    };
    const schedule = (): void => {
      if (!intersecting || raf) return;
      if (typeof requestAnimationFrame !== 'function') { current = target; applyFrame(current); return; }
      raf = requestAnimationFrame(tick);
    };
    const computeTarget = (): number => {
      const rect = el.getBoundingClientRect();
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      const total = rect.height - vh;
      return total <= 0 ? 0 : Math.min(1, Math.max(0, -rect.top / total));
    };
    const onScroll = (): void => { target = computeTarget(); schedule(); };

    let stopPinned: (() => void) | null = null;
    // A disable (reduced motion switched on) detaches the scroll/resize pair, so a later enable
    // attaches exactly one pair again. `signal` still detaches them on destroy.
    let pinned = false;
    const enablePinned = (): void => {
      if (pinned) return;
      pinned = true;
      el.style.height = options.trackHeight;
      window.addEventListener('scroll', onScroll, { passive: true, signal });
      window.addEventListener('resize', onScroll, { passive: true, signal });
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) intersecting = entry.isIntersecting;
          if (intersecting) schedule();
        });
        io.observe(el);
        stopPinned = () => io.disconnect();
      }
      onScroll();
    };
    const disablePinned = (): void => {
      pinned = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      el.style.height = '';
      stopPinned?.();
      stopPinned = null;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      current = mediaKind === 'canvas' ? 0.5 : 0;
      target = current;
      applyFrame(current);
    };

    onDestroy(() => {
      stopPinned?.();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    });

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) disablePinned(); else enablePinned();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) disablePinned(); else enablePinned();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
