// Home's "Build with Jev" mode: the brief in the composer goes to the agency fast lane
// (`POST /api/agency/build`) instead of an agent run. Jev routes it to a family, the fill model
// fills it section by section, Jev checks every fact against the brief, and the daemon publishes an
// ordinary HTML project — which Home then opens the way every other create ends.
//
// The progress is the same AG-UI stream and the same rendering the Design index Route panel uses
// (`useAgencyBuildAgui` + `AgencyBuildProgress`); only the request is fixed here: the family is
// `auto`, the fill is per section, effects are `auto`, composition is `auto` (a page composed from
// reviewed blocks when the routed spine has enough of them, the family route otherwise), and
// `verify` is left to the daemon's default (`strict`: nothing is published unless Jev finds no
// fabrication — the only verify mode a composed build accepts).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyBuildRequest, AgencyBuildSnapshot } from '@mish/contracts';

import { useT } from '../i18n';
import { useAgencyBuildAgui } from '../hooks/useAgencyBuildAgui';
import { agencyBuildTimeline } from '../lib/agency-build-agui';
import { startAgencyBuild } from '../providers/registry';
import { AgencyBuildProgress, BUILD_TERMINAL, type JevFailure } from './AgencyBuildProgress';
import cardStyles from './AgencyBuildProgress.module.css';
import styles from './HomeJevBuild.module.css';

type Translate = ReturnType<typeof useT>;

/** Everything a Home build sends besides the brief. No `verify`: the daemon's default (`strict`)
 * applies, which is the only mode `composition: 'auto'` may be combined with. */
export const HOME_JEV_BUILD_OPTIONS = {
  family: 'auto',
  mode: 'sections',
  effects: 'auto',
  composition: 'auto',
} as const satisfies Omit<AgencyBuildRequest, 'brief'>;

export interface HomeJevBuildState {
  build: AgencyBuildSnapshot | null;
  error: JevFailure | null;
  starting: boolean;
  /** True from the Send press until the build reaches a terminal status (or fails to start). */
  busy: boolean;
  view: ReturnType<typeof useAgencyBuildAgui>['view'];
  /** `designSystemId`: the kit picked in the Home composer, which a composed page wears. */
  start: (brief: string, options?: { designSystemId?: string | null }) => Promise<boolean>;
  dismiss: () => void;
}

function startFailure(code: string, t: Translate): JevFailure {
  // A missing Jev key is the one start failure a Settings trip fixes, and it is the structured
  // code that says so — never the daemon's English sentence.
  if (code === 'JEV_UNAVAILABLE') return { message: t('designIndex.error.jevUnavailable'), jevUnavailable: true };
  if (code === 'BUILD_BUSY') return { message: t('designIndex.build.busy'), jevUnavailable: false };
  if (code === 'DESIGN_SYSTEM_NOT_SELECTABLE') return { message: t('designIndex.build.kitNotSelectable'), jevUnavailable: false };
  if (code === 'DESIGN_SYSTEM_TOKENS_UNUSABLE') return { message: t('designIndex.build.kitTokensUnusable'), jevUnavailable: false };
  return { message: t('designIndex.build.startFailed'), jevUnavailable: false };
}

/**
 * One Home build at a time: `start` posts the brief and follows the build's AG-UI stream; a `done`
 * build that published a project is opened once through `onOpenProject`.
 */
export function useHomeJevBuild(onOpenProject: (projectId: string) => void): HomeJevBuildState {
  const t = useT();
  const stream = useAgencyBuildAgui();
  const { reset: resetStream, close: closeStream, follow } = stream;
  const [build, setBuild] = useState<AgencyBuildSnapshot | null>(null);
  const [error, setError] = useState<JevFailure | null>(null);
  const [starting, setStarting] = useState(false);
  // Synchronous guard: two presses in one tick must produce one build.
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const attachedIdRef = useRef<string | null>(null);
  const openedIdRef = useRef<string | null>(null);
  const onOpenProjectRef = useRef(onOpenProject);
  onOpenProjectRef.current = onOpenProject;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeStream();
    };
  }, [closeStream]);

  const settle = useCallback((snapshot: AgencyBuildSnapshot) => {
    if (!mountedRef.current || attachedIdRef.current !== snapshot.id) return;
    setBuild(snapshot);
    if (snapshot.status === 'done' && snapshot.projectId && openedIdRef.current !== snapshot.id) {
      openedIdRef.current = snapshot.id;
      onOpenProjectRef.current(snapshot.projectId);
    }
  }, []);

  const start = useCallback(async (brief: string, options: { designSystemId?: string | null } = {}) => {
    const text = brief.trim();
    if (!text || startingRef.current) return false;
    startingRef.current = true;
    resetStream();
    attachedIdRef.current = null;
    setBuild(null);
    setError(null);
    setStarting(true);
    const started = await startAgencyBuild({
      brief: text,
      ...HOME_JEV_BUILD_OPTIONS,
      ...(options.designSystemId ? { designSystemId: options.designSystemId } : {}),
    });
    startingRef.current = false;
    if (!mountedRef.current) return false;
    setStarting(false);
    if (!started.ok) {
      setError(startFailure(started.code, t));
      return false;
    }
    const snapshot = started.build;
    attachedIdRef.current = snapshot.id;
    setBuild(snapshot);
    // A dropped stream on a build that is still running re-attaches (and, if it keeps dropping,
    // polls the snapshot) until the build ends; only a daemon that stops answering is an error.
    follow(snapshot, {
      isCurrent: () => mountedRef.current && attachedIdRef.current === snapshot.id,
      onSettled: settle,
      onProgress: setBuild,
      onLost: () => setError({ message: t('designIndex.error.request'), jevUnavailable: false }),
    });
    return true;
  }, [follow, resetStream, settle, t]);

  const dismiss = useCallback(() => {
    resetStream();
    attachedIdRef.current = null;
    setBuild(null);
    setError(null);
  }, [resetStream]);

  const running = build !== null && !BUILD_TERMINAL.includes(build.status) && error === null;
  return { build, error, starting, busy: starting || running, view: stream.view, start, dismiss };
}

interface PanelProps {
  state: HomeJevBuildState;
  onOpenSettings?: (section: 'media') => void;
  onOpenProject?: (projectId: string) => void;
}

/** The build's card under the Home composer. Nothing renders before the first Send. */
export function HomeJevBuildPanel({ state, onOpenSettings, onOpenProject }: PanelProps) {
  const t = useT();
  const { build, error, starting, busy, view } = state;
  if (!build && !error && !starting) return null;
  return (
    <section
      className={`${cardStyles.card} ${styles.panel}`}
      aria-live="polite"
      aria-label={t('homeHero.jevSite.title')}
      data-testid="home-jev-build"
    >
      <div className={cardStyles.cardHead}>
        <h2 className={cardStyles.cardTitle}>{t('homeHero.jevSite.title')}</h2>
        {busy ? null : (
          <button
            type="button"
            className={cardStyles.secondary}
            onClick={state.dismiss}
            data-testid="home-jev-build-dismiss"
          >
            {t('common.dismiss')}
          </button>
        )}
      </div>
      {starting ? (
        <p className={cardStyles.note} data-testid="home-jev-build-starting">{t('homeHero.jevSite.starting')}</p>
      ) : null}
      {busy ? <p className={cardStyles.note}>{t('homeHero.jevSite.effectsNote')}</p> : null}
      <AgencyBuildProgress
        build={build}
        events={view?.events ?? []}
        liveState={view?.state ?? null}
        steps={view ? agencyBuildTimeline(view) : null}
        error={error}
        {...(onOpenSettings ? { onOpenSettings } : {})}
        {...(onOpenProject ? { onOpenProject } : {})}
        testIdPrefix="home-jev-build"
        t={t}
      />
    </section>
  );
}
