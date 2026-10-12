import path from 'node:path';
import { createCdpReviewPort } from '../review/cdp-worker.js';
import { evidenceString } from '../review/evidence.js';
import type { ThumbnailResult } from './unit-service.js';

const WIDTH = 1280;
const HEIGHT = 800;

/**
 * Production thumbnail renderer. It reuses the review worker: the staged unit
 * renders under an isolated origin answered only from the staged files, every
 * other request is refused before it leaves the browser, and the browser's
 * network path points at a dead proxy, so unit code can reach neither the
 * daemon /api nor the network while it is drawn.
 */
export function createUnitThumbnailRenderer(dataDir: string) {
  const profileRoot = path.join(dataDir, 'workbench-units', 'browser-profiles');
  return async function renderThumbnail(stagedRoot: string, entry: string): Promise<ThumbnailResult> {
    const port = createCdpReviewPort(stagedRoot, { profileRoot });
    const capability = await port.capability();
    // evidence/2: the worker's reasons are template messages; render them, never page text.
    if (!capability.available) return { unavailable: evidenceString(capability.reason).slice(0, 400) };
    const session = await port.open();
    try {
      const capture = await session.capture({
        url: `${port.origin}/${entry.split('/').map(encodeURIComponent).join('/')}`,
        width: WIDTH, height: HEIGHT, targets: [], probeAllActions: false, screenshot: true,
      });
      if (capture.loadError) return { unavailable: `The unit entry did not load: ${evidenceString(capture.loadError).slice(0, 300)}` };
      return capture.screenshotPng ? { png: Buffer.from(capture.screenshotPng, 'base64') } : { unavailable: 'The browser returned no screenshot' };
    } finally { await session.close(); }
  };
}
