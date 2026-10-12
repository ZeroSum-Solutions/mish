import { WorkbenchComponentFit } from './WorkbenchComponentFit';
import type { ResourceResult } from '@open-design/contracts';
import { useT } from '../../i18n';
import { adoptionCapabilityText, canOfferApply } from './WorkbenchApplyAction';
import styles from './workbench.module.css';

/** The decision-relevant fields (readiness, rights, compatibility, need,
 * adoption) that WorkbenchResourceDetail's outer <dl> carries in the compact
 * view. WorkbenchPreviewShell's expand effect marks every DOM sibling of the
 * dialog root inert at each ancestor level, and that outer <dl> is such a
 * sibling — so without rendering this again *inside* the dialog, enlarging
 * any preview kind would show the user LESS than the compact view did.
 * Shared by every preview kind (html/component, image, font, skill/file/
 * reference, and the unavailable fallback) so enlarging never drops them. */
export function WorkbenchDecisionDetails({ resource, applyOff = false }: { resource: ResourceResult; applyOff?: boolean }) {
  const t = useT();
  return <section className={styles.textDetailSection} data-testid="workbench-text-detail-decision">
    <h5>{t('workbench.enlarge.decisionDetails')}</h5>
    <dl className={styles.textDetailMeta}>
      <dt>{t('workbench.readiness')}</dt><dd>{resource.readiness}</dd>
      <dt>{t('workbench.rights')}</dt><dd>{resource.rightsStatus}</dd>
      <dt>{t('workbench.compatibility')}</dt><dd>{resource.compatibility.nativeFormat} · {resource.compatibility.state}{resource.compatibility.reason ? ` · ${resource.compatibility.reason}` : ''}</dd>
      {resource.componentFit ? <><dt>{t('workbench.components.fit')}</dt><dd><WorkbenchComponentFit fit={resource.componentFit} /></dd></> : null}
      <dt>{t('workbench.need')}</dt><dd>{resource.needDecision} · {resource.needReason}</dd>
      {canOfferApply(resource)
        ? <><dt>{t('workbench.apply.capability')}</dt><dd>{adoptionCapabilityText(resource, t, applyOff)}</dd></>
        : <><dt>{t('workbench.adoptionUnavailable')}</dt><dd>{resource.adoptionCapability.reason ?? 'adapter-missing'}</dd></>}
    </dl>
  </section>;
}
