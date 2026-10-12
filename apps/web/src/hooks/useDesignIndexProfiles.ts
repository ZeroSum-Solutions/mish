// Home's view of the stored design-index profiles.
//
// Re-read on every transition to active — not only on mount — because Home
// stays mounted while the user visits the Design index tab, stores a profile
// there and comes back. The same read runs on `mish:design-index-changed`
// so a store or a removal shows up without a tab switch.
//
// A generation counter arbitrates overlapping reads: a slow first response
// must never overwrite a faster later one. A failed read keeps whatever was
// already on screen and raises `failed`, so the strip stays usable with the
// family cards it already has.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesignProfile } from '@mish/contracts';
import { DESIGN_INDEX_CHANGED_EVENT, listDesignIndexProfiles } from '../state/design-index';

export interface DesignIndexProfilesState {
  profiles: DesignProfile[];
  loading: boolean;
  failed: boolean;
}

const EMPTY_PROFILES: DesignProfile[] = [];

export function useDesignIndexProfiles(active: boolean): DesignIndexProfilesState {
  const [state, setState] = useState<DesignIndexProfilesState>({
    profiles: EMPTY_PROFILES,
    loading: false,
    failed: false,
  });
  const generationRef = useRef(0);

  const reload = useCallback(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState((current) => ({ ...current, loading: true, failed: false }));
    void listDesignIndexProfiles().then(
      (profiles) => {
        if (generationRef.current !== generation) return;
        setState({ profiles, loading: false, failed: false });
      },
      () => {
        if (generationRef.current !== generation) return;
        setState((current) => ({ profiles: current.profiles, loading: false, failed: true }));
      },
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    reload();
  }, [active, reload]);

  useEffect(() => {
    const onChanged = () => reload();
    window.addEventListener(DESIGN_INDEX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DESIGN_INDEX_CHANGED_EVENT, onChanged);
  }, [reload]);

  return state;
}
