import { useEffect, useState } from 'react';

import {
  peekProjectPreviewBaseHref,
  resolveProjectPreviewBaseHref,
  subscribeProjectPreviewScope,
} from '../runtime/preview-scope-cache';

export interface ProjectPreviewBaseHrefState {
  /** Scoped `/preview/:scope/<dir>/` base, or null when none could be minted. */
  href: string | null;
  /** False while the scope is still being minted. */
  settled: boolean;
}

/**
 * The scoped preview base an opaque-origin srcDoc preview of `name` should
 * resolve relative assets against. Callers wait for `settled` before building
 * the srcDoc so the document is written once, and fall back to the raw
 * directory only when `href` stays null.
 *
 * While mounted with a scope, the hook keeps that scope renewed before it
 * expires; if the daemon refuses renewal (expired, restarted), the scope is
 * replaced and `href` changes to the replacement.
 */
export function useProjectPreviewBaseHref(
  projectId: string | null | undefined,
  name: string,
  enabled = true,
): ProjectPreviewBaseHrefState {
  const key = projectId && enabled ? `${projectId}\0${name}` : null;
  const [state, setState] = useState<{ key: string | null } & ProjectPreviewBaseHrefState>(() => {
    const peeked = projectId && enabled ? peekProjectPreviewBaseHref(projectId, name) : null;
    return { key, href: peeked, settled: peeked !== null || key === null };
  });

  useEffect(() => {
    if (!projectId || !enabled || key === null) return undefined;
    const peeked = peekProjectPreviewBaseHref(projectId, name);
    if (peeked) {
      setState((current) => (
        current.key === key && current.href === peeked && current.settled
          ? current
          : { key, href: peeked, settled: true }
      ));
      return undefined;
    }
    let cancelled = false;
    setState((current) => (current.key === key ? current : { key, href: null, settled: false }));
    void resolveProjectPreviewBaseHref(projectId, name).then((scope) => {
      if (cancelled) return;
      setState({ key, href: scope?.href ?? null, settled: true });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, name, projectId]);

  const activeHref = state.key === key ? state.href : null;
  useEffect(() => {
    if (!projectId || key === null || activeHref === null) return undefined;
    return subscribeProjectPreviewScope(projectId, name, () => {
      const replacement = peekProjectPreviewBaseHref(projectId, name);
      if (replacement) setState({ key, href: replacement, settled: true });
    });
  }, [activeHref, key, name, projectId]);

  if (state.key !== key) {
    return { href: null, settled: key === null };
  }
  return { href: state.href, settled: state.settled };
}
