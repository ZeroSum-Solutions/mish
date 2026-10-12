import { useEffect, type RefObject } from 'react';

/**
 * Keep a mounted-but-closed region out of the tab order and away from
 * pointer and assistive-tech interaction. React 18 has no typed `inert`
 * prop, so the attribute is set directly on the element.
 */
export function useInert(ref: RefObject<HTMLElement | null>, inert: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.toggleAttribute('inert', inert);
  }, [ref, inert]);
}
