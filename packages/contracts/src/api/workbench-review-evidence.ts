import { z } from 'zod';

// B4-2 round 9 (captain): mechanical-review text is never stored as free text.
// Every reason, recovery, summary and observation in a current bundle is a
// structured message: a template key from the closed table below plus typed
// parameters. Readers render it from the table (en); nothing the
// page wrote can reach a reader except as one of the parameter kinds, each of
// which is validated here and, where it names something, checked against the
// bundle that carries it (see verificationBundleSchema).

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** HTML (current and legacy), SVG and MathML element names. Custom elements are page-chosen text. */
export const REVIEW_TAG_NAMES: readonly string[] = (
  'a abbr acronym address area article aside audio b base bdi bdo big blockquote body br button canvas caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame frameset '
  + 'h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav nobr noframes noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strike strong style sub summary sup '
  + 'table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr '
  + 'svg g path rect circle ellipse line polyline polygon text tspan textpath defs use symbol image clippath mask pattern lineargradient radialgradient stop foreignobject desc marker switch filter metadata view animate animatemotion animatetransform set '
  + 'feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur feimage femerge femergenode femorphology feoffset fespecularlighting fetile feturbulence '
  + 'math mi mn mo ms mtext mrow mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mtable mtr mtd semantics annotation annotation-xml mspace'
).split(' ');

/** WAI-ARIA 1.2, Graphics ARIA and DPUB-ARIA roles. */
export const REVIEW_ARIA_ROLES: readonly string[] = (
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion '
  + 'link list listbox listitem log main mark marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton '
  + 'status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem graphics-document graphics-object graphics-symbol '
  + 'doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example '
  + 'doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagefooter doc-pageheader doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc'
).split(' ');

/** Chrome network resource types (CDP Network.ResourceType) plus the worker's own `Popup` and `Link`. */
export const REVIEW_RESOURCE_TYPES = ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'FedCM', 'Other', 'Popup', 'Link'] as const;
/** URL schemes evidence may name without a host. */
export const REVIEW_URL_SCHEMES = ['data:', 'javascript:', 'blob:', 'about:', 'mailto:', 'tel:', 'file:', 'chrome:', 'chrome-error:', 'ftp:', 'filesystem:', 'view-source:'] as const;
/** Chrome's Page.frameRequestedNavigation reasons. */
export const REVIEW_NAVIGATION_REASONS = ['anchorClick', 'formSubmissionGet', 'formSubmissionPost', 'httpHeaderRefresh', 'initialFrameNavigation', 'metaTagRefresh', 'other', 'pageBlockInterstitial', 'reload', 'scriptInitiated'] as const;
/** Chrome net error names a navigation can fail with (Page.navigate errorText). */
export const REVIEW_NET_ERRORS = ['net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_RESPONSE', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT', 'net::ERR_INVALID_URL', 'net::ERR_UNSAFE_PORT', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_INVALID_RESPONSE', 'net::ERR_FILE_NOT_FOUND', 'net::ERR_ACCESS_DENIED'] as const;

/** B5-1 (AC-R06.5): behaviors a capture can observe (re-exported as WORKBENCH_OBSERVED_BEHAVIORS). */
export const REVIEW_OBSERVED_BEHAVIORS = ['dialog', 'tabs', 'text-input', 'form', 'button', 'image', 'animation'] as const;
/**
 * R03 evidence detail: font families a reviewer may read by name. A computed
 * family outside this list is page-chosen text and travels only as its token.
 * Matching is case-insensitive; the canonical spelling below is what renders.
 */
export const REVIEW_FONT_FAMILIES: readonly string[] = [
  // Generic and system keywords
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'BlinkMacSystemFont',
  // Operating-system families
  'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Times', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier', 'Courier New',
  'Lucida Console', 'Lucida Grande', 'Lucida Sans Unicode', 'Segoe UI', 'Segoe UI Variable', 'SF Pro Text', 'SF Pro Display', 'SF Mono', 'Menlo', 'Monaco', 'Consolas',
  'Calibri', 'Cambria', 'Candara', 'Garamond', 'Palatino', 'Palatino Linotype', 'Book Antiqua', 'Impact', 'Comic Sans MS', 'Gill Sans', 'Futura', 'Optima', 'Avenir', 'Avenir Next',
  'Ubuntu', 'Cantarell', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'Noto Serif',
  // Widely used web families
  'Roboto', 'Roboto Mono', 'Roboto Slab', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter', 'Source Sans Pro', 'Source Sans 3', 'Source Serif Pro', 'Source Code Pro',
  'Raleway', 'Nunito', 'Playfair Display', 'Merriweather', 'PT Sans', 'PT Serif', 'Oswald', 'Work Sans', 'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'JetBrains Mono',
  'Fira Sans', 'Fira Code', 'Fira Mono', 'DM Sans', 'DM Serif Display', 'Space Grotesk', 'Space Mono', 'Manrope', 'Rubik', 'Karla', 'Libre Baskerville', 'Lora', 'EB Garamond',
  'Cormorant Garamond', 'Bebas Neue', 'Archivo', 'Geist', 'Geist Mono',
  // Period and retro families (AC-R03 style direction, e.g. Windows 95)
  'MS Sans Serif', 'Microsoft Sans Serif', 'MS Serif', 'MS Shell Dlg', 'MS Shell Dlg 2', 'Pixelated MS Sans Serif', 'W95FA', 'Fixedsys', 'Terminal', 'System', 'Chicago', 'Charcoal',
  'Geneva', 'VT323', 'Press Start 2P', 'Silkscreen', 'Pixelify Sans', 'Courier Prime',
];
/** ISO 639-1 primary language subtags a reviewer may read; any other `lang` value travels as its token. */
export const REVIEW_LANGUAGES: readonly string[] = (
  'af am ar az be bg bn bs ca cs cy da de el en es et eu fa fi fil fr ga gl gu he hi hr hu hy id is it ja ka kk km kn ko lo lt lv mk ml mn mr ms mt my nb ne nl nn no pa pl ps pt ro ru '
  + 'si sk sl sq sr sv sw ta te th tl tr uk ur uz vi xh yo zh zu'
).split(' ');

export const REVIEW_EVIDENCE_VOCABULARIES = {
  tag: REVIEW_TAG_NAMES,
  role: [...REVIEW_ARIA_ROLES, ...REVIEW_TAG_NAMES],
  resourceType: REVIEW_RESOURCE_TYPES,
  method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  navigationReason: REVIEW_NAVIGATION_REASONS,
  netError: REVIEW_NET_ERRORS,
  scheme: REVIEW_URL_SCHEMES,
  outcome: ['pass', 'fail', 'inconclusive', 'not-applicable'],
  textSize: ['large', 'normal'],
  consoleKind: ['console', 'exception', 'log'],
  egressOutcome: ['fetched', 'refused', 'failed'],
  actionType: ['conversion', 'form', 'navigation'],
  startupFailure: ['missing-browser', 'missing-library', 'permission-denied', 'profile-locked', 'unsupported-flag', 'crashed', 'timeout', 'unknown'],
  behavior: REVIEW_OBSERVED_BEHAVIORS,
  behaviorState: ['observed', 'not-observed', 'unknown'],
  // R03 evidence detail
  actionKind: ['link', 'button', 'form'],
  destinationKind: ['same-origin', 'fragment', 'external', 'mailto', 'tel', 'script', 'empty'],
  presence: ['found', 'missing'],
  flag: ['yes', 'no'],
  fontFamily: REVIEW_FONT_FAMILIES,
  language: REVIEW_LANGUAGES,
} as const satisfies Record<string, readonly string[]>;
export type ReviewEvidenceVocabulary = keyof typeof REVIEW_EVIDENCE_VOCABULARIES;

// ---------------------------------------------------------------------------
// Template table: the only text a mechanical finding can carry
// ---------------------------------------------------------------------------

/**
 * Every message the evidence worker and the runner can write. `{n}` is the
 * n-th parameter. The English templates name the parameters checked by tests.
 * Keys are permanent: a stored bundle names them, so wording may change but a
 * key is never reused for a different meaning.
 */
export const REVIEW_EVIDENCE_TEMPLATES = {
  // Shared fragments
  /** Free text from a bundle written before structured evidence, served only as its token. */
  'legacy.text': { en: '{0}' },
  'common.none': { en: 'none' },
  'common.empty': { en: 'empty' },
  'common.nothing': { en: '' },
  'common.noResponse': { en: 'no response' },
  'common.unobserved': { en: 'unobserved' },
  'common.anotherDocument': { en: 'another document' },
  // Per-result summaries
  'result.passed': { en: 'Passed at {0} px' },
  'result.notApplicable': { en: 'Nothing on the page is in scope for this check' },
  'result.byWidth': { en: '{0}' },
  'result.atWidth': { en: '{0}px: {1}' },
  'result.outcome': { en: '{0}' },
  'result.blocked': { en: '{0}' },
  'summary.atWidth': { en: '{0} at {1}px' },
  'summary.noBrowser': { en: 'No capable browser worker' },
  'summary.sourceChanged': { en: 'Source changed during capture' },
  'summary.servingLimit': { en: 'Review serving budget exhausted' },
  'summary.egressLimit': { en: 'Review egress budget exhausted' },
  'summary.egressChanged': { en: 'External resource changed during capture' },
  'summary.egress': { en: '{0} of {1} requests to allowed hosts fetched (allow-list: {2})' },
  // Capture and worker
  'capture.none': { en: 'No capture was made at {0}px' },
  'capture.failedAt': { en: 'The page could not be captured at {0}px: {1}' },
  'capture.cancelled': { en: 'The review was cancelled before this width was captured' },
  'capture.failed': { en: 'the capture failed ({0})' },
  'capture.loadTimeout': { en: 'page load timed out' },
  'capture.navigationFailed': { en: 'navigation failed ({0})' },
  'capture.timedOut': { en: 'capture at {0}px timed out' },
  'capture.scriptThrew': { en: 'a page script threw {0}' },
  'capture.entryUnserved': { en: 'The entry file could not be served ({0})' },
  'capture.leftEntry': { en: 'The page left the reviewed entry (it is now at {0}); evidence is only read from the entry page' },
  'capture.leftBeforeLoad': { en: 'The page left the reviewed entry before it finished loading; evidence is only read from the entry page' },
  'capture.leftOrigin': { en: 'The page left the reviewed entry (its origin is now {0}); evidence is only read from the entry page' },
  'worker.cancelled': { en: 'The review was cancelled before the browser started' },
  'worker.startFailed': { en: 'The browser worker failed to start ({0})' },
  'worker.none': { en: 'No browser worker' },
  'worker.noExecutable': { en: 'No compatible Chrome, Edge or Chromium executable is available to the daemon' },
  'worker.headlessFailed': { en: 'The installed browser could not start headless ({0})' },
  // Recovery
  'recovery.list': { en: '{0}' },
  'recovery.newRun': { en: 'Start a new review run.' },
  'recovery.browserStart': { en: 'Check that the installed Chrome, Edge or Chromium starts headless, or set OD_BROWSER_EXECUTABLE_PATH to a working browser, then run the review again.' },
  'recovery.browserInstall': { en: 'Install Google Chrome, Microsoft Edge or Chromium, or set OD_BROWSER_EXECUTABLE_PATH to a supported browser, then run the review again.' },
  'recovery.startup.missing-browser': { en: 'The browser executable was not found. Install Google Chrome, Microsoft Edge or Chromium, or set OD_BROWSER_EXECUTABLE_PATH to an existing browser, then run the review again.' },
  'recovery.startup.missing-library': { en: 'The browser is missing a system library it needs. Install the browser through your package manager (which installs its dependencies), then run the review again.' },
  'recovery.startup.permission-denied': { en: 'The operating system refused to start the browser or its sandbox. Check that the daemon user may run the browser executable and create its sandbox, then run the review again.' },
  'recovery.startup.profile-locked': { en: 'The review browser profile is in use by another browser process. Wait for the other review to finish or close stray browser processes, then run the review again.' },
  'recovery.startup.unsupported-flag': { en: 'The installed browser is too old for the review worker. Update Chrome, Edge or Chromium, or point OD_BROWSER_EXECUTABLE_PATH at a current version, then run the review again.' },
  'recovery.startup.crashed': { en: 'The browser crashed while starting. Run the review again; if it keeps crashing, update or reinstall the browser.' },
  'recovery.startup.timeout': { en: 'The browser did not answer in time while starting. Close other heavy processes, then run the review again.' },
  'recovery.startup.unknown': { en: 'The browser could not start; the daemon log holds its error output. Check that the installed Chrome, Edge or Chromium starts headless, then run the review again.' },
  'recovery.sourceChanged': { en: 'Wait until the project files stop changing (for example, until a running generation finishes), then run the review again.' },
  'recovery.servingLimit': { en: 'Reduce repeated or very large requests made by the page (for example, a script that reloads the same asset), then run the review again.' },
  'recovery.egressLimit': { en: 'Reduce the external requests the page makes to allowed hosts (or remove hosts it does not need from the egress allow-list), then run the review again.' },
  'recovery.egressChanged': { en: 'An allowed external resource returned different bytes during the review; pin it to a versioned URL or serve it from the project, then run the review again.' },
  // Run blockers
  'blocker.sourceChanged': { en: 'Source changed during capture: {0}' },
  'blocker.sourceChangedMore': { en: 'Source changed during capture: {0} and {1} more' },
  'blocker.sourceChangedFile': { en: '{0} was served with different contents across captures' },
  'blocker.egressChanged': { en: 'An allowed external resource changed during capture: {0}' },
  'blocker.egressChangedFetch': { en: '{0} was fetched with different contents across captures' },
  'serve.requestLimit': { en: 'The review reached its limit of {0} requests served from the project' },
  'serve.byteLimit': { en: 'The review reached its limit of {0} MiB ({1} bytes) served from the project' },
  // Declared actions
  'cta.label': { en: '{0} (href {1})' },
  'cta.notProbed': { en: '{0} destination was not probed' },
  'cta.missingPage': { en: '{0} leads to a missing page ({1})' },
  'cta.missingFragment': { en: '{0} points at a fragment that is not on the page' },
  'cta.noNavigation': { en: '{0} does not navigate anywhere' },
  'cta.missingExternal': { en: '{0} leads to a missing external page ({1})' },
  'cta.externalUnchecked': { en: '{0} could not be checked: {1}' },
  'cta.externalNotVisited': { en: '{0} leaves the project; external destinations are not visited unless the run allows their host' },
  'cta.notClickProbed': { en: '{0} was not click-probed' },
  'cta.clickError': { en: '{0} raised an error when activated: {1}' },
  'cta.externalClick': { en: '{0} navigates to an external destination when activated; click navigations are never followed, so the destination is unverified' },
  'cta.noEffect': { en: '{0} had no observable effect when activated' },
  'cta.probeUnmatched': { en: '{0} could not be found again after the probe reloaded the page (no element matched it), so its activation is unverified' },
  'cta.probeRelocated': { en: '{0} resolved to a different element after the probe reloaded the page, so its activation is unverified' },
  'cta.probeAmbiguous': { en: 'The number of elements like {0} (same kind, name and target) changed when the probe reloaded the page, so its activation is unverified' },
  'cta.conversionUndeclared': { en: 'Conversion {0} is not declared in the project context, so its CTA cannot be located' },
  'cta.targetMissing': { en: 'Declared {0} target {1} was not found on the page' },
  'cta.hidden': { en: '{0} is declared but not visible' },
  'cta.disabled': { en: '{0} is declared but disabled' },
  'cta.unnamed': { en: '{0} has no accessible name' },
  'cta.smallTarget': { en: '{0} target is {1}×{2} CSS px, below 24×24' },
  // Contrast
  'contrast.truncated': { en: 'The text probe reached its sample limit at {0}px; text beyond it was not measured' },
  'contrast.unmeasured': { en: '{0} sits on an image, gradient or filtered background; contrast was not measured' },
  'contrast.low': { en: '{0} {1} is {2}:1, below {3}:1 for {4} text' },
  'contrast.samples': { en: '{0} text samples measured' },
  // Console and resources
  'console.errors': { en: '{0} console errors (hashes {1})' },
  'console.record': { en: 'Console {0} {1} ({2} chars, sha256 {3}) at {4}' },
  'console.recordRepeated': { en: 'Console {0} {1} ({2} chars, sha256 {3}) at {4}, seen {5} times' },
  'console.source': { en: '{0}:{1}:{2}' },
  'console.unknownSource': { en: 'unknown source' },
  'console.brokenResource': { en: 'Broken resource {0} ({1}, {2})' },
  'console.fontFailed': { en: 'Font {0} failed to load' },
  'console.blockedRefused': { en: 'External {0} {1} was refused under the egress allow-list: {2}' },
  'console.blockedDefault': { en: 'External {0} {1} was blocked by the evidence egress policy (default-deny; its host is not allowed for this run); its availability is unverified' },
  // Overflow
  'overflow.scroll': { en: 'The document scrolls horizontally by {0} CSS px at {1}px' },
  'overflow.layout': { en: 'The page lays out at {0} CSS px instead of {1}px (no responsive viewport)' },
  'overflow.clipped': { en: '{0} clips {1} CSS px of content' },
  'overflow.outside': { en: '{0} extends {1} CSS px past the viewport edge' },
  // Keyboard
  'keyboard.none': { en: 'No keyboard-focusable elements' },
  'keyboard.noFocusRing': { en: '{0} shows no visible focus indicator' },
  'keyboard.trapped': { en: 'Keyboard focus is trapped at {0}' },
  'keyboard.noReturn': { en: 'Tabbing never returned focus to the start of the page' },
  'keyboard.reached': { en: 'Tab reached {0} of {1} focusable elements' },
  // Document semantics
  'semantics.noLang': { en: 'The document has no lang attribute' },
  'semantics.noTitle': { en: 'The document has no title' },
  'semantics.noH1': { en: 'The page has no h1' },
  'semantics.headingJump': { en: 'Heading {0} jumps from h{1} to h{2}' },
  'semantics.unnamedControl': { en: '{0} ({1}) has no accessible name' },
  // Egress (records and refusals)
  'egress.fetched': { en: 'fetched {0} ({1}) from {2} → {3}, {4} bytes, {5} ms{6}, sha256 {7}' },
  'egress.notFetched': { en: '{0} {1} ({2}){3}: {4}' },
  'egress.afterRedirects': { en: ' after {0} redirect(s)' },
  'egress.refusedProbing': { en: 'Requests to allowed hosts are refused during a click probe (until the review reloads the entry), so activation never reaches a real host' },
  'egress.refusedMainFrame': { en: 'A main-frame navigation to an allowed host is never followed; the review judges the entry page only' },
  'egress.refusedFormSubmission': { en: "Form submissions are never delivered to an external host, in any frame; forms only reach the review's mock destination" },
  'egress.refusedFrameNavigation': { en: "Only a frame's static initial load reaches an allowed host; a {0} subframe navigation is refused" },
  'egress.refusedFrameQuery': { en: 'A subframe URL with a query or fragment is never fetched from an allowed host (it can carry page data)' },
  'egress.refusedFrameUndeclared': { en: 'Only a frame whose src is declared in the served markup reaches an allowed host' },
  'egress.refusedSubmission': { en: 'Submissions are never delivered to an external host' },
  'egress.refusedPopup': { en: 'The page tried to open a new window; new windows are never opened or followed by the review' },
  'egress.stillLoading': { en: 'It was still loading from an allowed host when the evidence was captured' },
  'egress.unexpected': { en: 'The egress request failed unexpectedly' },
  'egress.closed': { en: 'The review closed before this request to an allowed host finished' },
  'egress.wentTo': { en: 'The request went to' },
  'egress.redirectedTo': { en: 'The request was redirected to' },
  'egress.offList': { en: '{0} {1}, a host outside the allow-list' },
  'egress.notHttps': { en: '{0} {1}; only https is fetched from an allowed host' },
  'egress.credentials': { en: '{0} a URL with credentials, which is never fetched' },
  'egress.portNotListed': { en: '{0} port {1} of {2}, which the allow-list does not name' },
  'egress.invalidUrl': { en: 'The request URL is invalid' },
  'egress.outsideAllowList': { en: '{0} is outside the allow-list' },
  'egress.recordLimit': { en: 'The review reached its limit of {0} egress attempts' },
  'egress.method': { en: 'Only GET and HEAD requests reach an allowed host ({0} was refused)' },
  'egress.requestLimit': { en: 'The review reached its limit of {0} requests to allowed hosts' },
  'egress.resolveTimeout': { en: 'Resolving {0} timed out after {1} ms' },
  'egress.unresolved': { en: '{0} did not resolve' },
  'egress.noAddress': { en: '{0} did not resolve to any address' },
  'egress.privateAddress': { en: '{0} resolves to {1}, a non-public address; private, loopback, link-local and reserved ranges are never contacted' },
  'egress.byteLimit': { en: 'The review reached its limit of {0} bytes fetched from allowed hosts' },
  'egress.tooLarge': { en: 'The response from {0} is larger than {1} bytes' },
  'egress.requestTimeout': { en: 'The request to {0} timed out after {1} ms' },
  'egress.requestFailed': { en: 'The request to {0} failed' },
  'egress.tooManyRedirects': { en: 'More than {0} redirects' },
  'egress.badRedirect': { en: '{0} redirected to an invalid URL' },
  // B5-1 observed behaviors (AC-R06.5)
  'behavior.summary': { en: 'Observed: {0}; unknown: {1}' },
  'behavior.record': { en: '{0}: {1}' },
  'behavior.recordSeen': { en: '{0}: {1} ({2} at {3} px; {4})' },
  // B5-1 per-check verdicts (AC-R06.3-R06.5): applicability notes and verdict reasons
  'verdict.withNote': { en: '{0}. {1}' },
  'verdict.note.alwaysApplies': { en: 'A declared not-applicable was refused: this required check always applies' },
  'verdict.note.declared': { en: '{0}' },
  'verdict.note.pageTarget': { en: 'The review target is a page entry; this applies only to a reusable unit the rubric declares' },
  'verdict.note.observedDespiteDeclared': { en: 'Declared not applicable, but the evidence observed {0} ({1})' },
  'verdict.note.absentDespiteDeclared': { en: 'Declared applicable, but the evidence observed no {0} at any captured width' },
  'verdict.note.notObserved': { en: 'No {0} was observed at any captured width' },
  'verdict.note.unknown': { en: 'The evidence could not tell whether the page has {0}' },
  'verdict.mismatch': { en: 'The declared applicability contradicts the frozen evidence' },
  'verdict.notApplicable': { en: 'Not applicable to the reviewed page' },
  'verdict.noResult': { en: 'No mechanical result was recorded for this check' },
  'verdict.noEvidence': { en: 'No mechanical evidence was collected' },
  'verdict.reads': { en: 'Reads {0}: {1}' },
  'verdict.undetermined': { en: 'Applicability is unknown, so the check stays open' },
  'verdict.manualRequired': { en: 'A person must perform this check before the page can pass' },
  'verdict.manualOptional': { en: 'Optional manual check; a person may perform it' },
  'verdict.awaitingAcceptance': { en: '{0} independent reviewer(s) answered; a required judgment cannot pass until a person accepts it, and this version has no acceptance flow yet' },
  'verdict.judged': { en: '{0} independent reviewers answered; judgments inform and never pass a check' },
  'verdict.unreviewed': { en: 'Fewer than two independent reviewers answered ({0}); shown for information, it does not affect the outcome' },
  // B4-2b motion checks (opt-in)
  "motion.subject.element": { en: "{0}" },
  "motion.subject.animation": { en: "{0} ({1})" },
  "motion.subject.animationInfinite": { en: "{0} ({1}, infinite)" },
  "motion.subject.list": { en: "{0}" },
  "motion.subject.viewport": { en: "the rendered viewport" },
  "motion.control": { en: "{0} {1}" },
  "motion.label.noPreference": { en: "Motion with no motion preference at {0}px" },
  "motion.label.reduced": { en: "Motion with prefers-reduced-motion: reduce at {0}px" },
  "motion.label.live": { en: "Motion after a live switch to reduced motion at {0}px" },
  "motion.label.beforePress": { en: "Motion before the pause control was activated at {0}px" },
  "motion.label.afterPress": { en: "Motion after {0} was activated at {1}px" },
  "motion.phase.notObserved": { en: "{0} was not observed" },
  "motion.phase.failed": { en: "{0} could not be observed: {1}" },
  "motion.phase.lateRepaint": { en: "{0}: the viewport changed once after {1} s without any element moving, which may be a late repaint rather than motion" },
  "motion.phase.fewSamples": { en: "{0}: only {1} sample(s) after {2} s, too few to show that nothing moved" },
  "motion.phase.pixelsUnknown": { en: "{0}: the viewport could not be compared, so canvas, video or animated-image motion was not measured" },
  "motion.phase.unmeasured": { en: "{0}: nothing visible moved, but the sampler cannot rule out motion: {1}" },
  "motion.phase.timers": { en: "{0}: nothing visible moved, but {1}" },
  "motion.phase.watchTooShort": { en: "{0}: watched for {1} s after the grace period, but the page moved after quiet stretches of up to {2} s, so the motion may simply not have recurred yet" },
  "motion.phase.endedEarly": { en: "{0}: observed only until {1} s after load, before {2} s, when the motion was seen with no preference" },
  "motion.pause.notRun": { en: "The pause-control probe did not run at {0}px" },
  "motion.pause.failed": { en: "The pause-control probe failed at {0}px: {1}" },
  "motion.pause.notButtonLike": { en: "{0} is named like a pause, stop or hide control but is not a button-like control the review can activate safely at {1}px" },
  "motion.pause.walkCut": { en: "The Tab walk stopped after {0} stops at {1}px (press cap or time budget) before focus returned to the first stop, so a pause, stop or hide control may be unreached" },
  "motion.pause.unreachable": { en: "The pause, stop or hide control {0} is not reachable by keyboard at {1}px" },
  "motion.pause.none": { en: "No keyboard-reachable control can pause, stop or hide the moving content ({0}) at {1}px; Tab reached {2} element(s)" },
  "motion.pause.notMovingBefore": { en: "The moving content did not move again before the pause control was activated at {0}px, so the activation could not be judged" },
  "motion.pause.stillMoving": { en: "After {0} was activated by keyboard at {1}px, {2} kept moving after {3} s" },
  "motion.pause.refused": { en: "{0}: the page stayed still, but {1} request(s) were refused and {2} new window(s) were attempted after the key press, so the stillness may come from the refusal" },
  "motion.pause.stopped": { en: "Activating {0} by keyboard stopped the motion at {1}px" },
  "motion.pause.untried": { en: "Only {0} of {1} pause, stop or hide controls were activated at {2}px before the time budget ran out" },
  "motion.pause.untriedMoving": { en: "Only {0} of {1} pause, stop or hide controls were activated at {2}px before the time budget ran out; {3}" },
  "motion.pause.noneStopped": { en: "No pause, stop or hide control stopped the motion at {0}px" },
  "motion.notSampled": { en: "Motion was not sampled at {0}px" },
  "motion.notApplicable": { en: "Nothing kept moving at {0}px after {1} s with no motion preference (observed {2} s–{3} s after load; DOM boxes and animations were sampled for the whole page, pixels were compared for the visible {4}×{5} viewport only)" },
  "motion.baseMoving": { en: "With no motion preference at {0}px, {1} kept moving after {2} s (observed {3} s–{4} s after load; longest quiet stretch {5} s)" },
  "motion.reduced.moving": { en: "With prefers-reduced-motion: reduce at {0}px, {1} kept moving after {2} s; there is no static or reduced fallback" },
  "motion.reduced.still": { en: "With prefers-reduced-motion: reduce the page stayed still after {0} s at {1}px (observed until {2} s after load)" },
  "motion.live.moving": { en: "After the motion preference was switched to reduce mid-session at {0}px, {1} kept moving" },
  "motion.live.still": { en: "A live switch to prefers-reduced-motion: reduce stopped the motion at {0}px (watched {1} s after the grace period)" },
  "motion.timer.interval": { en: "A repeating timer" },
  "motion.timer.timeout": { en: "A timer" },
  "motion.timer.timeoutDue": { en: "A timer due at {0} s" },
  "motion.timer.linked": { en: "{0} moved the page before after {1} firing(s) (movement followed its firing) but fired {2} time(s) during the watch" },
  "motion.timer.unknown": { en: "{0} is live but has not fired while it was watched, so what it does is unknown" },
  "motion.unmeasured.offscreen": { en: "A {0} outside the viewport ({1}) is not covered by the pixel comparison" },
  "motion.unmeasured.frame": { en: "A same-origin frame ({0}) can run timers the motion tracker does not see" },
  "motion.unmeasured.raf": { en: "An animation-frame loop was still running at the end of the window" },
  "motion.unmeasured.workers": { en: "{0} Web Worker(s) were running; their timers are not tracked" },
  "motion.unmeasured.timersTruncated": { en: "More live timers were running than the motion tracker records" },
  "motion.unmeasured.trackerMissing": { en: "The motion timer tracker was not running in this document, so its timers are unknown" },
  "motion.unmeasured.unreadable": { en: "The page returned motion evidence the review could not read" },
  "motion.budgetSpent": { en: "The motion time budget ran out before this phase" },
  "motion.budgetExhausted": { en: "The motion phases reached their own budget: {0}" },
  "motion.phaseError": { en: "the motion phase failed ({0})" },
  "motion.egressSummary": { en: "Motion reloads: {0} of {1} requests to allowed hosts fetched under the motion budget" },
  "motion.egressSummaryExhausted": { en: "Motion reloads: {0} of {1} requests to allowed hosts fetched under the motion budget (budget exhausted)" },
  // R03 evidence detail: what each mechanical check measured at one width, whatever its outcome
  'detail.cta.count': { en: '{0} action(s) in scope: {1} link(s), {2} button(s), {3} form(s)' },
  'detail.cta.matched': { en: 'Declared {0} target {1}: {2} matching action(s) on the page' },
  'detail.cta.action': { en: '{0} ({1}, {2}×{3} CSS px{4}): {5}' },
  'detail.cta.inline': { en: ', inline text link' },
  'detail.cta.dest': { en: '{0} destination {1}, status {2}' },
  'detail.cta.fragment': { en: 'in-page fragment destination, target {0}' },
  'detail.cta.effect': { en: 'activation made {0} DOM change(s); navigated: {1}; submission captured: {2}' },
  'detail.cta.notActivated': { en: 'activation not probed' },
  'detail.notChecked': { en: 'not checked' },
  'detail.contrast.summary': { en: '{0} text sample(s): lowest ratio {1}:1, median {2}:1; {3} large-text sample(s); thresholds {4}:1 normal, {5}:1 large' },
  'detail.contrast.sample': { en: '{0}: {1}:1, {2} on {3}, {4} px weight {5} ({6} text)' },
  'detail.contrast.unmeasured': { en: '{0} sample(s) on an image, gradient or filtered background were not measured' },
  'detail.console.summary': { en: '{0} console error record(s) ({1} occurrence(s)); {2} broken resource(s); {3} blocked external request(s)' },
  'detail.console.fonts': { en: 'Web fonts: {0} loaded, {1} failed, {2} not loaded or still loading' },
  'detail.overflow.metrics': { en: 'Viewport {0} CSS px: document scroll width {1}, client width {2}, layout width {3}; {4} clipped container(s), {5} text box(es) past the edge' },
  'detail.keyboard.walk': { en: 'Tab walk: {0} focusable element(s), {1} distinct stop(s) reached, {2} with a visible focus indicator; returned to the start: {3}' },
  'detail.semantics.document': { en: 'lang {0}; title present: {1}; {2} heading(s), {3} h1; heading levels {4}; {5} of {6} control(s) named' },
  // R03 visual facts: the rendered page measured from computed styles (never page text)
  'visual.summary': { en: 'Rendered page at {0}×{1} px, measured from computed styles (no page text)' },
  'visual.palette': { en: 'Painted surface colours by share of the first viewport: {0}; images, gradients and media cover {1}%' },
  'visual.swatch': { en: '{0} {1}%' },
  'visual.textColors': { en: 'Text colours by share of text samples: {0}' },
  'visual.fonts': { en: 'Declared font families by share of text samples: {0}' },
  'visual.font': { en: '{0} {1}%' },
  'visual.type': { en: 'Text sizes {0}–{1} px, median {2} px; weights {3}' },
  'visual.borders': { en: 'Bordered elements: {0} bevelled (outset, inset, ridge or groove), {1} other; {2} with rounded corners (largest radius {3} px)' },
  'visual.effects': { en: '{0} element(s) with box shadows ({1} hard-edged without blur, {2} inset); {3} with gradient backgrounds; {4} with background images' },
  'visual.layout': { en: 'Largest boxes in the first viewport: {0}' },
  'visual.box': { en: '{0} at ({1}, {2}) {3}×{4} px, background {5}' },
  'visual.transparent': { en: 'transparent' },
  'visual.page': { en: 'Page height {0} px ({1} viewport heights)' },
} as const satisfies Record<string, { en: string }>;

export type ReviewEvidenceTemplate = keyof typeof REVIEW_EVIDENCE_TEMPLATES;

/**
 * The parameters each template accepts, slot by slot (Sol round 9). A slot
 * lists its alternatives separated by `|`: a parameter kind, `vocab:<name>`
 * for one vocabulary, `location` (a reduced URL or an unparseable one), or
 * `list<...>` with the item alternatives. A message whose parameter is not one
 * of its slot's alternatives is refused.
 */
const SEL = 'selector|token';
const SLOTS = {
  'legacy.text': ['token'],
  'common.none': [], 'common.empty': [], 'common.nothing': [], 'common.noResponse': [], 'common.unobserved': [], 'common.anotherDocument': [],
  'result.passed': ['list<number>'], 'result.notApplicable': [], 'result.byWidth': ['list<message>'], 'result.atWidth': ['number', 'message'],
  'result.outcome': ['vocab:outcome'], 'result.blocked': ['list<message>'],
  'summary.atWidth': ['vocab:outcome', 'number'], 'summary.noBrowser': [], 'summary.sourceChanged': [], 'summary.servingLimit': [], 'summary.egressLimit': [], 'summary.egressChanged': [],
  'summary.egress': ['number', 'number', 'list<host>|message'],
  'capture.none': ['number'], 'capture.failedAt': ['number', 'message'], 'capture.cancelled': [], 'capture.failed': ['token'], 'capture.loadTimeout': [],
  'capture.navigationFailed': ['vocab:netError|token'], 'capture.timedOut': ['number'], 'capture.scriptThrew': ['token'], 'capture.entryUnserved': ['number|message'],
  'capture.leftEntry': ['location|message'], 'capture.leftBeforeLoad': [], 'capture.leftOrigin': ['location'],
  'worker.cancelled': [], 'worker.startFailed': ['vocab:startupFailure'], 'worker.none': [], 'worker.noExecutable': [], 'worker.headlessFailed': ['vocab:startupFailure'],
  'recovery.list': ['list<message>'], 'recovery.newRun': [], 'recovery.browserStart': [], 'recovery.browserInstall': [],
  'recovery.startup.missing-browser': [], 'recovery.startup.missing-library': [], 'recovery.startup.permission-denied': [], 'recovery.startup.profile-locked': [],
  'recovery.startup.unsupported-flag': [], 'recovery.startup.crashed': [], 'recovery.startup.timeout': [], 'recovery.startup.unknown': [],
  'recovery.sourceChanged': [], 'recovery.servingLimit': [], 'recovery.egressLimit': [], 'recovery.egressChanged': [],
  'blocker.sourceChanged': ['list<path>'], 'blocker.sourceChangedMore': ['list<path>', 'number'], 'blocker.sourceChangedFile': ['path'],
  'blocker.egressChanged': ['list<location>'], 'blocker.egressChangedFetch': ['location'],
  'serve.requestLimit': ['number'], 'serve.byteLimit': ['number', 'number'],
  'cta.label': [SEL, 'location|message'], 'cta.notProbed': ['message'], 'cta.missingPage': ['message', 'number|message'], 'cta.missingFragment': ['message'],
  'cta.noNavigation': ['message'], 'cta.missingExternal': ['message', 'number'], 'cta.externalUnchecked': ['message', 'message'], 'cta.externalNotVisited': ['message'],
  'cta.notClickProbed': [SEL], 'cta.clickError': [SEL, 'token'], 'cta.externalClick': [SEL], 'cta.noEffect': [SEL],
  'cta.probeUnmatched': [SEL], 'cta.probeRelocated': [SEL], 'cta.probeAmbiguous': [SEL],
  'cta.conversionUndeclared': ['rubricKey'], 'cta.targetMissing': ['vocab:actionType', 'rubricKey'],
  'cta.hidden': [SEL], 'cta.disabled': [SEL], 'cta.unnamed': [SEL], 'cta.smallTarget': [SEL, 'number', 'number'],
  'contrast.truncated': ['number'], 'contrast.unmeasured': [SEL], 'contrast.low': [SEL, 'token', 'number', 'number', 'vocab:textSize'], 'contrast.samples': ['number'],
  'console.errors': ['number', 'list<digest>'],
  'console.record': ['vocab:consoleKind', 'consoleRef', 'number', 'digest', 'message'],
  'console.recordRepeated': ['vocab:consoleKind', 'consoleRef', 'number', 'digest', 'message', 'number'],
  'console.source': ['location', 'number', 'number'], 'console.unknownSource': [],
  'console.brokenResource': ['location', 'number', 'vocab:resourceType|token'], 'console.fontFailed': ['token'],
  'console.blockedRefused': ['vocab:resourceType|token', 'location', 'message'], 'console.blockedDefault': ['vocab:resourceType|token', 'location'],
  'overflow.scroll': ['number', 'number'], 'overflow.layout': ['number', 'number'], 'overflow.clipped': [SEL, 'number'], 'overflow.outside': [SEL, 'number'],
  'keyboard.none': [], 'keyboard.noFocusRing': [SEL], 'keyboard.trapped': [SEL], 'keyboard.noReturn': [], 'keyboard.reached': ['number', 'number'],
  'semantics.noLang': [], 'semantics.noTitle': [], 'semantics.noH1': [], 'semantics.headingJump': ['token', 'number', 'number'], 'semantics.unnamedControl': [SEL, 'vocab:role|token'],
  'egress.fetched': ['location', 'vocab:resourceType', 'address', 'number', 'number', 'number', 'message', 'digest'],
  'egress.notFetched': ['vocab:egressOutcome', 'location', 'vocab:resourceType', 'message', 'message'],
  'egress.afterRedirects': ['number'],
  'egress.refusedProbing': [], 'egress.refusedMainFrame': [], 'egress.refusedFormSubmission': [], 'egress.refusedFrameNavigation': ['vocab:navigationReason|token|message'],
  'egress.refusedFrameQuery': [], 'egress.refusedFrameUndeclared': [], 'egress.refusedSubmission': [], 'egress.refusedPopup': [], 'egress.stillLoading': [],
  'egress.unexpected': [], 'egress.closed': [], 'egress.wentTo': [], 'egress.redirectedTo': [],
  'egress.offList': ['message', 'location'], 'egress.notHttps': ['message', 'location'], 'egress.credentials': ['message'], 'egress.portNotListed': ['message', 'number', 'host'],
  'egress.invalidUrl': [], 'egress.outsideAllowList': ['location'], 'egress.recordLimit': ['number'], 'egress.method': ['vocab:method|token'], 'egress.requestLimit': ['number'],
  'egress.resolveTimeout': ['host', 'number'], 'egress.unresolved': ['host'], 'egress.noAddress': ['host'], 'egress.privateAddress': ['host', 'address'],
  'egress.byteLimit': ['number'], 'egress.tooLarge': ['host', 'number'], 'egress.requestTimeout': ['host', 'number'], 'egress.requestFailed': ['host'],
  'egress.tooManyRedirects': ['number'], 'egress.badRedirect': ['host'],
  'behavior.summary': ['list<vocab:behavior>|message', 'list<vocab:behavior>|message'], 'behavior.record': ['vocab:behavior', 'vocab:behaviorState'],
  'behavior.recordSeen': ['vocab:behavior', 'vocab:behaviorState', 'number', 'list<number>', 'list<selector|token>'],
  'verdict.withNote': ['message', 'message'], 'verdict.note.alwaysApplies': [], 'verdict.note.declared': ['rubricKey'], 'verdict.note.pageTarget': [],
  'verdict.note.observedDespiteDeclared': ['list<vocab:behavior>', 'list<selector|token>'], 'verdict.note.absentDespiteDeclared': ['list<vocab:behavior>'],
  'verdict.note.notObserved': ['list<vocab:behavior>'], 'verdict.note.unknown': ['list<vocab:behavior>'],
  'verdict.mismatch': [], 'verdict.notApplicable': [], 'verdict.noResult': [], 'verdict.noEvidence': [], 'verdict.reads': ['rubricKey', 'message'],
  'verdict.undetermined': [], 'verdict.manualRequired': [], 'verdict.manualOptional': [], 'verdict.awaitingAcceptance': ['number'], 'verdict.judged': ['number'], 'verdict.unreviewed': ['number'],
  // B4-2b motion checks
  "motion.subject.element": [SEL],
  "motion.subject.animation": [SEL, "token"],
  "motion.subject.animationInfinite": [SEL, "token"],
  "motion.subject.list": ["list<message>"],
  "motion.subject.viewport": [],
  "motion.control": [SEL, "token"],
  "motion.label.noPreference": ["number"],
  "motion.label.reduced": ["number"],
  "motion.label.live": ["number"],
  "motion.label.beforePress": ["number"],
  "motion.label.afterPress": ["list<message>", "number"],
  "motion.phase.notObserved": ["message"],
  "motion.phase.failed": ["message", "message"],
  "motion.phase.lateRepaint": ["message", "number"],
  "motion.phase.fewSamples": ["message", "number", "number"],
  "motion.phase.pixelsUnknown": ["message"],
  "motion.phase.unmeasured": ["message", "list<message>"],
  "motion.phase.timers": ["message", "list<message>"],
  "motion.phase.watchTooShort": ["message", "number", "number"],
  "motion.phase.endedEarly": ["message", "number", "number"],
  "motion.pause.notRun": ["number"],
  "motion.pause.failed": ["number", "message"],
  "motion.pause.notButtonLike": ["list<message>", "number"],
  "motion.pause.walkCut": ["number", "number"],
  "motion.pause.unreachable": ["list<message>", "number"],
  "motion.pause.none": ["message", "number", "number"],
  "motion.pause.notMovingBefore": ["number"],
  "motion.pause.stillMoving": ["list<message>", "number", "message", "number"],
  "motion.pause.refused": ["message", "number", "number"],
  "motion.pause.stopped": ["list<message>", "number"],
  "motion.pause.untried": ["number", "number", "number"],
  "motion.pause.untriedMoving": ["number", "number", "number", "message"],
  "motion.pause.noneStopped": ["number"],
  "motion.notSampled": ["number"],
  "motion.notApplicable": ["number", "number", "number", "number", "number", "number"],
  "motion.baseMoving": ["number", "message", "number", "number", "number", "number"],
  "motion.reduced.moving": ["number", "message", "number"],
  "motion.reduced.still": ["number", "number", "number"],
  "motion.live.moving": ["number", "message"],
  "motion.live.still": ["number", "number"],
  "motion.timer.interval": [],
  "motion.timer.timeout": [],
  "motion.timer.timeoutDue": ["number"],
  "motion.timer.linked": ["message", "number", "number"],
  "motion.timer.unknown": ["message"],
  "motion.unmeasured.offscreen": ["vocab:tag|token", SEL],
  "motion.unmeasured.frame": [SEL],
  "motion.unmeasured.raf": [],
  "motion.unmeasured.workers": ["number"],
  "motion.unmeasured.timersTruncated": [],
  "motion.unmeasured.trackerMissing": [],
  "motion.unmeasured.unreadable": [],
  "motion.budgetSpent": [],
  "motion.budgetExhausted": ["message"],
  "motion.phaseError": ["token"],
  "motion.egressSummary": ["number", "number"],
  "motion.egressSummaryExhausted": ["number", "number"],
  // R03 evidence detail and visual facts
  'detail.cta.count': ['number', 'number', 'number', 'number'],
  'detail.cta.matched': ['vocab:actionType', 'rubricKey', 'number'],
  'detail.cta.action': [SEL, 'vocab:actionKind', 'number', 'number', 'message', 'message'],
  'detail.cta.inline': [],
  'detail.cta.dest': ['vocab:destinationKind', 'location|message', 'number|message'],
  'detail.cta.fragment': ['vocab:presence'],
  'detail.cta.effect': ['number', 'vocab:flag', 'vocab:flag'],
  'detail.cta.notActivated': [],
  'detail.notChecked': [],
  'detail.contrast.summary': ['number', 'number', 'number', 'number', 'number', 'number'],
  'detail.contrast.sample': [SEL, 'number', 'color', 'color', 'number', 'number', 'vocab:textSize'],
  'detail.contrast.unmeasured': ['number'],
  'detail.console.summary': ['number', 'number', 'number', 'number'],
  'detail.console.fonts': ['number', 'number', 'number'],
  'detail.overflow.metrics': ['number', 'number', 'number', 'number', 'number', 'number'],
  'detail.keyboard.walk': ['number', 'number', 'number', 'vocab:flag'],
  'detail.semantics.document': ['vocab:language|token|message', 'vocab:flag', 'number', 'number', 'list<number>|message', 'number', 'number'],
  'visual.summary': ['number', 'number'],
  'visual.palette': ['list<message>|message', 'number'],
  'visual.swatch': ['color', 'number'],
  'visual.textColors': ['list<message>|message'],
  'visual.fonts': ['list<message>|message'],
  'visual.font': ['vocab:fontFamily|token', 'number'],
  'visual.type': ['number', 'number', 'number', 'list<number>'],
  'visual.borders': ['number', 'number', 'number', 'number'],
  'visual.effects': ['number', 'number', 'number', 'number', 'number'],
  'visual.layout': ['list<message>|message'],
  'visual.box': [SEL, 'number', 'number', 'number', 'number', 'color|message'],
  'visual.transparent': [],
  'visual.page': ['number', 'number'],
} as const satisfies Record<ReviewEvidenceTemplate, readonly string[]>;
export const REVIEW_EVIDENCE_TEMPLATE_SLOTS: Readonly<Record<ReviewEvidenceTemplate, readonly string[]>> = SLOTS;

function acceptsAlternative(alternative: string, param: ReviewEvidenceParam): boolean {
  const list = /^list<(.+)>$/u.exec(alternative);
  if (list) return param.kind === 'list' && param.items.every(item => list[1]!.split(',').some(inner => acceptsAlternative(inner, item)));
  if (alternative.startsWith('vocab:')) return param.kind === 'vocab' && param.vocabulary === alternative.slice(6);
  if (alternative === 'location') return param.kind === 'location' || param.kind === 'unparseableUrl';
  return param.kind === alternative;
}
/** Whether a parameter is one a template's slot accepts. */
export function reviewEvidenceSlotAccepts(template: ReviewEvidenceTemplate, index: number, param: ReviewEvidenceParam): boolean {
  const slot = SLOTS[template][index];
  // `list<a|b>` keeps its alternatives together; top-level `|` separates the slot's alternatives.
  return slot !== undefined && splitSlot(slot).some(alternative => acceptsAlternative(alternative.replace(/\|/gu, ','), param));
}
function splitSlot(slot: string): string[] {
  const parts: string[] = []; let depth = 0; let current = '';
  for (const char of slot) {
    if (char === '<') depth++; if (char === '>') depth--;
    if (char === '|' && depth === 0) { parts.push(current); current = ''; } else current += depth > 0 && char === '|' ? '|' : char;
  }
  return [...parts, current];
}
export type ReviewEvidenceLocale = 'en';
export const REVIEW_EVIDENCE_TEMPLATE_KEYS = Object.keys(REVIEW_EVIDENCE_TEMPLATES) as [ReviewEvidenceTemplate, ...ReviewEvidenceTemplate[]];

/** How many parameters a template takes (one more than its highest `{n}`). */
export function reviewEvidenceArity(template: ReviewEvidenceTemplate): number {
  return SLOTS[template].length;
}

// ---------------------------------------------------------------------------
// Parameters and messages
// ---------------------------------------------------------------------------

const hex12 = z.string().regex(/^[0-9a-f]{12}$/u);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
/** A project-relative path the file server served (checked against the bundle's sourceHashes). */
const servedPath = z.string().min(1).max(1024).regex(/^[^/\\\p{Cc}][^\\\p{Cc}]*$/u);
const httpOrigin = /^(?:https?|wss?):\/\/[a-z0-9.-]+(?::\d{1,5})?$/u;
const MAX_LIST = 60;

export type ReviewEvidenceParam =
  | { kind: 'number'; value: number; decimals?: number }
  | { kind: 'token'; length: number; sha256: string }
  | { kind: 'selector'; parts: { tag: string; index: number | null }[] }
  | { kind: 'location'; origin: string | null; originSha256: string | null; path: string | null; pathDepth: number; pathDepthCapped: boolean; pathQuerySha256: string | null; queryLength: number; querySha256: string | null }
  | { kind: 'unparseableUrl' }
  | { kind: 'vocab'; vocabulary: ReviewEvidenceVocabulary; value: string }
  | { kind: 'host'; value: string }
  | { kind: 'address'; value: string }
  | { kind: 'digest'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'consoleRef'; value: string }
  | { kind: 'rubricKey'; value: string }
  /** R03 visual facts: an sRGB colour the daemon measured, as `#rrggbb`. */
  | { kind: 'color'; value: string }
  | { kind: 'list'; items: ReviewEvidenceParam[] }
  | { kind: 'message'; template: ReviewEvidenceTemplate; params: ReviewEvidenceParam[] };
export interface ReviewEvidenceMessage { template: ReviewEvidenceTemplate; params: ReviewEvidenceParam[] }

const selectorPart = z.object({ tag: z.string().min(1).max(40), index: z.number().int().min(1).max(9999).nullable() }).strict().superRefine((value, ctx) => {
  if (value.tag === '*' ? value.index === null : !REVIEW_TAG_NAMES.includes(value.tag)) ctx.addIssue({ code: 'custom', message: 'A selector part is a known tag, or * with a position' });
});
const locationParam = z.object({
  kind: z.literal('location'),
  origin: z.string().max(300).nullable(), originSha256: hex64.nullable(), path: z.string().min(1).max(1024).nullable(),
  pathDepth: z.number().int().min(0).max(200), pathDepthCapped: z.boolean(),
  pathQuerySha256: hex64.nullable(), queryLength: z.number().int().min(0).max(1_000_000), querySha256: hex64.nullable(),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((value.origin === null) === (value.originSha256 === null)) fail('A location keeps its origin or its digest, not both');
  if (value.origin !== null && !(REVIEW_URL_SCHEMES as readonly string[]).includes(value.origin) && !httpOrigin.test(value.origin)) fail('A location origin is a known scheme or a host origin');
  if (value.path !== null && (!value.path.startsWith('/') || /[\s?#\p{Cc}]/u.test(value.path))) fail('A location path is a plain served path');
  if (value.path !== null && value.pathQuerySha256 !== null) fail('A location keeps its served path or a digest, not both');
  if (value.querySha256 !== null && value.path === null) fail('Only a served path keeps a query digest');
});

const leafParam = z.union([
  z.object({ kind: z.literal('number'), value: z.number().finite(), decimals: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal('token'), length: z.number().int().min(0), sha256: hex12 }).strict(),
  z.object({ kind: z.literal('selector'), parts: z.array(selectorPart).min(1).max(40) }).strict().superRefine((value, ctx) => {
    if (value.parts[0]!.tag !== 'body' || value.parts[0]!.index !== null) ctx.addIssue({ code: 'custom', message: 'A selector starts at body' });
  }),
  locationParam,
  z.object({ kind: z.literal('unparseableUrl') }).strict(),
  z.object({ kind: z.literal('vocab'), vocabulary: z.enum(Object.keys(REVIEW_EVIDENCE_VOCABULARIES) as [ReviewEvidenceVocabulary, ...ReviewEvidenceVocabulary[]]), value: z.string().max(80) }).strict().superRefine((value, ctx) => {
    if (!(REVIEW_EVIDENCE_VOCABULARIES[value.vocabulary] as readonly string[]).includes(value.value)) ctx.addIssue({ code: 'custom', message: `Not in the ${value.vocabulary} vocabulary` });
  }),
  z.object({ kind: z.literal('host'), value: z.string().regex(/^[a-z0-9.-]{1,253}$/u) }).strict(),
  z.object({ kind: z.literal('address'), value: z.string().ip() }).strict(),
  z.object({ kind: z.literal('digest'), value: z.string().regex(/^[0-9a-f]{12,64}$/u) }).strict(),
  z.object({ kind: z.literal('path'), value: servedPath }).strict(),
  z.object({ kind: z.literal('consoleRef'), value: z.string().regex(/^console-[0-9a-f]{12}$/u) }).strict(),
  /** A key from the user's own rubric or design context (never page text). */
  z.object({ kind: z.literal('rubricKey'), value: z.string().min(1).max(300).regex(/^[^\p{Cc}<>]+$/u) }).strict(),
  z.object({ kind: z.literal('color'), value: z.string().regex(/^#[0-9a-f]{6}$/u) }).strict(),
]);

const arityCheck = (value: { template: ReviewEvidenceTemplate; params: ReviewEvidenceParam[] }, ctx: z.RefinementCtx) => {
  const arity = reviewEvidenceArity(value.template);
  if (value.params.length !== arity) { ctx.addIssue({ code: 'custom', path: ['params'], message: `${value.template} takes ${arity} parameters` }); return; }
  value.params.forEach((param, index) => {
    if (!reviewEvidenceSlotAccepts(value.template, index, param)) ctx.addIssue({ code: 'custom', path: ['params', index], message: `${value.template} does not take a ${param.kind} parameter here` });
  });
};
const templateKey = z.enum(REVIEW_EVIDENCE_TEMPLATE_KEYS);

export const reviewEvidenceParamSchema: z.ZodType<ReviewEvidenceParam> = z.lazy(() => z.union([
  leafParam,
  z.object({ kind: z.literal('list'), items: z.array(reviewEvidenceParamSchema).max(MAX_LIST) }).strict(),
  z.object({ kind: z.literal('message'), template: templateKey, params: z.array(reviewEvidenceParamSchema).max(12) }).strict().superRefine(arityCheck),
])) as z.ZodType<ReviewEvidenceParam>;

/** A stored mechanical message: a template key and its typed parameters. */
export const reviewEvidenceMessageSchema: z.ZodType<ReviewEvidenceMessage> = z.object({
  template: templateKey,
  params: z.array(reviewEvidenceParamSchema).max(12),
}).strict().superRefine(arityCheck) as z.ZodType<ReviewEvidenceMessage>;

export const isReviewEvidenceMessage = (value: unknown): value is ReviewEvidenceMessage =>
  typeof value === 'object' && value !== null && 'template' in value && 'params' in value;

/** Every parameter in a message, nested messages and lists included (depth-first). */
export function reviewEvidenceParams(message: ReviewEvidenceMessage): ReviewEvidenceParam[] {
  const out: ReviewEvidenceParam[] = [];
  const visit = (param: ReviewEvidenceParam) => {
    out.push(param);
    if (param.kind === 'list') param.items.forEach(visit);
    if (param.kind === 'message') param.params.forEach(visit);
  };
  message.params.forEach(visit);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering (en): the only way stored evidence becomes text
// ---------------------------------------------------------------------------

const TOKEN_TEXT: Record<ReviewEvidenceLocale, (length: number, sha: string) => string> = {
  en: (length, sha) => `<page text: ${length} chars, sha256 ${sha}>`,

};
const UNPARSEABLE_URL: Record<ReviewEvidenceLocale, string> = { en: '~unparseable-url' };

/** A reduced location in its fixed text form (`origin/~redacted:dN:sha12:qN`). */
export function describeReviewLocation(location: Extract<ReviewEvidenceParam, { kind: 'location' }>): string {
  const origin = location.origin ?? `~origin:${location.originSha256!.slice(0, 12)}`;
  if (location.origin !== null && !location.origin.includes('//')) return `${location.origin}~redacted`;
  if (location.origin === null && location.pathQuerySha256 === null) return `${origin}:~redacted`;
  if (location.path !== null) return `${origin}${location.path}${location.querySha256 ? `?~q${location.queryLength}:${location.querySha256.slice(0, 12)}` : ''}`;
  return `${origin}/~redacted:d${location.pathDepth}${location.pathDepthCapped ? '+' : ''}:${location.pathQuerySha256!.slice(0, 12)}${location.queryLength ? `:q${location.queryLength}` : ''}`;
}

export function describeReviewSelector(parts: { tag: string; index: number | null }[]): string {
  return parts.map(part => part.tag === '*' ? `*:nth-child(${part.index})` : part.index === null ? part.tag : `${part.tag}:nth-of-type(${part.index})`).join(' > ');
}

export function renderReviewEvidenceParam(param: ReviewEvidenceParam, locale: ReviewEvidenceLocale = 'en'): string {
  switch (param.kind) {
    case 'number': return param.decimals === undefined ? String(param.value) : param.value.toFixed(param.decimals);
    case 'token': return TOKEN_TEXT[locale](param.length, param.sha256);
    case 'selector': return describeReviewSelector(param.parts);
    case 'location': return describeReviewLocation(param);
    case 'unparseableUrl': return UNPARSEABLE_URL[locale];
    case 'vocab': case 'host': case 'address': case 'digest': case 'path': case 'consoleRef': case 'rubricKey': case 'color': return param.value;
    case 'list': {
      const separator = param.items.some(item => item.kind === 'message') ? '; ' : ', ';
      return param.items.map(item => renderReviewEvidenceParam(item, locale)).join(separator);
    }
    case 'message': return renderReviewEvidenceMessage(param, locale);
  }
}

export function renderReviewEvidenceMessage(message: ReviewEvidenceMessage, locale: ReviewEvidenceLocale = 'en'): string {
  const pattern: string = REVIEW_EVIDENCE_TEMPLATES[message.template][locale];
  return pattern.replace(/\{(\d+)\}/gu, (_, index: string) => {
    const param = message.params[Number(index)];
    return param ? renderReviewEvidenceParam(param, locale) : '';
  });
}

/** Renders a stored text field: a message from the table, or (legacy bundles only) the string as served. */
export function renderReviewEvidenceText(value: ReviewEvidenceMessage | string, locale: ReviewEvidenceLocale = 'en'): string {
  return typeof value === 'string' ? value : renderReviewEvidenceMessage(value, locale);
}
