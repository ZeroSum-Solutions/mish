/**
 * particle-text — clean-room implementation from the effect description "Type dissolves into
 * particles" only. The host's own text is sampled into a point cloud on a 2D canvas laid over it;
 * the points hold the letterforms, then a left-to-right wave dissolves them into drifting dust
 * and reassembles them, on a loop (`loop`). The pointer scatters nearby points (`repel`), which
 * spring back. The real text stays in the DOM, painted transparent only once particles exist,
 * so screen readers, selection and find-in-page keep working.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-particle-text` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. Without a 2D context, or under
 * reduced motion, nothing is added and the plain text shows.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'particle-text';
const PREFIX = `genui-${id}`;
const ACTIVE_CLASS = `${PREFIX}--active`;
const CANVAS_CLASS = `${PREFIX}__canvas`;
/** Floats per particle: home x, home y, drift x, drift y, repel x, repel y, seed. */
const STRIDE = 7;
const MAX_PARTICLES = 6000;

export interface ParticleTextOptions {
  [key: string]: string | number | boolean;
  /** Sampling step in px; smaller is denser. */
  gap: number;
  /** Particle size in px. */
  size: number;
  /** Particle colour; empty uses the host's text colour. */
  color: string;
  /** Second colour blended across the width; empty means a single colour. */
  accent: string;
  /** How far dissolved particles drift, in px. */
  spread: number;
  /** Length of one dissolve (and of one reassembly), in ms. */
  duration: number;
  /** How long the letters hold before dissolving, in ms. */
  hold: number;
  /** Dissolve and reassemble on a loop; off keeps the letters formed. */
  loop: boolean;
  /** Pointer scatter radius in px; 0 disables it. */
  repel: number;
}

export const defaults: ParticleTextOptions = {
  gap: 3,
  size: 1.6,
  color: '',
  accent: '',
  spread: 48,
  duration: 1400,
  hold: 2400,
  loop: true,
  repel: 60,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Draw the host's words where the browser laid them out, then collect opaque pixels. */
function sample(el: HTMLElement, w: number, h: number, pad: number, gap: number): number[] {
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const c = off.getContext('2d', { willReadFrequently: true });
  if (!c) return [];
  const box = el.getBoundingClientRect();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  c.fillStyle = '#fff';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.classList.contains(CANVAS_CLASS)) continue;
    const cs = getComputedStyle(parent);
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if ('letterSpacing' in c) (c as { letterSpacing: string }).letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    const tt = cs.textTransform;
    for (const m of (node.textContent ?? '').matchAll(/\S+/g)) {
      const start = m.index ?? 0;
      range.setStart(node, start);
      range.setEnd(node, start + m[0].length);
      const r = range.getBoundingClientRect ? range.getBoundingClientRect() : box;
      const word = tt === 'uppercase' ? m[0].toUpperCase() : tt === 'lowercase' ? m[0].toLowerCase() : m[0];
      const ascent = c.measureText(word).fontBoundingBoxAscent;
      c.textBaseline = ascent ? 'alphabetic' : 'middle';
      c.fillText(word, r.left - box.left + pad, (ascent ? r.top + ascent : r.top + r.height / 2) - box.top + pad);
    }
  }
  const data = c.getImageData(0, 0, w, h).data;
  for (let g = Math.max(1, Math.round(gap)); ; g += 1) {
    const out: number[] = [];
    for (let y = 0; y < h; y += g) {
      for (let x = 0; x < w; x += g) {
        if ((data[(y * w + x) * 4 + 3] ?? 0) > 128) out.push(x, y);
      }
    }
    if (out.length / 2 <= MAX_PARTICLES) return out;
  }
}

export function mount(el: HTMLElement, opts: Partial<ParticleTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const o = resolveOptions(el, defaults, opts);
    const spread = Math.max(0, o.spread);
    const duration = Math.max(1, o.duration);
    const hold = Math.max(0, o.hold);
    const size = Math.max(0.5, o.size);
    const repel = Math.max(0, o.repel);
    setVars(el, PREFIX, { spread: `${spread}px`, duration: `${duration}ms` });

    let stop = (): void => {};

    const start = (): void => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return; // no 2D context: the plain text stays
      canvas.className = CANVAS_CLASS;
      canvas.setAttribute('aria-hidden', 'true');
      el.append(canvas);
      const run = new AbortController();
      const colour = o.color || getComputedStyle(el).color || '#fff';
      const hasRaf = typeof requestAnimationFrame === 'function';
      let parts = new Float32Array(0);
      let w = 0; let h = 0;
      let raf = 0; let last = 0; let clock = 0;
      let visible = true;
      let px = NaN; let py = NaN;

      const build = (): void => {
        const box = el.getBoundingClientRect();
        const pad = Math.ceil(spread + repel * 0.5);
        w = Math.ceil(box.width) + pad * 2;
        h = Math.ceil(box.height) + pad * 2;
        const pts = sample(el, w, h, pad, o.gap);
        const n = pts.length / 2;
        parts = new Float32Array(n * STRIDE);
        for (let i = 0; i < n; i += 1) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4; // mostly upward, like dust
          const len = spread * (0.4 + Math.random() * 0.8);
          parts.set([pts[i * 2] ?? 0, pts[i * 2 + 1] ?? 0, Math.cos(a) * len, Math.sin(a) * len, 0, 0, Math.random() * 6.28], i * STRIDE);
        }
        const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.cssText = `left:${-pad}px;top:${-pad}px;width:${w}px;height:${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
        grad.addColorStop(0, colour);
        grad.addColorStop(1, o.accent || colour);
        ctx.fillStyle = grad;
        el.classList.toggle(ACTIVE_CLASS, n > 0);
      };

      /** Draws one frame; returns whether anything is still moving. */
      const draw = (): boolean => {
        const period = hold + duration * 2.4;
        const t = o.loop ? clock % period : 0;
        const inS = (t - hold - duration * 1.4) / duration;
        const s = t < hold ? -1 : t < hold + duration ? (t - hold) / duration : inS < 0 ? 2 : inS;
        let moving = o.loop || px === px;
        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < parts.length; i += STRIDE) {
          const hx = parts[i] ?? 0; const hy = parts[i + 1] ?? 0; const seed = parts[i + 6] ?? 0;
          let rx = parts[i + 4] ?? 0; let ry = parts[i + 5] ?? 0;
          const wave = clamp01((s < 0 ? 0 : s > 1 ? 1 : s) * 1.6 - (hx / w) * 0.6);
          const a = s < 0 ? 0 : s === 2 ? 1 : t >= hold + duration * 1.4 ? 1 - wave : wave;
          const e = a * a * (3 - 2 * a);
          const sway = Math.sin(clock * 0.002 + seed);
          const x = hx + (parts[i + 2] ?? 0) * e + sway * e * spread * 0.15 + Math.sin(clock * 0.003 + seed) * 0.3;
          const y = hy + (parts[i + 3] ?? 0) * e + Math.cos(clock * 0.0017 + seed) * e * spread * 0.1;
          let tx = 0; let ty = 0;
          if (repel > 0 && px === px) {
            const vx = x - px; const vy = y - py; const d = Math.hypot(vx, vy) || 1;
            if (d < repel) { const f = ((repel - d) / d) * 0.6; tx = vx * f; ty = vy * f; }
          }
          rx += (tx - rx) * 0.12; ry += (ty - ry) * 0.12;
          parts[i + 4] = rx; parts[i + 5] = ry;
          if (Math.abs(rx) + Math.abs(ry) > 0.05) moving = true;
          ctx.globalAlpha = 1 - e * 0.9;
          ctx.fillRect(x + rx, y + ry, size, size);
        }
        return moving;
      };

      const tick = (now: number): void => {
        raf = 0;
        clock += last ? Math.min(50, now - last) : 16;
        last = now;
        if (draw()) schedule();
      };
      const schedule = (): void => {
        if (!raf && visible && hasRaf) raf = requestAnimationFrame(tick);
      };
      const pause = (): void => {
        if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = 0; last = 0;
      };

      build();
      draw();
      schedule();

      const lo = { passive: true, signal: run.signal } as const;
      if (repel > 0) {
        el.addEventListener('pointermove', (event) => {
          const r = canvas.getBoundingClientRect();
          px = event.clientX - r.left; py = event.clientY - r.top;
          schedule();
        }, lo);
        el.addEventListener('pointerleave', () => { px = NaN; py = NaN; schedule(); }, lo);
      }

      let io: IntersectionObserver | null = null;
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
          if (visible) schedule(); else pause();
        });
        io.observe(el);
      }
      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver === 'function') {
        let lastW = el.offsetWidth; let lastH = el.offsetHeight;
        ro = new ResizeObserver(() => {
          if (el.offsetWidth === lastW && el.offsetHeight === lastH) return;
          lastW = el.offsetWidth; lastH = el.offsetHeight;
          build(); draw(); schedule();
        });
        ro.observe(el);
      }

      stop = (): void => {
        run.abort();
        pause();
        io?.disconnect();
        ro?.disconnect();
        canvas.remove();
        el.classList.remove(ACTIVE_CLASS);
        stop = () => {};
      };
    };

    const motion = watchReducedMotion(signal, (reduced) => {
      stop();
      if (!reduced) start();
    });
    if (!motion.reduced) start();
    onDestroy(() => { stop(); });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
