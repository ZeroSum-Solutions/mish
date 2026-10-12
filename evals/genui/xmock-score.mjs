// Scoring for the C10 x-mock eval (7-xmock-eval.mjs), kept apart from the runner so it can be
// tested without a daemon: per-kind totals, the pass rule, the caption evidence for x-mock slots,
// and the offline re-score of a saved bake-off row.
//
// The criterion (second-model ruling, 2026-09-24), per application page kind:
//   1. every build reached a terminal `done` (live: 10 of 10);
//   2. the flagged fact-slot rate (sum flagged / sum checked) is below 5 %;
//   3. no x-mock path was ever flagged (an exclusion bug);
//   4. zero unlabelled fabricated claims: no row lists a flagged fact slot or a remaining one, no
//      build ended VERIFY_FAILED (a strict build the gate caught fabricating), and every x-mock
//      slot the published recipe carries sits under a visible caption in the published HTML.
//      Live, EVERY done build must carry that evidence (`evidence: 'present'`), whatever its
//      self-reported `illustrative` count; a build whose recipe or page could not be read, or
//      whose page lacks a section, is `evidence: 'missing'` and fails its kind.
// A run passes only when all three kinds are present and pass. A live run passes only in
// `strict` verify mode: `after` publishes before the gate runs, so it can never prove C10.

import { collectFaithfulnessSlots } from '../../packages/agency-fast-lane/src/jev.ts';
import { editableTemplate, mockPathsFor } from '../../packages/agency-fast-lane/src/spine.ts';

export const KINDS = ['marketing-site', 'app-shell', 'crm-dashboard'];
/** The bake-off's short kind names, mapped onto family ids. */
export const KIND_ALIASES = { site: 'marketing-site', app: 'app-shell', dashboard: 'crm-dashboard' };
export const RATE_LIMIT = 0.05;
/** Live: every one of the ten briefs per kind must reach `done`. */
export const REQUIRED_BUILDS = 10;
export const VERIFY_MODES = ['strict', 'after'];
export const DEFAULT_VERIFY_MODE = 'strict';

/**
 * Why a live done row's caption evidence does not hold, or null when it does. Evidence is
 * required for every done row: `evidence: 'present'` with a `mockCaptions` object, and the gate
 * cannot have skipped more x-mock slots than the published recipe carries (`mockSlots`).
 */
export function evidenceProblem(row) {
  if (row.evidence !== 'present' || row.mockCaptions === undefined || row.mockCaptions === null) {
    return row.evidenceError ?? 'no caption evidence recorded';
  }
  if (typeof row.mockSlots !== 'number') return 'no x-mock slot count recorded';
  if ((row.illustrative ?? 0) > row.mockSlots) return `gate skipped ${row.illustrative} x-mock slots, the published recipe carries ${row.mockSlots}`;
  return null;
}

/** The unlabelled fabricated claims one row carries: flagged fact slots, fact slots still flagged
 * after repair, and x-mock slots the gate skipped that the page does not caption. */
function unlabelledIn(row) {
  return (row.flaggedSlots?.length ?? 0) + (row.remaining ?? 0) + (row.uncaptionedMock?.length ?? 0);
}

/**
 * One kind's totals from its per-build rows. `flaggedSlots` lists every flagged NON-mock slot
 * (path, text when known, and whether it repeats a brief claim); `unlabelledClaimCandidates` is the
 * count of those that do not repeat a brief claim. `mockViolations` lists flagged x-mock paths: the
 * gate should never see them, so any entry is an exclusion bug (it fails the run, not the rate).
 *
 * `flagged` (the rate's numerator) is the gate's first-pass flag count: a row's `flaggedCount` (the
 * `verify` event's `counts.flagged`) when reported, else its `flaggedSlots` length. In strict mode a
 * build repairs what the gate flags, so the first-pass count is what measures the gate.
 *
 * `failures` names every reason the kind fails, so a report never shows a bare NO.
 */
export function summarize(rows, { live }) {
  const ok = rows.filter((row) => row.ok);
  const checked = ok.reduce((sum, row) => sum + (row.checked ?? 0), 0);
  const illustrative = ok.reduce((sum, row) => sum + (row.illustrative ?? 0), 0);
  const flaggedSlots = ok.flatMap((row) => row.flaggedSlots ?? []);
  const flagged = ok.reduce((sum, row) => sum + (typeof row.flaggedCount === 'number' ? row.flaggedCount : (row.flaggedSlots?.length ?? 0)), 0);
  const rate = checked > 0 ? flagged / checked : null;
  const mockViolations = ok.flatMap((row) => row.mockViolations ?? []);
  const verifyFailed = rows.filter((row) => row.errorCode === 'VERIFY_FAILED').map((row) => row.brief ?? null);
  // Fact slots still flagged after repair: on published (done) builds, and on builds the gate
  // stopped (VERIFY_FAILED), counted apart so the report states both.
  const remaining = ok.reduce((sum, row) => sum + (row.remaining ?? 0), 0);
  const remainingInVerifyFailed = rows.filter((row) => row.errorCode === 'VERIFY_FAILED').reduce((sum, row) => sum + (row.remaining ?? 0), 0);
  const uncaptionedMock = ok.flatMap((row) => (row.uncaptionedMock ?? []).map((p) => ({ brief: row.brief ?? null, path: p })));
  // Live, every done build must show where the page captions its x-mock slots. Never gated on the
  // self-reported `illustrative` count: a missing or zeroed count must not waive the evidence.
  const missingCaptionEvidence = live
    ? ok.flatMap((row) => {
      const problem = evidenceProblem(row);
      return problem ? [{ brief: row.brief ?? null, problem }] : [];
    })
    : [];
  const unlabelledClaims = ok.reduce((sum, row) => sum + unlabelledIn(row), 0);
  // Live: exactly ten rows, all done. An extra row (a retry appended) is not 10 of 10.
  const allDone = live ? rows.length === REQUIRED_BUILDS && ok.length === REQUIRED_BUILDS : ok.length > 0;
  const noUnlabelledClaims = unlabelledClaims === 0 && verifyFailed.length === 0 && missingCaptionEvidence.length === 0;
  const rateOk = rate !== null && rate < RATE_LIMIT;

  const failures = [];
  if (!allDone) failures.push(live ? `${ok.length} of ${rows.length} rows done (need exactly ${REQUIRED_BUILDS} of ${REQUIRED_BUILDS})` : 'no scorable build');
  if (!rateOk) failures.push(rate === null ? 'no fact slots checked' : `flagged rate ${(rate * 100).toFixed(2)} % is not below ${RATE_LIMIT * 100} %`);
  if (verifyFailed.length > 0) failures.push(`${verifyFailed.length} build(s) VERIFY_FAILED (caught fabrication; ${remainingInVerifyFailed} fact slot(s) left flagged after repair)`);
  if (flaggedSlots.length > 0) failures.push(`${flaggedSlots.length} flagged fact slot(s) published`);
  if (remaining > 0) failures.push(`${remaining} fact slot(s) still flagged after repair on published builds`);
  if (uncaptionedMock.length > 0) failures.push(`${uncaptionedMock.length} x-mock slot(s) skipped without a visible caption`);
  if (missingCaptionEvidence.length > 0) failures.push(`${missingCaptionEvidence.length} build(s) with missing caption evidence: ${missingCaptionEvidence.map((m) => `${m.brief ?? '?'} (${m.problem})`).join(', ')}`);
  if (mockViolations.length > 0) failures.push(`${mockViolations.length} x-mock path(s) flagged (exclusion bug)`);

  return {
    builds: rows.length,
    ok: ok.length,
    checked,
    illustrative,
    flagged,
    rate,
    allDone,
    unlabelledClaims,
    noUnlabelledClaims,
    verifyFailed: verifyFailed.length,
    remaining,
    remainingInVerifyFailed,
    pass: rateOk && allDone && noUnlabelledClaims && mockViolations.length === 0,
    failures,
    ...(mockViolations.length > 0 ? { mockViolations } : {}),
    ...(uncaptionedMock.length > 0 ? { uncaptionedMock } : {}),
    ...(missingCaptionEvidence.length > 0 ? { missingCaptionEvidence } : {}),
    ...(verifyFailed.length > 0 ? { verifyFailedBriefs: verifyFailed } : {}),
    unlabelledClaimCandidates: flaggedSlots.filter((slot) => slot.repeatsBriefClaim !== true).length,
    flaggedPaths: [...new Set(flaggedSlots.map((slot) => slot.path))].sort(),
    flaggedSlots,
  };
}

/**
 * One live build's outcome from what the daemon reported: the terminal `status` snapshot, the
 * `counts` of the `verify` build event (`{ checked, illustrative, flagged, repaired, remaining }`),
 * and, for `verify: 'after'` only, the settled deferred verdict (`GET /api/agency/builds/:id` once
 * it leaves `pending`).
 *
 * - `strict`: `ok` needs a `done` build with verify counts and nothing remaining. A build the gate
 *   stopped ends `failed` with `VERIFY_FAILED`; it is recorded as `errorCode` so the scorer counts
 *   it as a caught fabrication.
 * - `after`: `ok` needs a `done` build, a `done` verdict and verify counts.
 */
export function liveBuildOutcome({ snapshot, verify, counts, verifyMode = DEFAULT_VERIFY_MODE }) {
  const hasCounts = typeof counts?.checked === 'number';
  const done = snapshot?.status === 'done';
  const ok = verifyMode === 'after'
    ? done && verify?.status === 'done' && hasCounts
    : done && hasCounts && (counts.remaining ?? 0) === 0;
  const errorCode = snapshot?.error?.code;
  const describe = () => {
    if (snapshot?.error?.message) return snapshot.error.message;
    const parts = [`status ${snapshot?.status ?? 'missing'}`];
    if (verifyMode === 'after') parts.push(`verify ${verify?.status ?? 'missing'}`);
    if (!hasCounts) parts.push('no verify counts');
    else if ((counts.remaining ?? 0) > 0) parts.push(`${counts.remaining} remaining`);
    return parts.join(', ');
  };
  return {
    ok,
    checked: counts?.checked ?? 0,
    illustrative: counts?.illustrative ?? 0,
    ...(typeof counts?.flagged === 'number' ? { flaggedCount: counts.flagged } : {}),
    ...(typeof counts?.remaining === 'number' ? { remaining: counts.remaining } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(ok ? {} : { error: describe() }),
  };
}

/** Per-kind summaries for every kind in KINDS (a kind with no rows is present, with 0 builds). */
export function summarizeKinds(rows, { live }) {
  const kinds = {};
  for (const kind of KINDS) kinds[kind] = summarize(rows.filter((row) => row.kind === kind), { live });
  return kinds;
}

/**
 * The run's verdict: all three kinds present and passing, and no x-mock path ever flagged. A live
 * run passes only in `strict` verify mode; pass `verifyMode` for a live run.
 */
export function overallPass(kinds, { verifyMode } = {}) {
  if (verifyMode !== undefined && verifyMode !== 'strict') return false;
  return KINDS.every((kind) => kinds[kind] && kinds[kind].builds > 0 && kinds[kind].pass)
    && Object.values(kinds).every((k) => !k.mockViolations);
}

// ---------------------------------------------------------------------------
// Caption evidence for x-mock slots
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The HTML of the element whose `id` is `id`, open tag to matching close tag, or null. The id may
 * be double- or single-quoted, after any whitespace. A plain balanced scan over one tag name: the
 * family renderers write simple static markup. Null (no such element, or it never closes) is
 * missing evidence to the caller, never "captioned".
 */
export function elementById(html, id) {
  const quoted = escapeRegExp(id);
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*?\\sid\\s*=\\s*(?:"${quoted}"|'${quoted}')[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index + m[0].length);
  }
  return null;
}

/** The first non-empty visible caption (`data-od-mock="caption"`) inside `html`, or null. */
export function captionIn(html) {
  const re = /<[^>]*\sdata-od-mock\s*=\s*(?:"caption"|'caption')[^>]*>([^<]*)</g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

/**
 * Where the published page captions the x-mock slots the recipe carries. A slot's section is the
 * recipe's `sections[N]`, found in the HTML by its `id`; the slot is captioned only when that
 * section's element holds a non-empty `data-od-mock="caption"`. A slot outside `sections[N]` has
 * no section to caption it and counts as uncaptioned.
 *
 * Returns the row fields the scorer reads: always `evidence` (`'present'` or `'missing'`) and
 * `mockSlots`; with `'present'`, `mockCaptions: { [sectionId]: caption | null }` and
 * `uncaptionedMock: path[]`; with `'missing'`, `evidenceError`. Missing means the recipe or page
 * is absent, or a section that holds x-mock slots is not in the page.
 */
export function captionEvidence(recipe, html, mockPaths) {
  const mockSlots = mockPaths?.size ?? 0;
  if (!recipe || typeof recipe !== 'object') return { evidence: 'missing', evidenceError: 'published recipe not read', mockSlots };
  if (typeof html !== 'string' || html.length === 0) return { evidence: 'missing', evidenceError: 'published page not read', mockSlots };
  const mockCaptions = {};
  const uncaptionedMock = [];
  const missingSections = [];
  for (const p of [...mockPaths].sort()) {
    const index = /^sections\[(\d+)\]/.exec(p)?.[1];
    const sectionId = index === undefined ? undefined : recipe.sections?.[Number(index)]?.id;
    if (typeof sectionId !== 'string') {
      uncaptionedMock.push(p);
      continue;
    }
    if (!(sectionId in mockCaptions)) {
      const element = elementById(html, sectionId);
      if (element === null) missingSections.push(sectionId);
      mockCaptions[sectionId] = element ? captionIn(element) : null;
    }
    if (mockCaptions[sectionId] === null) uncaptionedMock.push(p);
  }
  if (missingSections.length > 0) {
    return { evidence: 'missing', evidenceError: `section(s) not found in the published page: ${missingSections.join(', ')}`, mockSlots, mockCaptions, uncaptionedMock };
  }
  return { evidence: 'present', mockSlots, mockCaptions, uncaptionedMock };
}

/**
 * The published page's entry and state revision, read from the build's own record
 * (`AGENCY-SITE-STATE.md`, written by the fast lane's `publishFinalState`: "- Entry: `<file>`"
 * and "- Family: <id>, revision <n>"), so the eval never hardcodes the daemon's revision.
 * Null when the note does not state both.
 */
export function publishedEntry(stateNote) {
  if (typeof stateNote !== 'string') return null;
  const entry = /^- Entry: `([^`]+)`/m.exec(stateNote)?.[1];
  const revision = /^- Family: [^,\n]+, revision (\d+)/m.exec(stateNote)?.[1];
  if (!entry || !revision) return null;
  return { entry, revision: Number(revision) };
}

// ---------------------------------------------------------------------------
// Offline re-score of saved bake-off rows
// ---------------------------------------------------------------------------

/**
 * Family facts the re-score needs, from the family package: its schema, its recipe's x-mock
 * paths, and its recipe's text-slot count. `loadFamily(kind)` returns `{ schema, fixture }`.
 */
export function familyFacts(loadFamily) {
  const cache = new Map();
  return (kind) => {
    if (!cache.has(kind)) {
      const { schema, fixture } = loadFamily(kind);
      cache.set(kind, {
        schema,
        fixtureMock: mockPathsFor(schema, editableTemplate(fixture) ?? {}),
        fixtureSlots: collectFaithfulnessSlots(fixture).length,
      });
    }
    return cache.get(kind);
  };
}

/** The x-mock text paths a recipe actually carries (a nulled group has none). */
export function recipeMockPaths(schema, recipe) {
  const slots = new Set(collectFaithfulnessSlots(recipe).map((slot) => slot.path));
  return new Set([...mockPathsFor(schema, editableTemplate(recipe) ?? {})].filter((p) => slots.has(p)));
}

/**
 * Re-scores one saved row. The illustrative count is never invented; it comes, in order, from:
 *   1. the row's own `verifyEventCounts.illustrative` (a report from this branch: `checked` is
 *      already fact slots only);
 *   2. the row's saved `recipe`, walked with the family schema;
 *   3. the package recipe, but ONLY when the row proves it checked exactly that recipe's slots
 *      (`checked` equals the package recipe's text-slot count and nothing was nulled) — then every
 *      x-mock slot was present and checked.
 * Otherwise the row is not scorable: `ok: false` with the reason, and it counts as a missing build.
 */
export function rescoreRow(saved, facts) {
  const kind = KIND_ALIASES[saved.kind] ?? saved.family ?? saved.kind;
  const brief = saved.brief ?? saved.n;
  const model = saved.provider && saved.model ? `${saved.provider}/${saved.model}` : saved.model;
  const base = { kind, brief, model };
  if (!KINDS.includes(kind)) return { ...base, ok: false, error: `unknown kind ${saved.kind}`, checked: 0, illustrative: 0, flaggedSlots: [], excludedAsMock: 0 };
  const fam = facts(kind);
  const flaggedAll = saved.verify?.flagged ?? [];
  const counts = saved.verifyEventCounts ?? {};
  const finished = saved.ok === true && saved.verify?.status === 'done';

  let mock;
  let checked;
  let illustrative;
  let illustrativeSource;
  if (typeof counts.illustrative === 'number' && typeof counts.checked === 'number') {
    mock = saved.recipe ? recipeMockPaths(fam.schema, saved.recipe) : fam.fixtureMock;
    checked = counts.checked;
    illustrative = counts.illustrative;
    illustrativeSource = 'report';
  } else if (saved.recipe && typeof counts.checked === 'number') {
    mock = recipeMockPaths(fam.schema, saved.recipe);
    illustrative = mock.size;
    checked = counts.checked - illustrative;
    illustrativeSource = 'recipe';
  } else if (counts.checked === fam.fixtureSlots && (saved.summary?.nulled ?? 0) === 0) {
    mock = fam.fixtureMock;
    illustrative = mock.size;
    checked = counts.checked - illustrative;
    illustrativeSource = 'package-recipe-verified';
  } else {
    return {
      ...base,
      ok: false,
      error: `illustrative count not derivable: checked ${counts.checked ?? 'missing'} vs package recipe ${fam.fixtureSlots}, nulled ${saved.summary?.nulled ?? 'unknown'}, no recipe saved`,
      checked: 0,
      illustrative: 0,
      flaggedSlots: [],
      excludedAsMock: 0,
    };
  }
  const flaggedMock = flaggedAll.filter((p) => mock.has(p));
  return {
    ...base,
    ok: finished && checked >= 0,
    checked: Math.max(0, checked),
    illustrative,
    illustrativeSource,
    flaggedSlots: flaggedAll.filter((p) => !mock.has(p)).map((p) => ({ brief, path: p, text: null })),
    // A report from before x-mock checked mock slots, so a flag there is expected and removed. A
    // report that already excludes them (`report`) must never flag one: that is an exclusion bug.
    excludedAsMock: illustrativeSource === 'report' ? 0 : flaggedMock.length,
    ...(illustrativeSource === 'report' && flaggedMock.length > 0 ? { mockViolations: flaggedMock } : {}),
  };
}
