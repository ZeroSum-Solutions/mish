// The display half of an agency fast-lane build: its status line, the route → fill → verify →
// publish timeline, the progress lines, the applied effects and the outcome with "Open project".
//
// Shared by the Design index Route panel (`DesignIndexView`'s `BuildPanel`, which adds the run
// controls, the deferred verdict and repair) and Home's "Build with Jev" mode (`HomeJevBuild`),
// so both surfaces read a build the same way. Every line is built from the event's own fields and
// this locale's words — never from the daemon's English `message` or anything the model wrote.

import type { ReactNode } from 'react';
import type {
  AgencyBuildAguiState,
  AgencyBuildAguiStepName,
  AgencyBuildErrorCode,
  AgencyBuildEvent,
  AgencyBuildFailureReason,
  AgencyBuildSnapshot,
  AgencyBuildStatus,
  AgencyEffectSkipReason,
  AgencyEffectsResult,
} from '@mish/contracts';

import type { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { AGENCY_BUILD_TERMINAL, type AgencyBuildStepStatus } from '../lib/agency-build-agui';
import { AgencyCompositionSummary } from './AgencyCompositionSummary';
import styles from './AgencyBuildProgress.module.css';

type Translate = ReturnType<typeof useT>;

/**
 * Both Jev-backed endpoints answer 503 when the daemon cannot resolve the
 * TypeSafe key and 502 when the upstream call fails, and neither echoes the
 * upstream body. The caller passes the message for its own 502 because
 * "could not profile" and "could not route" are different failures.
 *
 * `jevUnavailable` is the structured signal for "a Settings trip could fix
 * this" — never derive it by comparing the localized `message` text.
 */
export interface JevFailure {
  message: string;
  jevUnavailable: boolean;
}

/**
 * The Profile and Route panels' error line. One component so the two cannot
 * drift: a missing Jev key (503) gets a button straight to the Settings
 * section that holds it (`media`, where `JevKeyCard` renders); any other
 * failure is text only. No `onOpenSettings` means no button, never an inert
 * one.
 */
export function JevErrorNotice({
  error,
  onOpenSettings,
  testId,
  t,
}: {
  error: JevFailure;
  onOpenSettings?: (section: 'media') => void;
  testId: string;
  t: Translate;
}) {
  return (
    <p className={styles.error} role="alert">
      {error.message}
      {error.jevUnavailable && onOpenSettings ? (
        <button
          type="button"
          className={`${styles.secondary} ${styles.errorAction}`}
          onClick={() => onOpenSettings('media')}
          data-testid={testId}
        >
          {t('designIndex.error.openSettings')}
        </button>
      ) : null}
    </p>
  );
}

/** The four statuses a build ends on (`AGENCY_BUILD_TERMINAL`). Anything else means it is still running. */
export const BUILD_TERMINAL: readonly AgencyBuildStatus[] = AGENCY_BUILD_TERMINAL;

export const BUILD_STATUS_KEY = {
  queued: 'designIndex.build.status.queued',
  routing: 'designIndex.build.status.routing',
  building: 'designIndex.build.status.building',
  verifying: 'designIndex.build.status.verifying',
  publishing: 'designIndex.build.status.publishing',
  done: 'designIndex.build.status.done',
  unrouted: 'designIndex.build.status.unrouted',
  cancelled: 'designIndex.build.status.cancelled',
  failed: 'designIndex.build.status.failed',
} as const;

/**
 * `AgencyBuildFailure.reason` as an i18n key per code: a repair reason, `deadline` or `transport`.
 * `failureReasonKey` below reads this map and falls back to
 * `designIndex.build.failure.reason.unknown` for a code this build predates — never the raw string.
 */
const BUILD_FAILURE_REASON_KEY: Record<AgencyBuildFailureReason, keyof Dict> = {
  invalid: 'designIndex.build.failure.reason.invalid',
  incomplete: 'designIndex.build.failure.reason.incomplete',
  malformed: 'designIndex.build.failure.reason.malformed',
  unfaithful: 'designIndex.build.failure.reason.unfaithful',
  deadline: 'designIndex.build.failure.reason.deadline',
  transport: 'designIndex.build.failure.reason.transport',
};

/** `failure.reason`'s i18n key, or the generic fallback for a reason code this build predates. */
export function failureReasonKey(reason: string): keyof Dict {
  return (BUILD_FAILURE_REASON_KEY as Record<string, keyof Dict>)[reason] ?? 'designIndex.build.failure.reason.unknown';
}

/** The Build panel's step timeline: each step's name, and what its STEP events said. */
export const BUILD_STEP_KEY: Record<Exclude<AgencyBuildAguiStepName, 'deploy'>, keyof Dict> = {
  route: 'designIndex.build.step.route',
  fill: 'designIndex.build.step.fill',
  verify: 'designIndex.build.step.verify',
  publish: 'designIndex.build.step.publish',
};

export const BUILD_STEP_STATUS_KEY: Record<AgencyBuildStepStatus, keyof Dict> = {
  pending: 'designIndex.build.stepStatus.pending',
  active: 'designIndex.build.stepStatus.active',
  done: 'designIndex.build.stepStatus.done',
  failed: 'designIndex.build.stepStatus.failed',
};

/**
 * The sentence for each way a build can end badly.
 *
 * The daemon's five codes all used to collapse into "The build failed.", which cannot tell a
 * faithfulness failure — the ordinary, expected outcome of a strict build — from a model outage or
 * a project left behind. Two of the five already had the right sentence elsewhere and are reused
 * rather than translated twice: `JEV_UNAVAILABLE` is the same condition the Route panel's 503
 * reports, and `BUILD_FAILED` is the generic failure this map exists to be more specific than.
 *
 * A code this map does not know falls back to the generic sentence, so a code added to the daemon
 * reads as a plain failure until somebody writes the wording for it.
 */
export const BUILD_ERROR_KEY: Record<AgencyBuildErrorCode, keyof Dict> = {
  VERIFY_FAILED: 'designIndex.build.error.verifyFailed',
  RENDER_QUALITY_FAILED: 'designIndex.build.error.renderQualityFailed',
  MODEL_UNAVAILABLE: 'designIndex.build.error.modelUnavailable',
  ROLLBACK_FAILED: 'designIndex.build.error.rollbackFailed',
  JEV_UNAVAILABLE: 'designIndex.error.jevUnavailable',
  BUILD_FAILED: 'designIndex.build.status.failed',
};

/** What a finished build says about itself: the specific failure when there is one. */
export function buildOutcomeKey(build: AgencyBuildSnapshot): keyof Dict {
  const code = build.error?.code;
  // `Object.hasOwn`, not `in`: a code that happens to spell a prototype member (`toString`,
  // `constructor`) would otherwise pass the check and resolve to something that is not a key.
  if (code && Object.hasOwn(BUILD_ERROR_KEY, code)) return BUILD_ERROR_KEY[code];
  if (code) return 'designIndex.build.status.failed';
  return BUILD_STATUS_KEY[build.status];
}

/**
 * One progress line.
 *
 * Built from the event's own fields and this locale's words — never from the daemon's `message`,
 * which is English whatever the screen is in, and never from anything the model wrote. `merged`
 * has no line: the paint that follows it is what a person can actually see.
 */
/**
 * "Filled by deepseek (5 sections) and cerebras (2 sections)" — only when more than one provider
 * contributed output (a failover midway through a `sections` build). Null otherwise: a build on
 * one provider says nothing extra.
 */
export function buildProvidersLine(build: AgencyBuildSnapshot | null, t: Translate): string | null {
  const uses = build?.providers ?? [];
  if (uses.length < 2) return null;
  const entries = uses.map((use) => {
    const count = use.sections?.length ?? 0;
    if (count === 0) return use.provider;
    return count === 1
      ? t('designIndex.build.providers.entryOne', { provider: use.provider })
      : t('designIndex.build.providers.entry', { provider: use.provider, count });
  });
  const last = entries.pop()!;
  return t('designIndex.build.providers', { first: entries.join(', '), last });
}

export function buildEventLine(event: AgencyBuildEvent, t: Translate): string | null {
  switch (event.type) {
    case 'route':
      return event.decision === 'routed'
        ? t('designIndex.build.event.route', { family: event.family ?? '' })
        : t('designIndex.build.event.unrouted');
    case 'project': return t('designIndex.build.event.project');
    case 'lock-wait': return t('designIndex.build.event.lockWait');
    // The section decision has its own line, read from the stream's state: see `buildSectionsText`.
    case 'sections': return null;
    case 'effects': {
      // The daemon's label is the fixed `"<applied> applied, <skipped> skipped"`; only its two
      // numbers are read, so the line is this locale's words, never the daemon's English.
      const counts = /^(\d+) applied, (\d+) skipped$/.exec(event.label ?? '');
      return counts
        ? t('designIndex.build.event.effects', { applied: Number(counts[1]), skipped: Number(counts[2]) })
        : t('designIndex.build.event.effectsSettled');
    }
    case 'assets': return t('designIndex.build.event.assets', { count: event.count ?? 0 });
    case 'first-token': return t('designIndex.build.event.firstToken');
    case 'unit': return t('designIndex.build.event.unit', { label: event.label ?? '' });
    case 'paint': return t('designIndex.build.event.paint', { count: event.count ?? 0 });
    case 'repair': return t('designIndex.build.event.repair', { label: event.label ?? '' });
    case 'clipped': return t('designIndex.build.event.clipped', { label: event.label ?? '' });
    case 'verify':
      return t('designIndex.build.event.verify', {
        checked: event.counts?.checked ?? 0,
        remaining: event.counts?.remaining ?? 0,
      });
    case 'registered': return t('designIndex.build.event.registered');
    case 'preview': return t('designIndex.build.event.preview', { ms: event.ms ?? 0 });
    case 'failover': return t('designIndex.build.event.failover', { provider: event.label ?? '' });
    default: return null;
  }
}

/**
 * The optional-section decision as one line: what the page left out, or that it kept them all.
 * Read from the AG-UI state's `sections`; the stream's own `sections` event stands in only when
 * the state lacks it (a lost state frame). Null until the decision is made.
 */
export function buildSectionsText(state: AgencyBuildAguiState | null, events: AgencyBuildEvent[], t: Translate): string | null {
  const event = state?.sections ? undefined : [...events].reverse().find((entry) => entry.type === 'sections');
  const dropped = state?.sections?.dropped ?? event?.droppedSections;
  if (!state?.sections && !event) return null;
  return dropped && dropped.length > 0
    ? t('designIndex.build.event.sectionsDropped', { sections: dropped.join(', ') })
    : t('designIndex.build.event.sectionsKept');
}

const EFFECT_SKIP_REASON_KEY: Record<AgencyEffectSkipReason, keyof Dict> = {
  none: 'designIndex.build.effects.reason.none',
  'below-threshold': 'designIndex.build.effects.reason.belowThreshold',
  'not-allowed': 'designIndex.build.effects.reason.notAllowed',
  'script-policy': 'designIndex.build.effects.reason.scriptPolicy',
  'byte-budget': 'designIndex.build.effects.reason.byteBudget',
  'max-effects': 'designIndex.build.effects.reason.maxEffects',
  'host-missing': 'designIndex.build.effects.reason.hostMissing',
  'host-occupied': 'designIndex.build.effects.reason.hostOccupied',
  incompatible: 'designIndex.build.effects.reason.incompatible',
};

const EFFECT_SOURCE_KEY: Record<AgencyEffectsResult['applied'][number]['source'], keyof Dict> = {
  hint: 'designIndex.build.effects.source.hint',
  jev: 'designIndex.build.effects.source.jev',
  repair: 'designIndex.build.effects.source.repair',
};

/**
 * A skip reason's i18n key. A reason is a fixed code, not an identifier, so one this build predates
 * reads as the generic "other" sentence — never the raw daemon string, which is English whatever the
 * screen is in. `Object.hasOwn`, not `in`, for the same reason as `buildOutcomeKey`.
 */
export function effectSkipReasonKey(reason: string): keyof Dict {
  return Object.hasOwn(EFFECT_SKIP_REASON_KEY, reason)
    ? EFFECT_SKIP_REASON_KEY[reason as AgencyEffectSkipReason]
    : 'designIndex.build.effects.reason.unknown';
}

export function effectKindLabel(kind: 'css-only' | 'js', t: Translate): string {
  return kind === 'js' ? t('designIndex.build.effects.kind.js') : t('designIndex.build.effects.kind.cssOnly');
}

/**
 * What a finished build's effect plan did: each applied placement → component, and each skipped
 * placement → its reason, translated from the fixed code. Ids only — the snapshot carries nothing
 * else, never a Jev answer.
 */
function EffectsResultCard({ effects, testIdPrefix, t }: { effects: AgencyEffectsResult; testIdPrefix: string; t: Translate }) {
  return (
    <div data-testid={`${testIdPrefix}-effects-result`}>
      <p className={styles.note}>
        {effects.applied.length === 0 ? t('designIndex.build.effects.result.nothing') : t('designIndex.build.effects.result.label')}
      </p>
      {effects.jevSkipped ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-effects-jev-skipped`}>{t('designIndex.build.effects.result.jevSkipped')}</p>
      ) : null}
      {effects.applied.length > 0 ? (
        <ul className={styles.rows} aria-label={t('designIndex.build.effects.result.applied')} data-testid={`${testIdPrefix}-effects-applied`}>
          {effects.applied.map((entry) => (
            <li key={entry.placement} className={styles.row}>
              <code>{entry.placement}</code>
              {' → '}
              <code>{entry.componentId}</code>
              {' · '}
              {effectKindLabel(entry.kind, t)}
              {' · '}
              {Object.hasOwn(EFFECT_SOURCE_KEY, entry.source) ? t(EFFECT_SOURCE_KEY[entry.source]) : t('designIndex.build.effects.source.unknown')}
            </li>
          ))}
        </ul>
      ) : null}
      {effects.skipped.length > 0 ? (
        <ul className={styles.rows} aria-label={t('designIndex.build.effects.result.skipped')} data-testid={`${testIdPrefix}-effects-skipped`}>
          {effects.skipped.map((entry) => (
            <li key={`${entry.placement}-${entry.componentId ?? ''}`} className={styles.row}>
              <code>{entry.placement}</code>
              {' → '}
              {t(effectSkipReasonKey(entry.reason))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A failed build's route and failure detail, read-only: the same `route` and `failure` fields
 * `GET /api/agency/builds/:id` and `od agency build` show — but only the STRUCTURED ones. `step`
 * and `reason` are fixed codes, so each is translated through its own i18n key (`BUILD_STATUS_KEY`
 * / `failureReasonKey`); `unit` and `slot` are shown verbatim because they are identifiers (a unit
 * label, a schema slot path), not prose, so a locale cannot mistranslate them. `lastError` is NOT
 * rendered here: it is the daemon's own fixed but untranslated ENGLISH sentence
 * (`buildFailureDetail` in `apps/daemon/src/routes/agency-build.ts`), and this panel must read
 * correctly in English — `step`/`reason`/`unit`/`slot` already carry everything `lastError` says,
 * translated or verbatim as appropriate, so nothing is lost by dropping it.
 */
function BuildFailureDetail({ build, testIdPrefix, t }: { build: AgencyBuildSnapshot; testIdPrefix: string; t: Translate }) {
  const { route, failure } = build;
  if (!route && !failure) return null;
  return (
    <ul className={styles.rows} data-testid={`${testIdPrefix}-failure`}>
      {route ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-route`}>
          {route.viaSpine !== undefined
            ? t('designIndex.build.failure.routeVia', {
              spine: route.spine ?? '-',
              family: route.family ?? '-',
              viaSpine: route.viaSpine,
              probability: route.probability !== undefined ? route.probability.toFixed(2) : '-',
            })
            : t('designIndex.build.failure.route', {
              spine: route.spine ?? '-',
              family: route.family ?? '-',
              probability: route.probability !== undefined ? route.probability.toFixed(2) : '-',
            })}
        </li>
      ) : null}
      {failure ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-step`}>{t('designIndex.build.failure.step', { step: t(BUILD_STATUS_KEY[failure.step]) })}</li>
      ) : null}
      {failure?.reason ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-reason`}>
          {t('designIndex.build.failure.reason', { reason: t(failureReasonKey(failure.reason)) })}
        </li>
      ) : null}
      {failure?.unit ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-unit`}>{t('designIndex.build.failure.unit', { unit: failure.unit })}</li>
      ) : null}
      {failure?.slot ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-slot`}>{t('designIndex.build.failure.slot', { slot: failure.slot })}</li>
      ) : null}
      {failure?.flaggedSlots && failure.flaggedSlots.length > 0 ? (
        <li className={styles.row} data-testid={`${testIdPrefix}-failure-flagged`}>
          {t('designIndex.build.failure.flagged', { slots: failure.flaggedSlots.join(', ') })}
        </li>
      ) : null}
    </ul>
  );
}

/** The terminal error codes a trip to Settings (the Jev and fill-model key cards) can fix. */
const SETTINGS_FIXABLE_CODES = new Set<string>(['JEV_UNAVAILABLE', 'MODEL_UNAVAILABLE']);

export interface AgencyBuildProgressProps {
  /**
   * The build's snapshot as the caller holds it: the one `POST /api/agency/build` returned, the
   * daemon's latest after a dropped stream, or the finished build once it settles. Both call sites
   * pass that snapshot as is — never a copy patched with live state. The status line reads the live
   * status from `liveState`; `providers`, `effects`, `route`, `failure` and the outcome read only
   * this snapshot, so they appear once the build has settled.
   */
  build: AgencyBuildSnapshot | null;
  events: AgencyBuildEvent[];
  /** The AG-UI stream's state while the build runs: its live status. */
  liveState: AgencyBuildAguiState | null;
  /** The step timeline, from STEP events only; null when no stream is attached. */
  steps: Array<{ name: AgencyBuildAguiStepName; status: AgencyBuildStepStatus }> | null;
  /** A failure to start or to follow the build — shown above everything else. */
  error: JevFailure | null;
  /** Rendered between the progress lines and the outcome (the Route panel's verdict and repair). */
  children?: ReactNode;
  onOpenSettings?: (section: 'media') => void;
  onOpenProject?: (projectId: string) => void;
  /** Prefix of every `data-testid`, so each surface keeps its own selectors. */
  testIdPrefix?: string;
  t: Translate;
}

/**
 * One build's progress and outcome. Renders nothing of its own frame — the caller owns the card
 * around it. A finished build that published a project offers "Open project" whatever the outcome;
 * a missing Jev or fill-model key offers "Open Settings" when the caller wired one.
 */
export function AgencyBuildProgress({
  build,
  events,
  liveState,
  steps,
  error,
  children,
  onOpenSettings,
  onOpenProject,
  testIdPrefix = 'design-index-build',
  t,
}: AgencyBuildProgressProps) {
  const running = build !== null && !BUILD_TERMINAL.includes(build.status);
  const finished = build !== null && BUILD_TERMINAL.includes(build.status);
  const lines = events
    .map((event) => ({ seq: event.seq, line: buildEventLine(event, t) }))
    .filter((entry): entry is { seq: number; line: string } => entry.line !== null);
  // The snapshot only changes at attach and at the end; the stream's state moves with every
  // event. So the running line reads the live status (it used to sit on `queued` for the whole
  // build).
  const liveStatus = running && liveState && Object.hasOwn(BUILD_STATUS_KEY, liveState.build.status)
    ? liveState.build.status
    : build?.status;
  const sectionsText = buildSectionsText(liveState, events, t);
  const providersLine = buildProvidersLine(build, t);
  const settingsFixable = finished && build.error?.code !== undefined && SETTINGS_FIXABLE_CODES.has(build.error.code);
  // A `blocks`/`auto` build's decision: the snapshot's once it settles, the live stream's from the
  // moment its `composition` event lands (it is decided before the fill starts).
  const composition = build?.composition ?? liveState?.composition ?? null;
  const renderQuality = liveState?.renderQuality !== undefined ? liveState.renderQuality
    : build?.renderQuality ?? [...events].reverse().find((event) => event.type === 'render-quality')?.renderQuality;

  return (
    <>
      {error ? (
        <div data-testid={`${testIdPrefix}-error`}>
          <JevErrorNotice
            error={error}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            testId={`${testIdPrefix}-open-settings`}
            t={t}
          />
        </div>
      ) : null}

      {build && running && liveStatus ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-status`}>{t(BUILD_STATUS_KEY[liveStatus])}</p>
      ) : null}

      {steps ? (
        <ol className={styles.rows} aria-label={t('designIndex.build.steps')} data-testid={`${testIdPrefix}-steps`}>
          {steps.filter((step) => step.name !== 'deploy').map((step) => (
            <li
              key={step.name}
              className={styles.row}
              data-step={step.name}
              data-status={step.status}
              aria-current={step.status === 'active' ? 'step' : undefined}
            >
              <span>{t(BUILD_STEP_KEY[step.name as keyof typeof BUILD_STEP_KEY])}</span>
              <span>{t(BUILD_STEP_STATUS_KEY[step.status])}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {sectionsText !== null ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-sections-outcome`}>{sectionsText}</p>
      ) : null}

      {lines.length > 0 ? (
        <ol className={styles.rows} aria-label={t('designIndex.build.progress')} data-testid={`${testIdPrefix}-progress`}>
          {lines.map((entry) => (
            <li key={entry.seq} className={styles.row}>{entry.line}</li>
          ))}
        </ol>
      ) : null}

      {providersLine ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-providers`}>{providersLine}</p>
      ) : null}

      {children}

      {renderQuality ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-render-quality`}>
          {renderQuality.passed
            ? t('designIndex.build.renderQuality.passed', { checks: renderQuality.checks.length })
            : t('designIndex.build.renderQuality.failed', { issues: renderQuality.issueCounts.reduce((sum, row) => sum + row.count, 0) })}
        </p>
      ) : null}

      {finished ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-outcome`}>
          {t(buildOutcomeKey(build))}
          {/* A project the build left behind is offered whatever the outcome. A failed rollback
              is the one case where a half-written project is still on the daemon, and the person
              who started the build is the only one who can go and look at it. */}
          {build.projectId ? ` · ${build.projectId}` : null}
          {build.projectId && onOpenProject ? (
            <button
              type="button"
              className={`${styles.secondary} ${styles.errorAction}`}
              onClick={() => onOpenProject(build.projectId!)}
              data-testid={`${testIdPrefix}-open-project`}
            >
              {t('designIndex.build.openProject')}
            </button>
          ) : null}
          {settingsFixable && onOpenSettings ? (
            <button
              type="button"
              className={`${styles.secondary} ${styles.errorAction}`}
              onClick={() => onOpenSettings('media')}
              data-testid={`${testIdPrefix}-outcome-open-settings`}
            >
              {t('designIndex.error.openSettings')}
            </button>
          ) : null}
        </p>
      ) : null}

      {build && composition ? <AgencyCompositionSummary composition={composition} t={t} /> : null}

      {finished && build.effects ? <EffectsResultCard effects={build.effects} testIdPrefix={testIdPrefix} t={t} /> : null}

      {finished && build.status === 'failed' ? <BuildFailureDetail build={build} testIdPrefix={testIdPrefix} t={t} /> : null}
    </>
  );
}
