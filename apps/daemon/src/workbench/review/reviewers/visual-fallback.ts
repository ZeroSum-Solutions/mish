// R03: why a visual critic ended without reading every screenshot, as a closed
// reason code with a reason and recovery that name the actual cause.
import path from 'node:path';
import type { ReviewerInput, VisualFallback } from './types.js';

/** A path segment Claude Code protects from file tools (its own configuration folders). */
const PROTECTED_SEGMENT = /(?:^|[\\/])\.claude(?:[\\/]|$)/u;
/**
 * Why the critic ended without reading every screenshot, named from what the
 * transcript shows: no screenshot to read, a read the permissions refused, a
 * read that failed, or no read attempted.
 */
export function visualFallback(screenshots: ReviewerInput['screenshots'], readPaths: ReadonlySet<string> = new Set(), failedReads: ReadonlyMap<string, 'denied' | 'failed'> = new Map(), workDir = ''): VisualFallback {
  if (!screenshots.length) return { code: 'screenshot-unavailable', reason: 'The visual critic could not see the page screenshots because none was captured, so it did not review the visual checks', recovery: 'Run the review again; if it repeats, check that the review browser can take screenshots and that the daemon data root is writable.' };
  const missing = screenshots.map(shot => path.resolve(shot.path)).filter(file => !readPaths.has(file));
  const failures = missing.map(file => failedReads.get(file));
  if (failures.includes('denied')) {
    return {
      code: 'screenshot-read-denied',
      reason: 'The visual critic could not see the page screenshots: Claude Code denied it read access, so it did not review the visual checks',
      recovery: PROTECTED_SEGMENT.test(workDir)
        ? 'The screenshots are stored inside a .claude folder, which Claude Code protects from file reads. Set OD_DATA_DIR to a folder outside any .claude directory, restart the daemon, then run the review again.'
        : 'Check that the Claude Code permission settings and the operating system allow reading the screenshot folder under the daemon data root, then run the review again.',
    };
  }
  if (failures.includes('failed')) return { code: 'screenshot-read-failed', reason: 'The visual critic could not see the page screenshots: its reads of them failed, so it did not review the visual checks', recovery: 'Run the review again; if it repeats, check that the screenshot files exist under the daemon data root and are readable.' };
  return { code: 'screenshot-not-read', reason: 'The visual critic could not see the page screenshots: it answered without opening them, so it did not review the visual checks', recovery: 'Run the review again; if it repeats, check that the configured Claude model accepts images.' };
}

