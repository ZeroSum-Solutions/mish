import { useId } from 'react';
import { Icon } from './Icon';

interface Props {
  heading: string;
  description: string;
  actionLabel: string;
  onCreate: () => void;
}

/**
 * Inline SVG of the Mish brand mark (`assets/brand/mishh-mashh-mark.svg`),
 * drawn as outlines so the empty state reads as line art. Path data is the
 * brand mark's geometry rescaled into this 0–93 design box; the strokes are
 * normalized via pathLength so hover replays a draw-on demo (left to right)
 * that always settles back to the fully drawn resting frame. The viewBox
 * keeps the original framing so the mark's on-page size and position are
 * unchanged.
 */
const MARK_PATHS = [
  'M31.32 25.62C31.46 25.77 31.4 27.94 31.4 28.33L31.4 33.5L31.38 51.12C28.09 55.54 24.54 59.89 21.27 64.34C20.16 65.86 18.86 67.41 17.81 68.96C15.98 67.29 13.77 65.51 11.87 63.85C10.05 62.34 8.19 60.68 6.4 59.13L31.32 25.62Z',
  'M32.3 24.34C33.06 24.85 34.13 25.89 34.88 26.52C36.75 28.1 38.6 29.7 40.44 31.32C41.74 32.45 43.05 33.64 44.41 34.68C43.79 35.58 43.11 36.45 42.47 37.34C40.8 39.69 39.1 42.03 37.35 44.33C35.59 46.69 33.85 49.06 32.13 51.45C32.22 50.49 32.2 49.28 32.2 48.29L32.2 43.44L32.22 32.84C32.22 30.13 32.2 27.03 32.3 24.34Z',
  'M53.53 24.25C53.87 24.39 56.63 26.87 57.08 27.26L64.87 34.02C64.01 35.31 62.82 36.77 61.86 38.01L57.3 43.9L43.81 61.55C42.02 63.92 39.97 66.42 38.26 68.82L38.13 68.92C37.64 68.74 28.32 60.53 27.15 59.46C27.9 58.31 28.95 56.96 29.78 55.84L35.19 48.56C41.24 40.4 47.35 32.3 53.53 24.25Z',
  'M74.48 23.99C74.96 24.26 77.34 26.39 77.89 26.86C80.5 29.17 83.13 31.44 85.79 33.68C84.92 34.94 83.64 36.52 82.68 37.73L78.2 43.51L68.49 56.19C65.3 60.33 61.97 64.57 58.88 68.77C58.87 68.79 58.78 68.84 58.76 68.86C57.68 67.77 55.76 66.2 54.55 65.17L47.74 59.34C48.05 58.78 48.61 58.05 49 57.52C49.71 56.52 50.44 55.54 51.18 54.56L56.33 47.72L74.48 23.99Z',
  'M86.4 34.24C86.7 34.64 86.08 65.75 86.11 69.01L70.87 69.01C70.72 68.42 70.82 64.08 70.83 63.25L70.87 54.4L86.4 34.24Z',
] as const;

function BlankMark() {
  const gradientId = useId();
  return (
    <svg
      className="entry-blank__mark"
      viewBox="-6 -5.9 104.7 104.7"
      width="168"
      height="168"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="6"
          y1="69"
          x2="86.4"
          y2="24"
        >
          <stop offset="0" stopColor="#151719" />
          <stop offset="0.55" stopColor="#a8432f" />
          <stop offset="1" stopColor="#ff674f" />
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradientId})`}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MARK_PATHS.map((d) => (
          <path
            key={d}
            className="entry-blank__mark-line"
            pathLength={1}
            d={d}
          />
        ))}
      </g>
    </svg>
  );
}

export function EntryBlankState({
  heading,
  description,
  actionLabel,
  onCreate,
}: Props) {
  return (
    <div className="entry-section">
      <header className="entry-section__head">
        <h1 className="entry-section__title">{heading}</h1>
      </header>
      <div className="entry-blank">
        <BlankMark />
        <p className="entry-blank__desc">{description}</p>
        <button type="button" className="entry-blank__cta" onClick={onCreate}>
          <Icon name="plus" size={15} /> {actionLabel}
        </button>
      </div>
    </div>
  );
}
