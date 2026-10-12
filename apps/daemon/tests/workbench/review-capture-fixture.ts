import { isReviewEvidenceMessage, renderReviewEvidenceText, type ReviewEvidenceMessage } from '@open-design/contracts';
import { ev, evidenceUrl, evidenceVocabulary, PageText, type EvidenceContext, type EvidenceParam } from '../../src/workbench/review/evidence.js';
import type { CaptureRequest, ReviewBrowserPort, ViewportCapture } from '../../src/workbench/review/types.js';

/** Page text as the worker hands it over (opaque; see evidence.ts). */
export const page = (text: string) => PageText.of(text);
/** What a fake capture's run can vouch for: these served project paths and allow-listed origins. */
export const vouch = (served: string[] = [], allowed: string[] = []): EvidenceContext => ({ served: path => served.includes(path), allowedOrigin: origin => allowed.includes(origin) });
/** A URL reduced the way the worker reduces it. */
export const url = (text: string, context: EvidenceContext = vouch()): EvidenceParam => evidenceUrl(PageText.of(text), context);
/** A CDP resource type as the worker records it. */
export const resourceType = (type: string): EvidenceParam => evidenceVocabulary(PageText.of(type), 'resourceType');
/** English text of a stored message (or a legacy string), for assertions. */
export const text = (value: ReviewEvidenceMessage | string | null | undefined): string => (value === null || value === undefined ? '' : renderReviewEvidenceText(value));
export { ev };
/** Every stored message in a value, rendered in place as English text (what a reader sees). */
export const readable = (value: unknown): unknown => isReviewEvidenceMessage(value) ? renderReviewEvidenceText(value)
  : Array.isArray(value) ? value.map(readable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readable(item)])) : value;

/** A capture of a small accessible page: one link CTA, one labelled form, solid colors. */
export function knownGoodCapture(width: number, mutate?: (capture: ViewportCapture) => void): ViewportCapture {
  const capture: ViewportCapture = {
    width, height: width < 768 ? 740 : 900, loadError: null,
    document: { lang: page('en'), title: page('Known good'), scrollWidth: width, clientWidth: width, layoutWidth: width },
    headings: [{ level: 1, text: page('Book a visit') }, { level: 2, text: page('How it works') }],
    controls: [{ selector: page('a#cta'), role: page('link'), name: page('Book now') }, { selector: page('input#email'), role: page('textbox'), name: page('Email') }, { selector: page('button#send'), role: page('button'), name: page('Send') }],
    texts: [
      { selector: page('h1'), text: page('Book a visit'), color: [17, 17, 17, 1], background: [255, 255, 255, 1], fontSizePx: 40, fontWeight: 700, targetKeys: [] },
      { selector: page('p'), text: page('Plain body copy'), color: [51, 51, 51, 1], background: [255, 255, 255, 1], fontSizePx: 16, fontWeight: 400, targetKeys: [] },
    ],
    textsTruncated: false,
    clipped: [], outsideViewport: [],
    actions: [
      { selector: page('body > main > a'), kind: 'link', name: page('Book now'), visible: true, disabled: false, width: 160, height: 44, inline: false, href: url('http://project.od-review.localhost/book.html', vouch(['book.html'])), destination: { kind: 'same-origin', status: 200 }, clickEffect: null, targetKeys: [] },
      { selector: page('body > main > form'), kind: 'form', name: page('Sign up'), visible: true, disabled: false, width: 300, height: 120, inline: false, href: null, destination: null, clickEffect: { target: 'same', domMutations: 2, navigated: false, submissionCaptured: true, externalBlocked: false, error: null }, targetKeys: [] },
    ],
    console: [], resources: [], blockedRequests: [], fonts: [],
    keyboard: { focusableCount: 3, steps: [{ selector: page('a#cta'), focusVisible: true }, { selector: page('input#email'), focusVisible: true }, { selector: page('button#send'), focusVisible: true }, { selector: null, focusVisible: false }] },
    served: [{ path: 'index.html', sha256: 'a'.repeat(64) }, { path: 'book.html', sha256: 'b'.repeat(64) }],
    servingLimit: null,
  };
  mutate?.(capture);
  return capture;
}

export function portFrom(capture: (width: number, request: CaptureRequest) => ViewportCapture): ReviewBrowserPort {
  return {
    origin: 'http://project.od-review.localhost',
    async capability() { return { available: true, browserVersion: 'HeadlessChrome/140.0.0.0' }; },
    async open() {
      return { async capture(request) { return capture(request.width, request); }, async close() {} };
    },
  };
}

export function unavailablePort(): ReviewBrowserPort {
  return {
    origin: 'http://project.od-review.localhost',
    async capability() { return { available: false, reason: ev('worker.noExecutable'), recovery: ev('recovery.browserInstall') }; },
    async open() { throw new Error('unavailable'); },
  };
}
