import { useId } from 'react';
import { Select } from '@mish/components';
import type { ResourceTargetDependency, ResourceVariantOption } from '@mish/contracts';
import { useT } from '../../i18n';
import { SegmentedControl } from '../ui/SegmentedControl';
import styles from './workbench.module.css';

/** AC-R07 preamble: one exclusive choice among an item's variants. Up to five use the segmented
 * control; a larger group uses a labelled select (UI system: "Choosing a selection control"). */
export function WorkbenchVariantControl({ variants, value, onChange }: {
  variants: readonly ResourceVariantOption[]; value: string; onChange: (refKey: string) => void;
}) {
  const t = useT();
  const id = useId();
  const label = t('workbench.enlarge.variant');
  if (variants.length <= 5) {
    return <SegmentedControl label={label} value={value} onValueChange={onChange}
      options={variants.map((variant) => ({ value: variant.refKey, label: variant.label, title: variant.title }))} />;
  }
  return <span className={styles.variantSelect}>
    <label htmlFor={id}>{label}</label>
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {variants.map((variant) => <option key={variant.refKey} value={variant.refKey}>{variant.label} · {variant.title}</option>)}
    </Select>
  </span>;
}

const SCOPE_TEXT = {
  project: 'workbench.enlarge.dependencyScope.project',
  bundled: 'workbench.enlarge.dependencyScope.bundled',
  compiled: 'workbench.enlarge.dependencyScope.compiled',
} as const;

/** What the shown variant brings into the target project, as the source declares it. */
export function WorkbenchTargetDependencies({ dependencies }: { dependencies: readonly ResourceTargetDependency[] }) {
  const t = useT();
  return <p className={styles.dependencies} data-testid="workbench-target-dependencies">
    <span className={styles.dependenciesLabel}>{t('workbench.enlarge.dependencies')}</span>{' '}
    {dependencies.length
      ? dependencies.map((dependency, index) => <span key={`${dependency.name}@${dependency.scope}`}>{index ? ', ' : ''}<code>{dependency.name} {dependency.range}</code> ({t(SCOPE_TEXT[dependency.scope])})</span>)
      : t('workbench.enlarge.dependenciesNone')}
  </p>;
}
