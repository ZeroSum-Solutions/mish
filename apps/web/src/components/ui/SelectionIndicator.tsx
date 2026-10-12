import { createContext, useContext, useId, type ReactNode } from 'react';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import styles from './selection.module.css';

const SelectionEnabled = createContext(false);
export const selectionSpring = { type: 'spring', stiffness: 480, damping: 40, mass: 0.7 } as const;

/** Each navigation/option group owns an independent shared element identity. */
export function SelectionGroup({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const id = useId();
  return (
    <SelectionEnabled.Provider value={enabled}>
      <LayoutGroup id={id}>{children}</LayoutGroup>
    </SelectionEnabled.Provider>
  );
}

export function SelectionIndicator({ active }: { active: boolean }) {
  const enabled = useContext(SelectionEnabled);
  const reducedMotion = useReducedMotion();
  if (!enabled || !active) return null;
  if (reducedMotion) return <span aria-hidden className={styles.indicator} data-selection-indicator="static" />;
  return (
    <motion.span
      aria-hidden
      className={styles.indicator}
      data-selection-indicator="shared"
      layoutId="selection"
      initial={false}
      transition={selectionSpring}
      style={{ borderRadius: 'inherit' }}
    />
  );
}
