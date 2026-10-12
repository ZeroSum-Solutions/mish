import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { WORKBENCH_OBSERVED_BEHAVIORS, WORKBENCH_REVIEW_EGRESS_LIMITS, type ReviewEgressPolicy } from '@mish/contracts';
import { load } from 'cheerio';
import { findBrowserExecutable } from '../../browser-sessions.js';
import { CdpPipe } from './cdp-pipe.js';
import { decodePng, pixelTileKey, TileChangeTracker, tileChangeCounts, type DecodedImage } from './pixel-tiles.js';
import { afterActionWindowMs, MAX_PAUSE_ACTIVATIONS, MOTION_CONTINUOUS_AFTER_MS, MOTION_GRACE_MS, MOTION_LOAD_WINDOW_MS, MOTION_SAMPLE_INTERVAL_MS, observedMovement, stillProofMs } from './motion.js';
import { BLUR_DEEP, CLICK_PROBE, FOCUS_STEP, FOCUSED_CONTROL, MOTION_SAMPLE, MOVING_CENTERS, PAGE_PROBE, PAUSE_CANDIDATES, PAUSE_CONTROL_NAME, PAUSE_FIRST_NAME, probeArgument, TIMER_TRACKER, VISUAL_PROBE, type ActionFingerprint, type FocusedControlResult, type MotionSampleResult, type UnmeasuredItem } from './page-scripts.js';
import { readPreviewFile, type PreviewFile } from './preview-files.js';
import { EgressSession, type EgressOptions } from './egress.js';
import { ev, EvidenceError, evidenceSelector, evidenceUrl, evidenceVocabulary, PageText, pageEnum, vocab, type EvidenceContext, type EvidenceParam, type EvidenceText } from './evidence.js';
import { BrowserStartupError, classifyStartupFailure, logStartupFailure, type StartupSignals } from './startup.js';
import { consoleRecord, consoleSource, type ConsoleRecord } from './page-text.js';
import { ReviewServeBudget } from './serve-budget.js';
import type { ActionProbe, CaptureRequest, MotionCapture, MotionObservation, MotionPhase, MotionRequest, PauseProbe, ReviewBrowserPort, ReviewBrowserSession, Rgba, ServedResource, ViewportCapture, VisualCapture, WorkerCapability } from './types.js';

/**
 * Pages render under this origin. Every request to it is answered from the
 * project root by the worker (Fetch interception); nothing behind it is a
 * real server. All other requests are refused before they leave the browser,
 * and the browser's own network path is pointed at a dead proxy with loopback
 * included, so generated content cannot reach the daemon, metadata services
 * or the private network. A run may opt in to an egress allow-list (B4-2):
 * requests to those hosts are still paused here and fetched by the daemon's
 * EgressSession under its address, redirect and budget rules, never by the
 * browser.
 */
export const REVIEW_PREVIEW_ORIGIN = 'http://project.od-review.localhost';
export const SETUP_RECOVERY = ev('recovery.browserInstall');

const MAX_CLICK_PROBES = 20;
const LOAD_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 90_000;
const FAVICON = 'favicon.ico';
/** Longest wait for allowed-host requests after the load event: one request timeout plus resolution. */
const EGRESS_SETTLE_MS = WORKBENCH_REVIEW_EGRESS_LIMITS.requestTimeoutMs + WORKBENCH_REVIEW_EGRESS_LIMITS.resolveTimeoutMs;

/**
 * The OS sandbox stays on. OD_REVIEW_BROWSER_NO_SANDBOX=1 exists only for
 * disposable CI/gate hosts whose kernel forbids unprivileged user namespaces;
 * never set it on a machine where people use the daemon.
 */
const sandboxArgs = () => (process.env.OD_REVIEW_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []);
const browserArgs = (profileDir: string) => [
  ...sandboxArgs(),
  '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
  '--disable-default-apps', '--disable-sync', '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--disable-gpu',
  '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND',
  'about:blank',
];

interface Launched { child: ChildProcess; cdp: CdpPipe; profileDir: string; version: string }

async function launch(executable: string, profileRoot: string): Promise<Launched> {
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  const profileDir = fs.mkdtempSync(path.join(profileRoot, 'profile-'));
  const child = spawn(executable, browserArgs(profileDir), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  // Keep a short stderr tail so a startup failure can be classified (and logged locally).
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
  const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const signals: StartupSignals = {};
  const exited = new Promise<never>((_, reject) => {
    child.once('error', error => { signals.errno = (error as NodeJS.ErrnoException).code ?? null; reject(error); });
    child.once('exit', (code, signal) => { signals.exitCode = code; signals.signal = signal; reject(new Error(`browser exited during startup (code ${code}, signal ${signal})`)); });
  });
  try {
    const version = await Promise.race([cdp.send('Browser.getVersion', {}, undefined, 20_000), exited]).catch(async (error: Error) => {
      // A pipe reset usually means the process died; give its exit (with stderr) a moment to win.
      await new Promise(resolve => setTimeout(resolve, 300));
      if (signals.errno === undefined && signals.exitCode === undefined && /timed? ?out/iu.test(error.message)) signals.timedOut = true;
      const failure = classifyStartupFailure({ ...signals, stderr });
      throw new BrowserStartupError(failure, `${error.message}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    });
    return { child, cdp, profileDir, version: String(version.product ?? 'unknown') };
  } catch (error) {
    child.kill('SIGKILL'); cdp.close(); fs.rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }
}

async function shutdown(launched: Launched): Promise<void> {
  try { await launched.cdp.send('Browser.close', {}, undefined, 3_000); } catch { /* fall through to kill */ }
  launched.cdp.close();
  if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
  fs.rmSync(launched.profileDir, { recursive: true, force: true });
}

const withoutQuery = (url: string) => url.split('#')[0]!.split('?')[0]!;

/**
 * True for an element in the document tree. parse5 keeps <template> contents
 * in a detached fragment (no <html> ancestor); they are inert, so the browser
 * never applies a <base> or creates a frame from them.
 */
function inDocument(selection: { closest(selector: string): { length: number } }): boolean {
  return selection.closest('html').length > 0;
}

/**
 * The document's base URL as the browser computes it: the href of the first
 * <base> element that has one, resolved against the document URL; otherwise
 * the document URL. Parsed with cheerio (parse5, the HTML spec tokenizer), so
 * attribute boundaries and entities are the browser's, and a <base> inside a
 * script, comment, template or noscript never counts.
 */
export function documentBaseUrl(html: string, documentUrl: string): string {
  const $ = load(html);
  const href = $('base[href]').filter((_index, element) => inDocument($(element))).first().attr('href');
  if (href === undefined) return documentUrl;
  try { return new URL(href.trim(), documentUrl).href; } catch { return documentUrl; }
}

/**
 * Frame src values the served HTML declares as markup (parsed like the
 * browser parses it, so a src a script builds at run time, possibly from form
 * data, is never on this list). Relative srcs resolve against the document's
 * base URL. Only URLs without query or fragment are kept.
 */
export function declaredFrameSources(html: string, documentUrl: string): string[] {
  const $ = load(html);
  const base = documentBaseUrl(html, documentUrl);
  const found: string[] = [];
  $('iframe[src], frame[src]').each((_index, element) => {
    if (!inDocument($(element))) return;
    const raw = ($(element).attr('src') ?? '').trim();
    if (!raw || raw.includes('?') || raw.includes('#')) return;
    try {
      const url = new URL(raw, base);
      if (!url.search && !url.hash) found.push(url.href);
    } catch { /* not a URL */ }
  });
  return found;
}

const navigationKey = (frameId: string, url: string) => `${frameId}\u0000${url.split('#')[0]}`;
/** Longest wait for a frame's Page.frameRequestedNavigation after its document request is paused. */
const NAVIGATION_REASON_WAIT_MS = 300;

/** The page is no longer the reviewed entry; nothing read from it may count as evidence about the entry. */
class EntryLeftError extends EvidenceError {}

/** Chrome's ClientNavigationReason values (CDP Page.frameRequestedNavigation). */

/**
 * Whether a paused request may be fetched from an allowed host. Never while
 * a click probe's activation may still be acting (any resource type: fetch,
 * XHR, beacon, image, document), never for a main-frame document (that would
 * replace the reviewed entry with another site's page), and never for a
 * submission (non-GET, a GET to a form action on the probed page, or any
 * frame navigation the page requested as a form submission).
 */
export function egressEligible(request: { url: string; method: string; resourceType: string; mainFrame: boolean; probing: boolean; navigationReason?: string | null; staticFrameSource?: boolean }, getFormActions: ReadonlySet<string>): { eligible: true } | { eligible: false; reason: EvidenceText } {
  if (request.probing) return { eligible: false, reason: ev('egress.refusedProbing') };
  if (request.resourceType === 'Document' && request.mainFrame) return { eligible: false, reason: ev('egress.refusedMainFrame') };
  if (request.resourceType === 'Document') {
    // A subframe document is fetched only as a static, query-free, initial frame load declared in served markup.
    // Every other navigation (script, meta refresh, history, form, reload, unobserved) can carry page data and is refused.
    if (request.navigationReason && /^formSubmission/u.test(request.navigationReason)) return { eligible: false, reason: ev('egress.refusedFormSubmission') };
    if (request.navigationReason !== 'initialFrameNavigation') return { eligible: false, reason: ev('egress.refusedFrameNavigation', request.navigationReason ? evidenceVocabulary(PageText.of(request.navigationReason), 'navigationReason') : ev('common.unobserved')) };
    let target: URL | null = null;
    try { target = new URL(request.url); } catch { target = null; }
    if (!target || target.search || target.hash) return { eligible: false, reason: ev('egress.refusedFrameQuery') };
    if (!request.staticFrameSource) return { eligible: false, reason: ev('egress.refusedFrameUndeclared') };
  }
  if (isMockedSubmission(request, getFormActions)) return { eligible: false, reason: ev('egress.refusedSubmission') };
  return { eligible: true };
}

/**
 * A request is a form submission when it writes (any non-GET/HEAD method), or
 * when it is a GET document navigation to the resolved action of a GET form on
 * the probed page. Submissions go to the mock destination: they are recorded,
 * never delivered, and never looked up in the project root, so a working GET
 * form cannot surface as a broken resource.
 */
export function isMockedSubmission(request: { url: string; method: string; resourceType: string }, getFormActions: ReadonlySet<string>): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return true;
  return request.method === 'GET' && request.resourceType === 'Document' && getFormActions.has(withoutQuery(request.url));
}

/** Resolved actions (query and fragment removed) of every GET form and GET form-override button on the page. */
const GET_FORM_ACTIONS = String.raw`(() => {
  const strip = (url) => String(url).split('#')[0].split('?')[0];
  const actions = [];
  for (const form of Array.from(document.forms)) if ((form.method || 'get').toLowerCase() === 'get') actions.push(strip(form.action || location.href));
  for (const el of Array.from(document.querySelectorAll('button[formaction],button[formmethod],input[formaction],input[formmethod]'))) {
    if (!el.form) continue;
    const method = (el.getAttribute('formmethod') || el.form.method || 'get').toLowerCase();
    if (method === 'get') actions.push(strip(el.formAction || el.form.action || location.href));
  }
  return actions;
})()`;

interface CallFrame { url?: string; lineNumber?: number; columnNumber?: number }
const exceptionText = (params: Record<string, unknown>) => {
  const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  return details?.exception?.description ?? details?.text ?? 'Uncaught exception';
};
const consoleText = (params: Record<string, unknown>) => ((params.args as { value?: unknown; description?: string }[] | undefined) ?? [])
  .map(arg => arg.description ?? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value))).join(' ');

/** Reads a project file under the review budget; null when the budget refuses it. */
async function budgetedRead(budget: ReviewServeBudget, root: string, urlPathname: string): Promise<PreviewFile | null> {
  if (!budget.admit()) return null;
  const file = await readPreviewFile(root, urlPathname);
  if (file.status === 200 && !budget.charge(file.body.length)) return null;
  return file;
}

/** One page target with request interception bound to a project root. */
class PageTarget {
  private readonly off: (() => void)[] = [];
  /** Console, exception and log errors as records (kind, count, length, digest, source); their text is never kept. */
  readonly console = new Map<string, ConsoleRecord>();
  readonly missing = new Map<string, ServedResource>();
  readonly blocked = new Map<string, { url: EvidenceParam; resourceType: EvidenceParam; reason?: EvidenceText }>();
  /** Every distinct SHA-256 served per path, so a file that changes between reloads is visible to the runner. */
  readonly served = new Map<string, Set<string>>();
  submissions = 0;
  /** Set only while a click probe runs; see isMockedSubmission. */
  getFormActions: ReadonlySet<string> = new Set();
  externalDocumentBlocked = 0;
  /** Allowed-host requests not yet answered; anything still here when evidence is read is recorded as unverified. */
  readonly pendingEgress = new Map<string, { url: EvidenceParam; resourceType: EvidenceParam }>();
  /** Project files the daemon read with status 200 for a link destination; with `served`, the run's serve log. */
  readonly verifiedPaths = new Set<string>();
  /** Frame src URLs declared in served project HTML (outside scripts and comments), resolved and without query or fragment. */
  private readonly staticFrameSources = new Set<string>();
  /** Why the page asked to navigate each frame (Page.frameRequestedNavigation), keyed by frame id and URL without fragment. */
  private readonly navigationReasons = new Map<string, string>();
  entryStatus: number | null = null;
  /** The page target's main frame; documents for it are never fetched from an allowed host. */
  mainFrameId: string | null = null;
  /**
   * Set when a click probe's activation starts and cleared only when the
   * daemon's own reload of the entry commits: every request the probed
   * document (or anything it navigated to) makes in between is refused.
   */
  probing = false;
  /** Set by load() until the daemon's own navigation to the entry commits in the main frame. */
  private awaitingOwnCommit = false;
  /** The committed entry document's loader; null until the daemon's own navigation commits. */
  private entryLoaderId: string | null = null;
  /** Where the main frame went when a document other than the daemon's own entry load committed there. */
  private leftTo: EvidenceText | EvidenceParam | null = null;
  private loaded: (() => void) | null = null;

  constructor(private readonly cdp: CdpPipe, readonly sessionId: string, private readonly targetId: string, private readonly root: string, private readonly entryUrl: string, private budget: ReviewServeBudget, private egress: EgressSession) {
    const mine = (handler: (params: Record<string, unknown>) => void) => (params: Record<string, unknown>, sessionId: string | undefined) => { if (sessionId === this.sessionId) handler(params); };
    this.off.push(
      cdp.on('Fetch.requestPaused', mine(params => { void this.answer(params); })),
      cdp.on('Page.loadEventFired', mine(() => this.loaded?.())),
      // Cross-document commits only; same-document changes (pushState, replaceState, hash) arrive as navigatedWithinDocument and keep the entry.
      cdp.on('Page.frameNavigated', mine(params => this.committed(params.frame as { parentId?: string; loaderId?: string; url?: string } | undefined))),
      cdp.on('Page.windowOpen', mine(params => {
        const url = PageText.of(params.url);
        this.windowOpens++;
        this.blockedEvents++; this.blocked.set(`window-open:${url.sha256()}`, { url: url.isBlank() ? evidenceUrl(PageText.of('about:blank'), this.evidenceContext) : evidenceUrl(url, this.evidenceContext), resourceType: evidenceVocabulary(PageText.of('Popup'), 'resourceType'), reason: ev('egress.refusedPopup') });
      })),
      cdp.on('Page.frameRequestedNavigation', mine(params => {
        if (typeof params.frameId === 'string' && typeof params.url === 'string') this.navigationReasons.set(navigationKey(params.frameId, params.url), String(params.reason ?? 'other'));
      })),
      // Console, exception and log text is page text: it becomes a record of length, digest and a reduced source.
      cdp.on('Runtime.exceptionThrown', mine(params => {
        const details = params.exceptionDetails as { url?: string; lineNumber?: number; columnNumber?: number; stackTrace?: { callFrames?: CallFrame[] } } | undefined;
        const frame = details?.stackTrace?.callFrames?.[0];
        const source = details?.url ? consoleSource(PageText.of(details.url), details.lineNumber, details.columnNumber, this.evidenceContext)
          : frame ? consoleSource(PageText.ofNullable(frame.url), frame.lineNumber, frame.columnNumber, this.evidenceContext) : null;
        this.noteConsole('exception', PageText.of(exceptionText(params)), source);
      })),
      cdp.on('Runtime.consoleAPICalled', mine(params => {
        if (params.type !== 'error' && params.type !== 'assert') return;
        const frame = (params.stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames?.[0];
        this.noteConsole('console', PageText.of(consoleText(params)), frame ? consoleSource(PageText.ofNullable(frame.url), frame.lineNumber, frame.columnNumber, this.evidenceContext) : null);
      })),
      cdp.on('Log.entryAdded', mine(params => {
        const entry = params.entry as { level?: string; source?: string; text?: string; url?: string; lineNumber?: number } | undefined;
        // Network-sourced log lines duplicate the resource records kept below.
        if (entry?.level === 'error' && entry.source !== 'network') this.noteConsole('log', PageText.of(entry.text), consoleSource(PageText.ofNullable(entry.url), entry.lineNumber, 0, this.evidenceContext));
      })),
    );
  }

  /**
   * What this capture can vouch for: project files it served or read (the
   * serve log) and the run's allow-listed origins. Every URL that becomes
   * evidence is reduced against it.
   */
  readonly evidenceContext: EvidenceContext = {
    served: relPath => this.served.has(relPath) || this.verifiedPaths.has(relPath),
    allowedOrigin: origin => this.egress.evidenceContext.allowedOrigin(origin),
  };

  /** The message is hashed into a record here; nothing downstream ever sees its text. */
  private noteConsole(kind: ConsoleRecord['kind'], text: PageText, source: ConsoleRecord['source']): void {
    const record = consoleRecord({ kind, text, source });
    const seen = this.console.get(record.id);
    if (seen) seen.count++; else if (this.console.size < 400) this.console.set(record.id, record);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) { return this.cdp.send(method, params, this.sessionId, timeoutMs); }

  /** Every refused request and new-window attempt, counted (the `blocked` map keeps one entry per URL). */
  blockedEvents = 0;
  windowOpens = 0;

  /**
   * W3: the motion phases reload the page under their own serving and
   * egress budgets, so they never spend the run's (and never block it).
   */
  useBudgets(budget: ReviewServeBudget, egress: EgressSession): void { this.budget = budget; this.egress = egress; }

  /**
   * NB3: the viewport the daemon emulated for this capture. Motion tiles and
   * the off-screen test use it; a page can redefine innerWidth/innerHeight.
   */
  viewport: { width: number; height: number } = { width: 0, height: 0 };

  private async answer(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string;
    const request = params.request as { url: string; method: string; headers?: Record<string, string> };
    const resourceType = String(params.resourceType ?? 'Other');
    const fulfill = (status: number, body: Buffer, contentType: string) => this.send('Fetch.fulfillRequest', {
      requestId, responseCode: status, body: body.toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: contentType }, { name: 'Cache-Control', value: 'no-store' }],
    }).catch(() => undefined);
    let url: URL;
    try { url = new URL(request.url); } catch { await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined); return; }
    if (url.origin !== REVIEW_PREVIEW_ORIGIN && this.egress.matches(url)) {
      // A missing frame id is treated as the main frame.
      const frameId = typeof params.frameId === 'string' ? params.frameId : null;
      const mainFrame = frameId === null || frameId === this.mainFrameId;
      const navigationReason = resourceType === 'Document' && !mainFrame && frameId ? await this.navigationReason(frameId, request.url) : null;
      const decision = egressEligible({ url: request.url, method: request.method, resourceType, mainFrame, probing: this.probing, navigationReason, staticFrameSource: this.staticFrameSources.has(request.url.split('#')[0]!) }, this.getFormActions);
      if (decision.eligible) { await this.answerEgress(requestId, request, resourceType); return; }
      this.blockedEvents++; this.blocked.set(request.url, { url: evidenceUrl(PageText.of(request.url), this.evidenceContext), resourceType: typeText(resourceType), reason: decision.reason });
      if (resourceType === 'Document') this.externalDocumentBlocked++;
      await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      return;
    }
    if (url.origin !== REVIEW_PREVIEW_ORIGIN) {
      this.blockedEvents++; this.blocked.set(request.url, { url: evidenceUrl(PageText.of(request.url), this.evidenceContext), resourceType: typeText(resourceType) });
      if (resourceType === 'Document') this.externalDocumentBlocked++;
      await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      return;
    }
    if (isMockedSubmission({ url: request.url, method: request.method, resourceType }, this.getFormActions)) {
      // Mock destination: submissions are recorded, never delivered anywhere.
      this.submissions++;
      await fulfill(200, Buffer.from(resourceType === 'Document' ? '<!doctype html><title>Submission captured</title><p>Submission captured by the review probe.</p>' : '{}'), resourceType === 'Document' ? 'text/html; charset=utf-8' : 'application/json');
      return;
    }
    // Read, encode and fulfil inside one budget slot so in-flight file bytes stay bounded.
    const answered = await this.budget.withReadSlot(async () => {
      const file = await budgetedRead(this.budget, this.root, url.pathname);
      if (!file) return false;
      if (request.url.split('#')[0] === this.entryUrl) this.entryStatus = file.status;
      if (file.status === 200) {
        const hashes = this.served.get(file.relPath) ?? new Set<string>();
        this.served.set(file.relPath, hashes.add(file.sha256));
        if (/^text\/html/u.test(file.contentType)) for (const src of declaredFrameSources(file.body.toString('utf8'), request.url)) this.staticFrameSources.add(src);
        await fulfill(200, file.body, file.contentType);
        return true;
      }
      // A file the server did not serve is not in the serve log, so its path is a digest.
      if (file.relPath !== FAVICON) this.missing.set(request.url, { url: evidenceUrl(PageText.of(request.url), this.evidenceContext), resourceType: typeText(resourceType), outcome: file.status === 404 ? 'missing' : 'refused', status: file.status });
      await fulfill(file.status, Buffer.from(file.reason), 'text/plain; charset=utf-8');
      return true;
    });
    // Over budget: refuse the request; the capture reports the budget so the run is inconclusive.
    if (!answered) await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  }

  /**
   * A request to a host on the run's allow-list: the daemon fetches it (the
   * browser never does) and fulfils the page with the answer. A refusal stays
   * a blocked request with its reason; a 4xx/5xx is a broken resource.
   */
  private async answerEgress(requestId: string, request: { url: string; method: string; headers?: Record<string, string> }, resourceType: string): Promise<void> {
    const headers = request.headers ?? {};
    const display = evidenceUrl(PageText.of(request.url), this.evidenceContext);
    this.pendingEgress.set(requestId, { url: display, resourceType: typeText(resourceType) });
    const answer = await this.egress.fetch({ url: PageText.of(request.url), method: PageText.of(request.method), resourceType: PageText.of(resourceType), origin: PageText.ofNullable(headers.Origin ?? headers.origin) }).catch(() => ({ kind: 'refused' as const, reason: ev('egress.unexpected') }));
    this.pendingEgress.delete(requestId);
    if (answer.kind === 'refused') {
      this.blockedEvents++; this.blocked.set(request.url, { url: display, resourceType: typeText(resourceType), reason: answer.reason });
      if (resourceType === 'Document') this.externalDocumentBlocked++;
      await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      return;
    }
    if (answer.status >= 400) this.missing.set(request.url, { url: display, resourceType: typeText(resourceType), outcome: 'missing', status: answer.status });
    await this.send('Fetch.fulfillRequest', { requestId, responseCode: answer.status, body: answer.body.toString('base64'), responseHeaders: answer.headers }).catch(() => undefined);
  }

  async load(): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EvidenceError(ev('capture.loadTimeout'))), LOAD_TIMEOUT_MS); timer.unref?.();
      this.loaded = () => { clearTimeout(timer); this.loaded = null; resolve(); };
    });
    this.awaitingOwnCommit = true; this.entryLoaderId = null; this.leftTo = null;
    const navigation = await this.send('Page.navigate', { url: this.entryUrl });
    if (navigation.errorText) throw new EvidenceError(ev('capture.navigationFailed', evidenceVocabulary(PageText.of(navigation.errorText), 'netError')));
    await loaded;
    await this.settleEgress();
    await this.evaluate('document.fonts ? document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) : null', true).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  /**
   * The reason the page gave for navigating a frame to this URL. The event can
   * trail the paused request slightly, so wait briefly; no reason seen means
   * the navigation is not fetched (fail closed).
   */
  private async navigationReason(frameId: string, url: string): Promise<string | null> {
    const key = navigationKey(frameId, url);
    const until = Date.now() + NAVIGATION_REASON_WAIT_MS;
    for (;;) {
      const reason = this.navigationReasons.get(key);
      if (reason) { this.navigationReasons.delete(key); return reason; }
      if (Date.now() >= until) return null;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /** Waits (bounded) for allowed-host requests the page started while loading, so evidence is read after they land. */
  private async settleEgress(): Promise<void> {
    const until = Date.now() + EGRESS_SETTLE_MS;
    while (this.pendingEgress.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  }

  /**
   * Invariant: an allowed-host request the page made is never silently absent
   * from the evidence. One still unanswered when the capture is read is
   * recorded as blocked (so the resource check cannot pass).
   */
  unsettledEgress(): { url: EvidenceParam; resourceType: EvidenceParam; reason: EvidenceText }[] {
    return [...this.pendingEgress.values()].map(item => ({ ...item, reason: ev('egress.stillLoading') }));
  }

  private committed(frame: { parentId?: string; loaderId?: string; url?: string } | undefined): void {
    if (!frame || frame.parentId) return;
    const url = String(frame.url ?? '');
    if (this.awaitingOwnCommit && url.split('#')[0] === this.entryUrl) {
      this.awaitingOwnCommit = false; this.entryLoaderId = frame.loaderId ?? null; this.leftTo = null; this.probing = false;
      return;
    }
    this.leftTo = url ? evidenceUrl(PageText.of(url), this.evidenceContext) : ev('common.anotherDocument');
  }

  /**
   * Invariant: evidence is only read while the main frame still holds the
   * entry document the daemon itself loaded. Any later cross-document commit
   * (another site, a blob: or data: document, Chrome's error page for a
   * refused navigation, even a script reload) makes this capture
   * inconclusive; same-document URL changes (pushState, replaceState, hash)
   * do not.
   */
  async assertOnEntry(): Promise<void> {
    if (this.leftTo !== null) throw new EntryLeftError(ev('capture.leftEntry', this.leftTo));
    if (this.awaitingOwnCommit || this.entryLoaderId === null) throw new EntryLeftError(ev('capture.leftBeforeLoad'));
    const origin = await this.evaluate<unknown>('location.origin').catch(() => null);
    if (origin !== REVIEW_PREVIEW_ORIGIN) throw new EntryLeftError(ev('capture.leftOrigin', evidenceUrl(PageText.of(origin), this.evidenceContext)));
  }

  /** `userGesture` is off for passive reads (motion sampling) so reading never grants the page a user activation. */
  async evaluate<T>(expression: string, awaitPromise = false, userGesture = true): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, 20_000);
    const details = result.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    // A page exception's text is page-controlled: it leaves this method only as a length+digest token.
    if (details) throw new EvidenceError(ev('capture.scriptThrew', PageText.of(details.exception?.description ?? details.text ?? '').token()));
    return (result.result as { value: T }).value;
  }

  async close(): Promise<void> {
    for (const off of this.off) off();
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

/** A CDP resource type as evidence: its closed vocabulary or the page-text token. */
function typeText(resourceType: string): EvidenceParam {
  return evidenceVocabulary(PageText.of(resourceType), 'resourceType');
}

// The in-page probes run where page script can spoof their output, so their
// JSON is read defensively: numbers stay numbers, enums keep their vocabulary,
// and every string becomes PageText.
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const rgba = (value: unknown): Rgba => { const parts = list(value); return [num(parts[0]), num(parts[1]), num(parts[2]), num(parts[3])]; };
const keysIn = (value: unknown, allowed: ReadonlySet<string>) => list(value).filter((key): key is string => typeof key === 'string' && allowed.has(key));

interface RawAction { raw: Record<string, unknown>; selector: string; kind: ActionProbe['kind']; link: { kind: string; path: string; found: boolean } | null; fingerprint: ActionFingerprint | null }

function fingerprintIn(value: unknown): ActionFingerprint | null {
  const raw = record(value);
  return typeof raw.key === 'string' && raw.key.length <= 4096 && Number.isInteger(raw.ordinal) && Number.isInteger(raw.size) && Number(raw.size) >= 1
    ? { key: raw.key, ordinal: Number(raw.ordinal), size: Number(raw.size) } : null;
}

async function keyboardTrace(page: PageTarget, focusableCount: number): Promise<ViewportCapture['keyboard']['steps']> {
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.evaluate('(document.activeElement && document.activeElement.blur && document.activeElement.blur(), window.focus(), true)');
  const steps: ViewportCapture['keyboard']['steps'] = [];
  const presses = Math.min(Math.max(0, focusableCount) + 2, 80);
  for (let index = 0; index < presses; index++) {
    for (const type of ['rawKeyDown', 'keyUp'] as const) await page.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    const step = record(await page.evaluate<unknown>(`(${FOCUS_STEP})()`));
    steps.push({ selector: typeof step.selector === 'string' ? PageText.of(step.selector) : null, focusVisible: step.focusVisible === true, ...(Number.isSafeInteger(step.documentIndex) ? { documentIndex: step.documentIndex as number } : {}) });
    if (typeof step.selector !== 'string' && steps.length > 1) break;
  }
  return steps;
}

async function clickProbe(page: PageTarget, action: RawAction): Promise<NonNullable<ActionProbe['clickEffect']>> {
  await page.load();
  await page.assertOnEntry();
  page.getFormActions = new Set(list(await page.evaluate<unknown>(GET_FORM_ACTIONS).catch(() => [])).filter((item): item is string => typeof item === 'string'));
  const submissionsBefore = page.submissions; const blockedBefore = page.externalDocumentBlocked;
  let result: Omit<NonNullable<ActionProbe['clickEffect']>, 'submissionCaptured' | 'externalBlocked'>;
  // Cleared only when the next reload of the entry commits (see PageTarget.committed).
  page.probing = true;
  try {
    // The selector and the private fingerprint go back to the page that produced them; neither is ever evidence.
    const raw = record(await page.evaluate<unknown>(`(${CLICK_PROBE})(${JSON.stringify(action.selector)}, ${JSON.stringify(action.kind)}, ${JSON.stringify(action.fingerprint)})`, true));
    const target = pageEnum(raw.target, ['same', 'relocated', 'missing', 'ambiguous'] as const, 'missing');
    result = { target, domMutations: num(raw.domMutations), navigated: raw.navigated === true, error: raw.error === null || raw.error === undefined ? null : PageText.of(raw.error) };
  } catch (error) {
    // The page navigated away mid-probe: the activation did something.
    const message = error instanceof Error ? error.message : '';
    if (!/context was destroyed|Inspected target navigated|Cannot find context/i.test(message)) throw error;
    result = { target: 'same', domMutations: 0, navigated: true, error: null };
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  return { ...result, submissionCaptured: page.submissions > submissionsBefore, externalBlocked: page.externalDocumentBlocked > blockedBefore };
}

/** An external link on an allowed host is fetched once per run; any other external link stays unvisited. */
async function externalDestination(egress: EgressSession, href: string, base: string): Promise<NonNullable<ActionProbe['destination']>> {
  let url: URL;
  try { url = new URL(href, base); } catch { return { kind: 'external' }; }
  if (!egress.matches(url)) return { kind: 'external' };
  const answer = await egress.linkStatus(PageText.of(url.href));
  return 'status' in answer ? { kind: 'external', status: answer.status } : { kind: 'external', reason: answer.reason };
}

const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
} as const;
const KEY_TEXT: Partial<Record<keyof typeof KEYS, string>> = { Enter: '\r', Space: ' ' };
/** One key press: Tab moves focus; Enter and Space carry text so the browser runs its default activation. */
async function pressKey(page: PageTarget, name: keyof typeof KEYS): Promise<void> {
  const text = KEY_TEXT[name];
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...KEYS[name], ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[name] });
}

/** Wall-clock ceiling for every motion phase at one width; a phase that cannot start inside it is recorded as an error. */
const MOTION_BUDGET_MS = 120_000;
const MAX_PAUSE_TAB_PRESSES = 80;
const BUDGET_SPENT = ev('motion.budgetSpent');
/** W3: the motion phases' own serving budget, separate from the run's (they reload the page up to four times per width). */
export const MOTION_SERVE_LIMITS = { maxRequests: 2_000, maxBytes: 256 * 1024 * 1024, maxConcurrentReads: 4 };

/** The motion phases' own budgets for one review session (W3). */
export interface MotionBudgets { serve: ReviewServeBudget; egress: EgressSession }

const UNMEASURED_TAGS = ['canvas', 'video', 'iframe', 'embed', 'object', 'img'];
/**
 * Words an UnmeasuredItem from the page as evidence. The page supplies only
 * data; the template is fixed here, the element kind is a closed tag
 * vocabulary value, the selector passes evidenceSelector, and anything
 * unexpected still counts as unmeasured (fail closed).
 */
export function describeUnmeasured(item: UnmeasuredItem): EvidenceText {
  switch (item?.kind) {
    case 'offscreen': {
      const tag = String(item.element).toLowerCase();
      return ev('motion.unmeasured.offscreen', UNMEASURED_TAGS.includes(tag) ? vocab('tag', tag) : PageText.of(item.element).token(), evidenceSelector(PageText.of(item.selector)));
    }
    case 'frame': return ev('motion.unmeasured.frame', evidenceSelector(PageText.of(item.selector)));
    case 'raf': return ev('motion.unmeasured.raf');
    case 'workers': return ev('motion.unmeasured.workers', Number.isSafeInteger(item.count) ? item.count : 1);
    case 'timers-truncated': return ev('motion.unmeasured.timersTruncated');
    case 'tracker-missing': return ev('motion.unmeasured.trackerMissing');
    default: return ev('motion.unmeasured.unreadable');
  }
}

/**
 * The page-clock time an after-action watch counts from: once the page has
 * produced two animation frames after the action (bounded), so the action's
 * own repaint lands inside the grace period even on a loaded host.
 */
async function afterActionStart(page: PageTarget): Promise<number> {
  return page.evaluate<number>(`new Promise((resolve) => {
    const done = () => resolve(performance.now());
    const timer = setTimeout(done, ${MOTION_GRACE_MS});
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(); }));
  })`, true, false);
}

/**
 * NB2/NB3: a full-resolution PNG of the daemon's own emulated viewport,
 * decoded so every tile can be compared pixel by pixel; null when the
 * screenshot or its decoding fails (the pixels are then unknown, never still).
 */
async function viewportImage(page: PageTarget): Promise<DecodedImage | null> {
  const { width, height } = page.viewport;
  if (!(width > 0 && height > 0 && width <= 10_000 && height <= 10_000)) return null;
  try {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false }) as { data?: unknown };
    return typeof shot.data === 'string' ? decodePng(Buffer.from(shot.data, 'base64')) : null;
  } catch { return null; }
}


/**
 * Samples motion on the current document from now until `untilMs` (page
 * clock). Movement counts as continuing only between two samples both taken
 * at or after `continuousFromMs`; running animations count at any such
 * sample. Every sample that saw movement is timed (`movementMs`) so the
 * evaluator can tell how long the page stays quiet between movements. With
 * `untilMovement` it stops at the first continuing movement. Bounded by the
 * window plus three seconds of wall time and by the phase deadline.
 */
async function observeMotion(page: PageTarget, continuousFromMs: number, untilMs: number, deadline: number, options: { untilMovement?: boolean } = {}): Promise<MotionObservation> {
  // Page strings (selectors, animation names) stay PageText; subjects are keyed by a digest, never by the text.
  const movingAfter = new Map<string, PageText>(); const animationsAfter = new Map<string, MotionObservation['animationsAfter'][number]>();
  const movementMs: number[] = []; let unmeasured: EvidenceText[] = []; let timers: MotionObservation['timers'] = [];
  const elementKey = (selector: string) => `element ${PageText.of(selector).sha256().slice(0, 16)}`;
  /** NB1: movement times per subject, so one busy element cannot hide a slower one. */
  const subjects = new Map<string, number[]>();
  const moved = (key: string, time: number) => {
    const times = subjects.get(key) ?? (subjects.size < 120 ? subjects.set(key, []).get(key)! : null);
    if (times && times.length < 60 && times[times.length - 1] !== time) times.push(time);
  };
  let fromMs: number | null = null; let toMs = 0; let samples = 0; let samplesAfter = 0;
  let pixelChanged = false; let pixelUnknown = false; let pixelCompared = false;
  let previous: { after: boolean; image: DecodedImage | null } | null = null;
  const tiles = new TileChangeTracker();
  let stopAt = deadline;
  for (;;) {
    const started = Date.now();
    const sample: MotionSampleResult = await page.evaluate<MotionSampleResult>(`(${MOTION_SAMPLE})(${previous === null}, ${page.viewport.width}, ${page.viewport.height})`, false, false);
    let image = await viewportImage(page);
    const compare = (next: DecodedImage | null) => (previous?.image && next ? tileChangeCounts(previous.image, next) : null);
    let counts = compare(image);
    const elementsQuiet = !sample.moved.length && !sample.animations.length;
    if (previous && elementsQuiet && counts && tiles.peek(counts).length) {
      // A pixel change with no element moving is confirmed by a second screenshot: a raster glitch that returns to the
      // previous frame is not motion; anything else (a new frame, or a different one again) is kept.
      const again = await viewportImage(page);
      const againCounts = compare(again);
      if (againCounts && !tiles.peek(againCounts).length) { image = previous.image; counts = againCounts.map(() => 0); } else { image = again; counts = againCounts; }
    }
    // NW3: the tracker decides which tiles changed, so a small change that keeps recurring is not excused as noise.
    const tilesChanged = counts ? tiles.update(counts) : null;
    if (!counts) tiles.reset();
    samples++; toMs = sample.now; unmeasured = (Array.isArray(sample.unmeasured) ? sample.unmeasured : [{ kind: 'tracker-missing' } as const]).slice(0, 8).map(describeUnmeasured); timers = sample.timers;
    if (fromMs === null) { fromMs = sample.now; stopAt = Math.min(deadline, started + Math.max(0, untilMs - sample.now) + 3_000); }
    // NB2: each viewport tile is its own subject; 'viewport pixels' is the pooled view of the same changes.
    const changed = tilesChanged ?? [];
    const pixelsMoved = changed.length > 0;
    if ((previous !== null && sample.moved.length > 0) || pixelsMoved || sample.animations.length > 0) { if (movementMs.length < 120) movementMs.push(Math.round(sample.now)); }
    const at = Math.round(sample.now);
    if (previous !== null) for (const selector of sample.moved) moved(elementKey(selector), at);
    for (const item of sample.animations) moved(elementKey(item.selector), at);
    if (pixelsMoved) moved('viewport pixels', at);
    for (const index of changed) moved(pixelTileKey(index), at);
    const after: boolean = sample.now >= continuousFromMs;
    let continuing = false;
    if (after) {
      samplesAfter++;
      for (const item of sample.animations) { continuing = true; if (animationsAfter.size < 10) animationsAfter.set(`${elementKey(item.selector)}|${PageText.of(item.name).sha256()}`, { selector: PageText.of(item.selector), name: PageText.of(item.name), iterations: typeof item.iterations === 'number' ? item.iterations : null }); }
      if (previous?.after) {
        for (const selector of sample.moved) { continuing = true; if (movingAfter.size < 10) movingAfter.set(elementKey(selector), PageText.of(selector)); }
        if (tilesChanged === null) pixelUnknown = true;
        else { pixelCompared = true; if (changed.length) { pixelChanged = true; continuing = true; } }
      }
    }
    previous = { after, image };
    if ((options.untilMovement && continuing) || sample.now >= untilMs || Date.now() >= stopAt) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, MOTION_SAMPLE_INTERVAL_MS - (Date.now() - started))));
  }
  return {
    continuousFromMs: Math.round(continuousFromMs), fromMs: Math.round(fromMs ?? 0), toMs: Math.round(toMs), samples, samplesAfter,
    movingAfter: [...movingAfter.values()], animationsAfter: [...animationsAfter.values()],
    pixelsChangedAfter: pixelChanged ? true : pixelUnknown || !pixelCompared ? null : false,
    movementMs, unmeasured,
    subjects: [...subjects].map(([key, times]) => ({ key, movementMs: times })),
    // Timer keys are the tracker's own kind:n ids; anything else the page managed to return becomes a digest key.
    timers: timers.slice(0, 20).map(timer => ({ key: TIMER_KEY.test(String(timer.key)) ? String(timer.key) : `timer ${PageText.of(timer.key).sha256().slice(0, 16)}`, kind: pageEnum(timer.kind, ['interval', 'timeout'] as const, 'interval'), fires: (Array.isArray(timer.fires) ? timer.fires : []).slice(-30).map(Number).filter(Number.isFinite).map(Math.round), nextDueMs: typeof timer.nextDueMs === 'number' && Number.isFinite(timer.nextDueMs) ? Math.round(timer.nextDueMs) : null })),
  };
}

const TIMER_KEY = /^(?:interval|timeout):\d{1,9}$/u;
/** A phase failure as evidence: an EvidenceError's own message, else the error text's token (it may echo page text). */
const failureText = (error: unknown): EvidenceText => error instanceof EvidenceError ? error.evidence : ev('motion.phaseError', PageText.of(error instanceof Error ? error.message : 'unknown error').token());
async function guardedPhase(deadline: number, run: () => Promise<MotionPhase>): Promise<MotionPhase> {
  if (Date.now() >= deadline) return { error: BUDGET_SPENT };
  try { return await run(); } catch (error) { return { error: failureText(error) }; }
}

const focusedControl = (page: PageTarget) => page.evaluate<FocusedControlResult>(`(${FOCUSED_CONTROL})()`, false, false);

/**
 * W2: Tabs from the top of the page, through open shadow roots and
 * same-origin frames. Only focus returning to the first stop ends the walk
 * (or, with nothing focusable, three empty presses); the press cap or the
 * deadline leaves it incomplete.
 */
async function tabWalk(page: PageTarget, deadline: number): Promise<{ stops: NonNullable<FocusedControlResult>[]; complete: boolean }> {
  await page.evaluate(BLUR_DEEP, false, false);
  const stops = new Map<string, NonNullable<FocusedControlResult>>();
  let first: string | null = null; let empty = 0;
  for (let press = 0; press < MAX_PAUSE_TAB_PRESSES && Date.now() < deadline; press++) {
    await pressKey(page, 'Tab');
    const focused = await focusedControl(page);
    if (!focused) { if (++empty >= 3) return { stops: [...stops.values()], complete: true }; continue; }
    empty = 0;
    if (focused.selector === first) return { stops: [...stops.values()], complete: true };
    first ??= focused.selector;
    if (!stops.has(focused.selector)) stops.set(focused.selector, focused);
  }
  return { stops: [...stops.values()], complete: false };
}

/** Moves keyboard focus to `selector` by Tab from the top; null when the walk does not reach it. */
async function focusByTab(page: PageTarget, selector: string, deadline: number): Promise<NonNullable<FocusedControlResult> | null> {
  await page.evaluate(BLUR_DEEP, false, false);
  let first: string | null = null; let empty = 0;
  for (let press = 0; press < MAX_PAUSE_TAB_PRESSES && Date.now() < deadline; press++) {
    await pressKey(page, 'Tab');
    const focused = await focusedControl(page);
    if (!focused) { if (++empty >= 3) return null; continue; }
    empty = 0;
    if (focused.selector === selector) return focused;
    if (focused.selector === first) return null;
    first ??= focused.selector;
  }
  return null;
}

/**
 * The pause probe (WCAG 2.2.2) on a fresh no-preference load: a Tab walk
 * finds the controls named like pause, stop or hide; the content must move
 * again in this document before anything is pressed; then the button-like
 * ones are activated by key, pause/stop before hide and nearest the moving
 * content first, each once, until the motion stops. `probing` is set just
 * before the first key press, so the walk itself never refuses an allowed host.
 */
async function pauseControlProbe(page: PageTarget, base: MotionObservation, deadline: number, settle: () => void): Promise<NonNullable<MotionCapture['pause']>> {
  try {
    await page.load(); await page.assertOnEntry(); settle();
    const pattern = new RegExp(PAUSE_CONTROL_NAME, 'iu'); const first = new RegExp(PAUSE_FIRST_NAME, 'iu');
    const candidates = (await page.evaluate<unknown[]>(`(${PAUSE_CANDIDATES})(${JSON.stringify(PAUSE_CONTROL_NAME)})`, false, false)).flatMap(item => (typeof item === 'object' && item !== null ? [{ selector: String((item as { selector?: unknown }).selector ?? ''), name: String((item as { name?: unknown }).name ?? '') }] : []));
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const walk = await tabWalk(page, deadline);
    const named = walk.stops.filter(stop => pattern.test(stop.name));
    const controls = [
      ...named.map(stop => ({ selector: PageText.of(stop.selector), name: PageText.of(stop.name), reachedByKeyboard: true, activatable: stop.activatable === true })),
      ...candidates.filter(item => !named.some(stop => stop.selector === item.selector)).map(item => ({ selector: PageText.of(item.selector), name: PageText.of(item.name), reachedByKeyboard: false, activatable: false })),
    ];
    const centers = await page.evaluate<{ x: number; y: number }[]>(`(${MOVING_CENTERS})(${JSON.stringify(base.movingAfter)})`, false, false).catch(() => []);
    const distance = (stop: { x: number; y: number }) => centers.length ? Math.min(...centers.map(center => Math.hypot(center.x - stop.x, center.y - stop.y))) : Number.POSITIVE_INFINITY;
    const ranked = named.filter(stop => stop.activatable)
      .sort((a, b) => Number(!first.test(a.name)) - Number(!first.test(b.name)) || distance(a) - distance(b))
      .slice(0, MAX_PAUSE_ACTIVATIONS);
    const probe: PauseProbe = { controls, tabStops: walk.stops.length, walkComplete: walk.complete, before: null, attempts: [] };
    if (!ranked.length) return probe;
    const startedAt = await page.evaluate<number>('performance.now()', false, false);
    probe.before = await guardedPhase(deadline, async () => {
      const observation = await observeMotion(page, startedAt, startedAt + stillProofMs(base) + MOTION_SAMPLE_INTERVAL_MS, deadline, { untilMovement: true });
      settle();
      return { observation };
    });
    if (!('observation' in probe.before) || !observedMovement(probe.before.observation)) return probe;
    const proofMs = stillProofMs(base, probe.before.observation);
    for (const control of ranked) {
      if (Date.now() >= deadline) break;
      const focused = await focusByTab(page, control.selector, deadline);
      if (!focused) continue;
      const blockedBefore = page.blockedEvents; const opensBefore = page.windowOpens;
      // Cleared only when a later load of the entry commits (see PageTarget.committed).
      page.probing = true;
      await pressKey(page, focused.key);
      // Focus then leaves the control: a focus ring's repaints are not content motion, and a carousel that only pauses
      // while focused (and resumes on blur) has not been paused by the control.
      await page.evaluate(BLUR_DEEP, false, false);
      const after = await guardedPhase(deadline, async () => {
        const now = await afterActionStart(page);
        const observation = await observeMotion(page, now + MOTION_GRACE_MS, now + afterActionWindowMs(proofMs), deadline);
        await page.assertOnEntry(); settle();
        return { observation };
      });
      probe.attempts.push({ selector: PageText.of(control.selector), name: PageText.of(control.name), blockedDuring: page.blockedEvents - blockedBefore, windowOpensDuring: page.windowOpens - opensBefore, after });
      if (!('observation' in after) || !observedMovement(after.observation)) break;
    }
    return probe;
  } catch (error) { return { error: failureText(error) }; }
}

/**
 * B4-2b motion phases for one width, under the motion budgets (W3) and with
 * TIMER_TRACKER installed for these loads only. A no-preference load decides
 * whether anything keeps moving; only then do the requested phases run: a
 * live switch to reduce on the same document, a fresh reduce load and the
 * pause probe. After-action windows are long enough to cover the quiet
 * stretches the no-preference load saw (B1).
 */
async function motionProbe(page: PageTarget, request: MotionRequest, budgets: MotionBudgets): Promise<MotionCapture> {
  const deadline = Date.now() + MOTION_BUDGET_MS;
  page.useBudgets(budgets.serve, budgets.egress);
  const installed = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TIMER_TRACKER }) as { identifier?: string };
  /** An exhausted motion budget makes the phase inconclusive; it never blocks the run. */
  const settle = () => {
    const spent = budgets.serve.exhausted ?? budgets.egress.exhausted;
    if (spent) throw new EvidenceError(ev('motion.budgetExhausted', spent));
  };
  const prefer = (value: 'no-preference' | 'reduce') => page.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value }] });
  const loadPhase = (value: 'no-preference' | 'reduce') => guardedPhase(deadline, async () => {
    await prefer(value); await page.load(); await page.assertOnEntry(); settle();
    // A focused text field's caret blinks; it is not moving content.
    await page.evaluate(BLUR_DEEP, false, false);
    const observation = await observeMotion(page, MOTION_CONTINUOUS_AFTER_MS, MOTION_LOAD_WINDOW_MS, deadline);
    await page.assertOnEntry(); settle();
    return { observation };
  });
  try {
    const capture: MotionCapture = { noPreference: await loadPhase('no-preference'), liveChange: null, reduced: null, pause: null };
    if (!('observation' in capture.noPreference) || !observedMovement(capture.noPreference.observation)) return capture;
    const base = capture.noPreference.observation;
    if (request.liveChange) {
      capture.liveChange = await guardedPhase(deadline, async () => {
        await prefer('reduce');
        const now = await afterActionStart(page);
        const observation = await observeMotion(page, now + MOTION_GRACE_MS, now + afterActionWindowMs(stillProofMs(base)), deadline);
        await page.assertOnEntry(); settle();
        return { observation };
      });
    }
    if (request.reducedFallback) capture.reduced = await loadPhase('reduce');
    if (request.pauseControl) {
      capture.pause = Date.now() >= deadline ? { error: BUDGET_SPENT } : await prefer('no-preference').then(() => pauseControlProbe(page, base, deadline, settle), error => ({ error: failureText(error) }));
    }
    return capture;
  } finally {
    if (installed.identifier) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.identifier }).catch(() => undefined);
  }
}

/** About 6 MB of PNG bytes. */
const MAX_SCREENSHOT_BASE64 = 8 * 1024 * 1024;

async function captureOn(cdp: CdpPipe, root: string, request: CaptureRequest, budget: ReviewServeBudget, egress: EgressSession, motionBudgets: MotionBudgets): Promise<ViewportCapture> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  const page = new PageTarget(cdp, sessionId, targetId, root, request.url, budget, egress);
  const targetKeys = new Set(request.targets.map(target => target.key));
  try {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await Promise.all([page.send('Page.enable'), page.send('Runtime.enable'), page.send('Log.enable')]);
    const tree = await page.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: unknown } } };
    page.mainFrameId = typeof tree.frameTree?.frame?.id === 'string' ? tree.frameTree.frame.id : null;
    await page.send('Emulation.setDeviceMetricsOverride', { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: request.width < 768 });
    page.viewport = { width: request.width, height: request.height };
    await page.load();
    if (page.entryStatus !== 200) return emptyCapture(request, ev('capture.entryUnserved', page.entryStatus ?? ev('common.noResponse')), budget.exhausted);
    await page.assertOnEntry();
    const screenshotPng = request.screenshot ? await viewportScreenshot(page) : undefined;
    const probe = record(await page.evaluate<unknown>(`(${PAGE_PROBE})(${probeArgument(request.targets)})`));
    // R03 visual facts, read before the keyboard walk moves focus; a failed probe leaves them absent.
    const visual = visualIn(await page.evaluate<unknown>(`(${VISUAL_PROBE})()`).catch(error => { if (error instanceof EntryLeftError) throw error; return null; }));
    await page.assertOnEntry();
    const focusableCount = num(probe.focusableCount);
    const keyboard = await keyboardTrace(page, Number.isFinite(focusableCount) ? focusableCount : 0);
    await page.assertOnEntry();

    const rawActions: RawAction[] = list(probe.actions).map(item => {
      const raw = record(item); const link = raw.link === null || raw.link === undefined ? null : record(raw.link);
      return {
        raw, selector: typeof raw.selector === 'string' ? raw.selector : '', kind: pageEnum(raw.kind, ['link', 'button', 'form'] as const, 'button'),
        link: link ? { kind: typeof link.kind === 'string' ? link.kind : 'empty', path: typeof link.path === 'string' ? link.path : '', found: link.found === true } : null,
        fingerprint: fingerprintIn(raw.fingerprint),
      };
    });
    const actions: ActionProbe[] = [];
    let clicks = 0;
    for (const action of rawActions) {
      const raw = action.raw;
      const keys = keysIn(raw.targetKeys, targetKeys);
      let destination: ActionProbe['destination'] = null;
      if (action.link) {
        if (action.link.kind === 'same-origin') {
          const file = await budget.withReadSlot(() => budgetedRead(budget, root, action.link!.path));
          // A destination the daemon read from the project joins the serve log (and the bundle's
          // sourceHashes, which is how a stored location's path is checked), so its path may be named.
          if (file?.status === 200) {
            page.verifiedPaths.add(file.relPath);
            page.served.set(file.relPath, (page.served.get(file.relPath) ?? new Set<string>()).add(file.sha256));
          }
          destination = { kind: 'same-origin', status: file?.status ?? null };
        } else if (action.link.kind === 'fragment') destination = { kind: 'fragment', found: action.link.found };
        else if (action.link.kind === 'external') destination = await externalDestination(egress, typeof raw.href === 'string' ? raw.href : '', request.url);
        else destination = { kind: pageEnum(action.link.kind, ['mailto', 'tel', 'script', 'empty'] as const, 'empty') };
      }
      let clickEffect: ActionProbe['clickEffect'] = null;
      const visible = raw.visible === true; const disabled = raw.disabled === true;
      if (action.kind !== 'link' && visible && !disabled && (keys.length > 0 || request.probeAllActions) && clicks < MAX_CLICK_PROBES) {
        clicks++;
        clickEffect = await clickProbe(page, action).catch(error => {
          if (error instanceof EntryLeftError) throw error;
          return { target: 'same' as const, domMutations: 0, navigated: false, submissionCaptured: false, externalBlocked: false, error: PageText.of(error instanceof Error ? error.message : 'unknown') };
        }).finally(() => { page.getFormActions = new Set(); });
      }
      actions.push({
        selector: PageText.of(action.selector), kind: action.kind, name: PageText.of(raw.name), visible, disabled,
        width: num(raw.width), height: num(raw.height), inline: raw.inline === true,
        href: typeof raw.href === 'string' ? evidenceUrl(PageText.of(raw.href), page.evidenceContext, request.url) : null,
        destination, clickEffect, targetKeys: keys,
      });
    }
    // Console, resource and egress evidence is read before the motion phases reload the page, so opting in to a
    // motion check never changes what the other checks judge. Served files are read after: every load counts for integrity.
    // Records are copied: a motion reload that repeats an error must not raise the count the console check judges.
    const consoleErrors = [...page.console.values()].map(record => ({ ...record }));
    const resources = [...page.missing.values()];
    const blockedRequests = [...page.blocked.values(), ...page.unsettledEgress()];
    const motion = request.motion ? await motionProbe(page, request.motion, motionBudgets) : undefined;
    return {
      width: request.width, height: request.height, loadError: null,
      document: { lang: probe.lang === null || probe.lang === undefined ? null : PageText.of(probe.lang), title: PageText.of(probe.title), scrollWidth: num(probe.scrollWidth), clientWidth: num(probe.clientWidth), layoutWidth: num(probe.viewportWidth) },
      headings: list(probe.headings).map(item => { const raw = record(item); return { level: num(raw.level), text: PageText.of(raw.text) }; }),
      controls: list(probe.controls).map(item => { const raw = record(item); return { selector: PageText.of(raw.selector), role: PageText.of(raw.role), name: PageText.of(raw.name), ...(Number.isFinite(raw.width) && Number.isFinite(raw.height) ? { width: raw.width as number, height: raw.height as number } : {}) }; }),
      texts: list(probe.texts).map(item => {
        const raw = record(item);
        return { selector: PageText.of(raw.selector), text: PageText.of(raw.text), color: rgba(raw.color), background: raw.background === null ? null : rgba(raw.background), fontSizePx: num(raw.fontSizePx), fontWeight: num(raw.fontWeight), targetKeys: keysIn(raw.targetKeys, targetKeys) };
      }),
      textsTruncated: probe.textsTruncated === true,
      clipped: list(probe.clipped).map(item => { const raw = record(item); return { selector: PageText.of(raw.selector), scrollWidth: num(raw.scrollWidth), clientWidth: num(raw.clientWidth), axis: pageEnum(raw.axis, ['x', 'y'] as const, 'x'), targetKeys: keysIn(raw.targetKeys, targetKeys) }; }),
      outsideViewport: list(probe.outsideViewport).map(item => { const raw = record(item); return { selector: PageText.of(raw.selector), left: num(raw.left), right: num(raw.right), targetKeys: keysIn(raw.targetKeys, targetKeys) }; }),
      actions, console: consoleErrors,
      resources, blockedRequests,
      fonts: list(probe.fonts).map(item => { const raw = record(item); return { family: PageText.of(raw.family), status: pageEnum(raw.status, ['loaded', 'error', 'unloaded', 'loading'] as const, 'loading') }; }),
      keyboard: { focusableCount, steps: keyboard },
      served: [...page.served].flatMap(([path, hashes]) => [...hashes].map(sha256 => ({ path, sha256 }))),
      servingLimit: budget.exhausted,
      ...(screenshotPng ? { screenshotPng } : {}),
      ...(behaviorsIn(probe.behaviors) ?? {}),
      ...(motion ? { motion } : {}),
      ...(visual ? { visual } : {}),
    };
  } catch (error) {
    if (error instanceof EntryLeftError) return emptyCapture(request, error.evidence, budget.exhausted);
    throw error;
  } finally { await page.close(); }
}

/**
 * B5-1 (AC-R06.5): the probe's behavior report, tainted like every other page
 * field. Counts stay as reported (observed-behaviors.ts checks them); samples
 * are PageText until evidenceSelector reduces them. A behavior the report
 * omits stays absent so its fallback applies; a non-object is unknown.
 */
function behaviorsIn(value: unknown): { behaviors: NonNullable<ViewportCapture['behaviors']> } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const behaviors: NonNullable<ViewportCapture['behaviors']> = {};
  for (const behavior of WORKBENCH_OBSERVED_BEHAVIORS) {
    if (!(behavior in raw)) continue;
    const item = raw[behavior];
    if (!item || typeof item !== 'object') { behaviors[behavior] = null; continue; }
    const entry = item as { count?: unknown; samples?: unknown };
    behaviors[behavior] = { count: typeof entry.count === 'number' ? entry.count : Number.NaN, samples: Array.isArray(entry.samples) ? entry.samples.slice(0, 10).map(sample => PageText.of(sample)) : [] };
  }
  return { behaviors };
}

/**
 * R03: the visual probe's report, tainted like every other page field. Numbers
 * stay numbers (evidence-detail.ts clamps them), colours are four numbers,
 * font families and selectors become PageText; anything malformed is absent.
 */
function visualIn(value: unknown): VisualCapture | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const samples = num(raw.samples);
  if (!(samples > 0)) return null;
  const borders = record(raw.borders); const effects = record(raw.effects);
  return {
    surfaces: list(raw.surfaces).slice(0, 24).map(item => { const entry = record(item); return { color: rgba(entry.color), share: num(entry.count) / samples }; }),
    mediaShare: num(raw.media) / samples,
    fonts: list(raw.fonts).slice(0, 24).map(item => { const entry = record(item); return { family: PageText.of(entry.family), count: num(entry.count) }; }),
    borders: { bevel: num(borders.bevel), other: num(borders.other), rounded: num(borders.rounded), maxRadiusPx: num(borders.maxRadiusPx) },
    effects: { shadows: num(effects.shadows), hardShadows: num(effects.hardShadows), insetShadows: num(effects.insetShadows), gradients: num(effects.gradients), backgroundImages: num(effects.backgroundImages) },
    boxes: list(raw.boxes).slice(0, 12).map(item => { const entry = record(item); return { selector: PageText.of(entry.selector), x: num(entry.x), y: num(entry.y), width: num(entry.width), height: num(entry.height), background: Array.isArray(entry.background) ? rgba(entry.background) : null }; }),
    documentHeight: num(raw.documentHeight),
  };
}

/** First-paint PNG for the visual critic; a capture failure or oversize image is simply absent. */
async function viewportScreenshot(page: PageTarget): Promise<string | undefined> {
  try {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as { data?: unknown };
    return typeof shot.data === 'string' && shot.data.length <= MAX_SCREENSHOT_BASE64 ? shot.data : undefined;
  } catch { return undefined; }
}

function emptyCapture(request: CaptureRequest, loadError: EvidenceText, servingLimit: EvidenceText | null): ViewportCapture {
  return {
    width: request.width, height: request.height, loadError, document: { lang: null, title: PageText.of(''), scrollWidth: 0, clientWidth: 0, layoutWidth: 0 },
    headings: [], controls: [], texts: [], textsTruncated: false, clipped: [], outsideViewport: [], actions: [], console: [], resources: [], blockedRequests: [], fonts: [],
    keyboard: { focusableCount: 0, steps: [] }, served: [], servingLimit,
  };
}

const withTimeout = <T>(work: Promise<T>, ms: number, timedOut: EvidenceText) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new EvidenceError(timedOut)), ms); timer.unref?.();
  work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

export interface CdpReviewPortOptions {
  /** Directory for throwaway browser profiles; the daemon passes one under its data root. */
  profileRoot: string;
  findExecutable?: () => string | null;
  /** B4-2: the run's egress allow-list; omitted means default-deny. */
  egress?: ReviewEgressPolicy;
  /** Test seams for the egress session (resolver, transport, limits); production uses the system resolver and https. */
  egressOptions?: EgressOptions;
}

/**
 * Real browser port: the capability test launches the installed browser, so a
 * reported version means the worker actually started.
 */
export function createCdpReviewPort(projectRoot: string, options: CdpReviewPortOptions): ReviewBrowserPort {
  let launched: Launched | null = null;
  return {
    origin: REVIEW_PREVIEW_ORIGIN,
    async capability(): Promise<WorkerCapability> {
      const executable = (options.findExecutable ?? findBrowserExecutable)();
      if (!executable) return { available: false, reason: ev('worker.noExecutable'), recovery: SETUP_RECOVERY };
      try { launched = await launch(executable, options.profileRoot); } catch (error) {
        const failure = error instanceof BrowserStartupError ? error : new BrowserStartupError('unknown', error instanceof Error ? error.message : 'unknown error');
        logStartupFailure(failure);
        return { available: false, reason: ev('worker.headlessFailed', vocab('startupFailure', failure.failure)), recovery: ev(`recovery.startup.${failure.failure}`) };
      }
      return { available: true, browserVersion: launched.version };
    },
    async open(): Promise<ReviewBrowserSession> {
      const current = launched;
      if (!current) throw new Error('capability() must succeed before open()');
      // One budget per session: the totals span every viewport of the review.
      const budget = new ReviewServeBudget();
      // One egress session per run, like the budget: its limits span every viewport.
      const egress = new EgressSession(options.egress?.allowHosts ?? [], options.egressOptions);
      // W3: motion phases reload under budgets of their own, so opting in never spends (or exhausts) the run's.
      const motionBudgets: MotionBudgets = { serve: new ReviewServeBudget(MOTION_SERVE_LIMITS), egress: new EgressSession(options.egress?.allowHosts ?? [], options.egressOptions) };
      return {
        capture: request => withTimeout(captureOn(current.cdp, projectRoot, request, budget, egress, motionBudgets), CAPTURE_TIMEOUT_MS + (request.motion ? MOTION_BUDGET_MS + 15_000 : 0), ev('capture.timedOut', request.width)),
        egress: () => egress.summary(),
        motionEgress: () => motionBudgets.egress.summary(),
        close: async () => { launched = null; egress.close(); motionBudgets.egress.close(); await shutdown(current); },
      };
    },
  };
}
