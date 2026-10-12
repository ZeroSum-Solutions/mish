import { useEffect, useRef } from 'react';
import { PixelScanField, drawStaticLogo } from './pixel-scan/engine';

interface Props {
  className?: string;
  /** Accessible label for the wordmark (the canvas itself is decorative). */
  label?: string;
}

// Mounts the particle wordmark onto a sized, position:relative host. The engine
// samples the shipped SVG into a lightweight 2D canvas; reduced motion keeps
// particles fixed while preserving the hover color transition. A
// ResizeObserver keeps the canvas in sync as the hero column reflows. The
// engine listens on the HOST (the canvas itself is pointer-events:none via
// .home-hero__logo--tiles > canvas).
export function PixelScanLogo({ className, label = 'Mishh Mashh' }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;

    let disposed = false;
    let field: PixelScanField | null = null;
    let ro: ResizeObserver | null = null;
    let frame = 0;

    try {
      field = new PixelScanField(host, canvas);
      ro = new ResizeObserver(() => {
        // Coalesce bursts of resize notifications into one re-measure per frame.
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          field?.resize();
        });
      });
      ro.observe(host);
      void field
        .start()
        .catch((err: unknown) => {
          // Surface the underlying failure — the static fallback must not mask it.
          console.error('[particle-wordmark] falling back to static logo:', err);
          if (!disposed) drawStaticLogo(canvas, host);
        });
    } catch (err: unknown) {
      console.error('[particle-wordmark] falling back to static logo:', err);
      drawStaticLogo(canvas, host);
    }

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      field?.destroy();
    };
  }, []);

  return (
    <div ref={hostRef} className={className} role="img" aria-label={label}>
      <canvas ref={canvasRef} />
    </div>
  );
}
