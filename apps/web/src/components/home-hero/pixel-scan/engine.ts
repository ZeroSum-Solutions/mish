// Particle wordmark renderer. The Griggs artwork is sampled from the shipped
// SVG so the animation keeps the exact approved outlines without loading a
// runtime font. Particles gather on mount, rest in the theme ink, repel from the
// pointer, and ease from violet through orange only while hovered.

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [237, 237, 237];
const VIOLET: Rgb = [139, 92, 246];
const MAGENTA: Rgb = [224, 64, 163];
const ORANGE: Rgb = [255, 122, 24];

const LOGO_SRC = '/logo-scan.svg';
const DENSITY = 2;
const MAX_PARTICLES = 4200;
const GATHER_DURATION_MS = 1180;
const GATHER_STAGGER_MS = 260;
const POINTER_REPEL = 30;
const POINTER_RADIUS = 82;
const IDLE_DRIFT = 0.24;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number) => 1 - (1 - value) ** 3;

const mixRgb = (from: Rgb, to: Rgb, amount: number): Rgb => {
  const t = clamp01(amount);
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
};

export function resolveParticleColor(
  gradientPosition: number,
  hoverAmount: number,
  restingColor: Rgb = WHITE,
): Rgb {
  const position = clamp01(gradientPosition);
  const gradient =
    position <= 0.5
      ? mixRgb(VIOLET, MAGENTA, position * 2)
      : mixRgb(MAGENTA, ORANGE, (position - 0.5) * 2);
  return mixRgb(restingColor, gradient, hoverAmount);
}

export function resolvePointerRepel(
  dx: number,
  dy: number,
  radius: number,
  strength: number,
  hoverAmount: number,
): readonly [number, number] {
  const distance = Math.hypot(dx, dy);
  if (distance <= 0 || distance >= radius || radius <= 0 || hoverAmount <= 0) {
    return [0, 0];
  }
  const force = (1 - distance / radius) ** 2 * strength * clamp01(hoverAmount);
  return [(dx / distance) * force, (dy / distance) * force];
}

export function hasParticleFieldSizeChanged(
  currentWidth: number,
  currentHeight: number,
  nextWidth: number,
  nextHeight: number,
): boolean {
  return currentWidth !== nextWidth || currentHeight !== nextHeight;
}

type Particle = {
  x: number;
  y: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  size: number;
  seed: number;
  depth: number;
  delay: number;
};

type PointerState = {
  active: boolean;
  x: number;
  y: number;
  smoothX: number;
  smoothY: number;
};

let logoImgPromise: Promise<HTMLImageElement> | null = null;

function loadLogo(): Promise<HTMLImageElement> {
  logoImgPromise ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[particle-wordmark] failed to load ${LOGO_SRC}`));
    img.src = LOGO_SRC;
  });
  return logoImgPromise;
}

function rasteriseLogo(
  width: number,
  height: number,
  dpr: number,
  img: HTMLImageElement,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return canvas;

  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const drawWidth = img.naturalWidth * scale;
  const drawHeight = img.naturalHeight * scale;
  ctx.drawImage(
    img,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return canvas;
}

function resolveHostInk(host: HTMLElement): Rgb {
  const color = window.getComputedStyle(host).color;
  const channels = color.startsWith('rgb') ? color.match(/[\d.]+/g)?.map(Number) : null;
  return channels && channels.length >= 3
    ? [channels[0]!, channels[1]!, channels[2]!]
    : WHITE;
}

function seedFor(index: number): number {
  return ((index * 9301 + 49297) % 233280) / 233280;
}

export class PixelScanField {
  private readonly host: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reduceMotionQuery: MediaQueryList | null;

  private img: HTMLImageElement | null = null;
  private particles: Particle[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;
  private disposed = false;
  private running = false;
  private raf = 0;
  private gathering = false;
  private gatherStart = 0;
  private hoverTarget = 0;
  private hoverAmount = 0;
  private reducedMotion = false;

  private readonly pointer: PointerState = {
    active: false,
    x: 0,
    y: 0,
    smoothX: 0,
    smoothY: 0,
  };

  constructor(host: HTMLDivElement, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[particle-wordmark] 2D canvas is unavailable');

    this.host = host;
    this.canvas = canvas;
    this.ctx = ctx;
    this.reduceMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this.reducedMotion = this.reduceMotionQuery?.matches ?? false;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.host.addEventListener('pointerenter', this.onPointerEnter);
    this.host.addEventListener('pointermove', this.onPointerMove);
    this.host.addEventListener('pointerleave', this.onPointerLeave);
    this.reduceMotionQuery?.addEventListener('change', this.onReduceMotionChange);

    const img = await loadLogo();
    if (this.disposed) return;
    this.img = img;
    this.rebuild(true);
    this.raf = requestAnimationFrame(this.tick);
  }

  resize(): void {
    if (!this.img || this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    if (
      !hasParticleFieldSizeChanged(
        this.width,
        this.height,
        Math.floor(rect.width),
        Math.floor(rect.height),
      )
    ) {
      return;
    }
    this.rebuild(false);
  }

  destroy(): void {
    this.disposed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.host.removeEventListener('pointerenter', this.onPointerEnter);
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    this.reduceMotionQuery?.removeEventListener('change', this.onReduceMotionChange);
  }

  private rebuild(scatterOnLoad: boolean): void {
    if (!this.img) return;
    const rect = this.host.getBoundingClientRect();
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    if (this.width <= 0 || this.height <= 0) return;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const mask = rasteriseLogo(this.width, this.height, 1, this.img);
    const maskCtx = mask.getContext('2d', { willReadFrequently: true });
    if (!maskCtx) return;
    const pixels = maskCtx.getImageData(0, 0, this.width, this.height).data;
    const targets: Array<{ x: number; y: number; alpha: number }> = [];

    for (let y = 0; y < this.height; y += DENSITY) {
      for (let x = 0; x < this.width; x += DENSITY) {
        const alpha = pixels[(y * this.width + x) * 4 + 3] ?? 0;
        if (alpha > 40) targets.push({ x, y, alpha: alpha / 255 });
      }
    }

    const areaLimit = Math.max(900, Math.floor((this.width * this.height) / 8));
    const maxParticles = Math.min(MAX_PARTICLES, areaLimit);
    const stride = Math.max(1, Math.ceil(targets.length / maxParticles));
    const selected = targets.filter((_, index) => index % stride === 0);
    const scatter = Math.min(150, this.width * 0.3);
    const shouldScatter = scatterOnLoad && !this.reducedMotion;

    this.particles = selected.map((target, index) => {
      const seed = seedFor(index);
      const depth = 0.45 + seedFor(index + 521) * 0.9;
      const angle = seed * Math.PI * 2;
      const distance = scatter * (0.35 + depth * 0.72);
      const startX = shouldScatter
        ? target.x + Math.cos(angle) * distance + (depth - 0.9) * scatter * 0.4
        : target.x;
      const startY = shouldScatter
        ? target.y + Math.sin(angle) * distance + (seed - 0.5) * scatter * 0.4
        : target.y;

      return {
        x: startX,
        y: startY,
        startX,
        startY,
        targetX: target.x,
        targetY: target.y,
        size: Math.max(0.75, 1.35 + target.alpha * 0.8),
        seed,
        depth,
        delay: shouldScatter ? seed * GATHER_STAGGER_MS : 0,
      };
    });

    this.pointer.x = this.width / 2;
    this.pointer.y = this.height / 2;
    this.pointer.smoothX = this.pointer.x;
    this.pointer.smoothY = this.pointer.y;
    this.gatherStart = performance.now();
    this.gathering = shouldScatter;
  }

  private readonly onPointerEnter = (event: PointerEvent) => {
    this.updatePointer(event);
    this.pointer.active = true;
    this.hoverTarget = 1;
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    this.updatePointer(event);
  };

  private readonly onPointerLeave = () => {
    this.pointer.active = false;
    this.hoverTarget = 0;
  };

  private readonly onReduceMotionChange = (event: MediaQueryListEvent) => {
    this.reducedMotion = event.matches;
    this.rebuild(false);
  };

  private updatePointer(event: PointerEvent): void {
    const rect = this.host.getBoundingClientRect();
    this.pointer.x = event.clientX - rect.left;
    this.pointer.y = event.clientY - rect.top;
  }

  private readonly tick = (now: number) => {
    if (!this.running || this.disposed) return;

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.hoverAmount += (this.hoverTarget - this.hoverAmount) * 0.14;
    this.pointer.smoothX += (this.pointer.x - this.pointer.smoothX) * 0.2;
    this.pointer.smoothY += (this.pointer.y - this.pointer.smoothY) * 0.2;

    // Read once per frame so explicit and system theme changes update the
    // canvas without restarting its animation or rebuilding its particle mask.
    const restingColor = resolveHostInk(this.host);
    let gatherComplete = true;
    const gradientShift = (0.5 - this.pointer.smoothX / Math.max(1, this.width)) * 0.2;

    for (const particle of this.particles) {
      let baseX = particle.targetX;
      let baseY = particle.targetY;
      let gatherProgress = 1;

      if (this.gathering) {
        const localTime = now - this.gatherStart - particle.delay;
        gatherProgress = clamp01(localTime / GATHER_DURATION_MS);
        const eased = easeOutCubic(gatherProgress);
        baseX = particle.startX + (particle.targetX - particle.startX) * eased;
        baseY = particle.startY + (particle.targetY - particle.startY) * eased;
        if (gatherProgress < 1) gatherComplete = false;
      } else if (!this.reducedMotion) {
        const driftTime = now * 0.001;
        baseX += Math.sin(driftTime * 0.9 + particle.seed * 11) * IDLE_DRIFT * particle.depth;
        baseY += Math.cos(driftTime * 0.75 + particle.depth * 9) * IDLE_DRIFT * particle.depth;
      }

      let repelX = 0;
      let repelY = 0;
      if (this.pointer.active && !this.reducedMotion) {
        [repelX, repelY] = resolvePointerRepel(
          baseX - this.pointer.smoothX,
          baseY - this.pointer.smoothY,
          POINTER_RADIUS,
          POINTER_REPEL,
          this.hoverAmount,
        );
      }

      const follow = this.reducedMotion ? 1 : 0.24;
      particle.x += (baseX + repelX - particle.x) * follow;
      particle.y += (baseY + repelY - particle.y) * follow;

      const gradientPosition = clamp01(
        particle.targetX / Math.max(1, this.width) + gradientShift,
      );
      const color = resolveParticleColor(gradientPosition, this.hoverAmount, restingColor);
      this.ctx.fillStyle = `rgb(${color[0]} ${color[1]} ${color[2]})`;
      this.ctx.globalAlpha = clamp01(0.32 + gatherProgress * 0.68);
      this.ctx.fillRect(
        particle.x - particle.size / 2,
        particle.y - particle.size / 2,
        particle.size,
        particle.size,
      );
    }

    this.ctx.globalAlpha = 1;
    if (this.gathering && gatherComplete) this.gathering = false;
    this.raf = requestAnimationFrame(this.tick);
  };
}

export function drawStaticLogo(canvas: HTMLCanvasElement, host: HTMLElement): void {
  void loadLogo()
    .then((img) => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(rasteriseLogo(rect.width, rect.height, dpr, img), 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = window.getComputedStyle(host).color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    })
    .catch((error: unknown) => console.error(error));
}
