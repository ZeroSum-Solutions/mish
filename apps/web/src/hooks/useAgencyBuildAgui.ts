import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyBuildSnapshot } from '@open-design/contracts';

import {
  agencyBuildAgui,
  agencyBuildSnapshotFromAgui,
  EMPTY_AGENCY_BUILD_AGUI_VIEW,
  isAgencyBuildTerminal,
  reduceAgencyBuildAgui,
  type AgencyBuildAguiView,
} from '../lib/agency-build-agui';
import { fetchAgencyBuild } from '../providers/registry';

export interface AgencyBuildAguiHandlers {
  /** RUN_FINISHED or RUN_ERROR arrived; the stream is already closed. */
  onTerminal: (view: AgencyBuildAguiView) => void;
  /** The stream closed without a terminal frame. */
  onError: () => void;
}

export interface AgencyBuildFollowHandlers {
  /**
   * False once the caller has moved on — another build, a reset, an unmount. Checked before every
   * callback and before every retry, so a follow nobody wants any more stops by itself.
   */
  isCurrent: () => boolean;
  /** The build ended: from the stream's own state, or from the daemon's snapshot. */
  onSettled: (build: AgencyBuildSnapshot) => void;
  /** The stream dropped while the build still runs: the daemon's latest snapshot of it. */
  onProgress?: (build: AgencyBuildSnapshot) => void;
  /** The daemon stopped answering for the build, so nothing more can be said about it. */
  onLost: () => void;
}

/** Stream re-attaches after a drop on a build that is still running, before falling back to polling. */
export const AGENCY_BUILD_FOLLOW_MAX_REATTACH = 5;
/** Snapshot reads in a row that may fail (daemon unreachable, build unknown) before giving up. */
export const AGENCY_BUILD_FOLLOW_MAX_MISSES = 3;
/** How often a build whose stream keeps dropping is polled once the re-attaches are spent. */
export const AGENCY_BUILD_FOLLOW_POLL_MS = 4_000;

/** Back-off before the n-th retry (1-based): 250 ms, 500 ms, 1 s, 2 s, then 4 s. */
export function agencyBuildFollowDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 4_000);
}

/**
 * One build's AG-UI stream as React state. `watch` opens it (closing any earlier one), `reset`
 * closes it and clears the view, and an unmount closes it. Frames are reduced in arrival order
 * outside React's updater, so the terminal handler sees the same view the panel renders.
 *
 * `follow` is `watch` plus what a caller needs to stay with the build to its end: a dropped stream
 * says nothing about the build, so the snapshot is read — a finished build settles, a running one
 * gets its stream back (and, if the stream keeps dropping, is polled until it ends). Only a daemon
 * that stops answering for the build is reported as lost.
 */
export function useAgencyBuildAgui() {
  const [view, setView] = useState<AgencyBuildAguiView | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const reset = useCallback(() => {
    close();
    setView(null);
  }, [close]);

  const watch = useCallback((buildId: string, handlers: AgencyBuildAguiHandlers) => {
    close();
    let current = EMPTY_AGENCY_BUILD_AGUI_VIEW;
    setView(current);
    const source = agencyBuildAgui(buildId, {
      onFrame: (frame) => {
        if (sourceRef.current !== source) return;
        current = reduceAgencyBuildAgui(current, frame);
        setView(current);
        if (frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR') {
          close();
          handlers.onTerminal(current);
        }
      },
      onError: () => {
        if (sourceRef.current !== source) return;
        sourceRef.current = null;
        handlers.onError();
      },
    });
    sourceRef.current = source;
  }, [close]);

  const follow = useCallback((snapshot: AgencyBuildSnapshot, handlers: AgencyBuildFollowHandlers) => {
    let reattaches = 0;
    let misses = 0;
    const later = (run: () => void, ms: number) => {
      window.setTimeout(() => {
        if (handlers.isCurrent()) run();
      }, ms);
    };
    const recover = async () => {
      const latest = await fetchAgencyBuild(snapshot.id);
      if (!handlers.isCurrent()) return;
      if (latest && isAgencyBuildTerminal(latest.status)) {
        handlers.onSettled(latest);
        return;
      }
      if (!latest) {
        misses += 1;
        if (misses >= AGENCY_BUILD_FOLLOW_MAX_MISSES) {
          handlers.onLost();
          return;
        }
        later(() => void recover(), agencyBuildFollowDelay(misses));
        return;
      }
      misses = 0;
      handlers.onProgress?.(latest);
      if (reattaches < AGENCY_BUILD_FOLLOW_MAX_REATTACH) {
        reattaches += 1;
        later(attach, agencyBuildFollowDelay(reattaches));
        return;
      }
      later(() => void recover(), AGENCY_BUILD_FOLLOW_POLL_MS);
    };
    const attach = () => {
      watch(snapshot.id, {
        // RUN_FINISHED / RUN_ERROR: the stream's own state is the finished build, unless a state
        // frame was lost (a delta that did not apply, a frame that failed validation, data that was
        // not JSON) — then the daemon's snapshot is read before the terminal frame is accepted.
        onTerminal: (finished) => {
          if (!handlers.isCurrent()) return;
          if (!finished.stale) {
            handlers.onSettled(agencyBuildSnapshotFromAgui(finished, snapshot));
            return;
          }
          void recover();
        },
        onError: () => {
          if (handlers.isCurrent()) void recover();
        },
      });
    };
    attach();
  }, [watch]);

  useEffect(() => close, [close]);

  return { view, watch, follow, reset, close };
}
