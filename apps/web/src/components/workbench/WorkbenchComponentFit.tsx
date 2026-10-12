import { COMPONENT_APPLY_BLOCKERS, type ComponentFit } from '@mish/contracts';
import type { Dict } from '../../i18n/types';
import { useT } from '../../i18n';
import styles from './workbench.module.css';
const labels = {
  'primary-conversion': 'workbench.components.reason.primary-conversion',
  'secondary-conversion': 'workbench.components.reason.secondary-conversion',
  spine: 'workbench.components.reason.spine', 'constraint-met': 'workbench.components.reason.constraint-met',
  'kit-unknown': 'workbench.components.reason.kit-unknown',
  'token-adaptable': 'workbench.components.reason.token-adaptable', 'token-fixed': 'workbench.components.reason.token-fixed',
  'token-unknown': 'workbench.components.reason.token-unknown', 'apply-blocked': 'workbench.components.unknown',
} satisfies Record<ComponentFit['reasons'][number]['code'], keyof Dict>;
function explanation(reason: ComponentFit['reasons'][number], t: ReturnType<typeof useT>): string {
  if (reason.code === 'apply-blocked') {
    const blocker = COMPONENT_APPLY_BLOCKERS.find(value => value === reason.fact);
    return blocker ? t(`workbench.components.gate.${blocker}`) : t('workbench.components.unknown');
  }
  const label = t(labels[reason.code]);
  if (reason.code.startsWith('token-') && (reason.fact === 'color' || reason.fact === 'radius' || reason.fact === 'type')) return `${t(`workbench.components.axis.${reason.fact}`)}: ${label}`;
  return label;
}
/** Explanations are rendered from recorded facts; no model-written prose reaches this view. */
export function componentFitLabel(fit: ComponentFit, t: ReturnType<typeof useT>): string {
  return `${t(`workbench.components.${fit.status}`)} · ${t(`workbench.components.acceptance.${fit.acceptance}`)}`;
}
export function WorkbenchComponentFit({ fit, compact = false }: { fit: ComponentFit; compact?: boolean }) {
  const t = useT();
  const reasons = compact ? [...fit.reasons.filter(reason => ['primary-conversion', 'secondary-conversion', 'spine'].includes(reason.code)), ...fit.reasons.filter(reason => !['primary-conversion', 'secondary-conversion', 'spine'].includes(reason.code))].slice(0, 2) : fit.reasons;
  return <span className={styles.fit} data-testid="component-fit" data-fit={fit.status}>
    <strong>{t(`workbench.components.${fit.status}`)}</strong>
    <span data-testid="component-acceptance"> · {t(`workbench.components.acceptance.${fit.acceptance}`)}</span>
    {reasons.map((reason, index) => <span key={`${reason.code}:${reason.fact}:${index}`}> · {explanation(reason, t)}</span>)}
  </span>;
}
