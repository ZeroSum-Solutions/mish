import { WorkbenchComponentFit } from './WorkbenchComponentFit';
import { localizeMotionRecipe, localizeMotionRecipeVariantTitle } from './motion-recipe-labels';
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@mish/components';
import type { ResourceDetailResponse, ResourceResult, InstalledPluginRecord, WorkspaceCollabContext } from '@mish/contracts';
import { getWorkbenchResource, WorkbenchRequestError } from '../../providers/workbench';
import { useT } from '../../i18n';
import { WorkbenchExpandedContext, WorkbenchPreviewShell } from './WorkbenchPreviewShell';
import { WorkbenchHtmlPreview } from './WorkbenchHtmlPreview';
import { WorkbenchImageZoom } from './WorkbenchImageZoom';
import { WorkbenchVideoPreview } from './WorkbenchVideoPreview';
import { WorkbenchFontSpecimen } from './WorkbenchFontSpecimen';
import { WorkbenchFontDetail } from './WorkbenchFontDetail';
import { WorkbenchTextDetail } from './WorkbenchTextDetail';
import { WorkbenchDecisionDetails } from './WorkbenchDecisionDetails';
import { WorkbenchViewportContext, WorkbenchViewportControls, type EnlargeViewportWidth } from './WorkbenchViewport';
import { WorkbenchTargetDependencies, WorkbenchVariantControl } from './WorkbenchVariantControl';
import { WorkbenchApplyAction, adoptionCapabilityText, canOfferApply } from './WorkbenchApplyAction';
import styles from './workbench.module.css';

/** Adapter-less entries (missing adapter, offline connector, blocked rights, …) still
 * get the Enlarge affordance; the enlarged view states the truth instead of faking a
 * preview, and always carries the source and a concrete recovery action. */
function WorkbenchPreviewUnavailable({ reason, sourceAttribution, onRefresh }: {
  reason: string | null; sourceAttribution: { title: string; url?: string }; onRefresh: () => void;
}) {
  const t = useT();
  return <div className={styles.html} data-preview-state="unavailable" data-testid="workbench-preview-unavailable">
    <div className={styles.status} role="alert">
      <span>{t('workbench.previewUnavailable')}{reason ? ` · ${reason}` : ''}</span>
      <span>{t('workbench.source')}: {sourceAttribution.url ? <a href={sourceAttribution.url} target="_blank" rel="noreferrer noopener">{sourceAttribution.title}</a> : sourceAttribution.title}</span>
      <Button size="sm" onClick={onRefresh}>{t('preview.retry')}</Button>
    </div>
  </div>;
}

/** A `reference` preview kind is ambiguous by itself: today's only real producer
 * (the sections source's `external-link` case) sets it for a link to an external
 * page, always paired with a non-null reason explaining there is no local adapter.
 * A future image/font adapter that reuses the same `kind: 'reference'` + url shape
 * for genuinely fetchable media bytes would set a null reason, exactly as every
 * current `available: true` adapter (html, or this reference case's siblings)
 * already does. Gate on that so a reused "external link" convention falls through
 * to the truthful-unavailable panel (with its real reason) instead of being fed
 * into <img>/FontFace as if it were loadable media. */
function isFetchableMediaReference(preview: ResourceResult['previewCapability']): preview is ResourceResult['previewCapability'] & { url: string } {
  return preview.available && preview.kind === 'reference' && !!preview.url && preview.reason === null;
}

/** Every category gets the same Enlarge shell (AC-R07.1); only the content inside
 * differs. Priority: an executable HTML/component/video preview wins whenever the
 * adapter actually offers one, regardless of declared category, then a native video; otherwise the
 * category decides between an image zoom, a font specimen, a readable metadata
 * detail (skill/file/reference), or the truthful-unavailable panel above. */
function workbenchPreviewContent(resource: ResourceResult, onRetry: () => void, scope: { projectId?: string; workspaceContext?: WorkspaceCollabContext | null }) {
  const preview = resource.previewCapability;
  if (preview.available && preview.kind === 'html' && preview.url) return <WorkbenchHtmlPreview title={resource.title} url={preview.url} adapter={preview.adapter} />;
  // AC-R07.1: a video item without an HTML preview plays in the native player. No source emits
  // `kind: 'video'` yet; the video-federation unit adds it (apps/daemon/tests/workbench/resources-video-gap.test.ts).
  if (preview.available && preview.kind === 'video' && preview.url) return <WorkbenchVideoPreview title={resource.title} url={preview.url} />;
  // AC-R11: a catalogued font shows its real local files (or says none are admitted),
  // its text check and its spine fit, whether or not a specimen can render.
  if (resource.category === 'font' && resource.fontProfile) return <WorkbenchFontDetail resource={resource} {...scope} />;
  if (isFetchableMediaReference(preview) && resource.category === 'image') return <WorkbenchImageZoom title={resource.title} url={preview.url} />;
  if (isFetchableMediaReference(preview) && resource.category === 'font') return <WorkbenchFontSpecimen title={resource.title} url={preview.url} />;
  if (resource.category === 'skill' || resource.category === 'file' || resource.category === 'reference') return <WorkbenchTextDetail resource={resource} />;
  return <WorkbenchPreviewUnavailable reason={preview.reason} sourceAttribution={resource.sourceAttribution} onRefresh={onRetry} />;
}

export function WorkbenchResourceDetail({ selected, projectId, workspaceContext, plugins, onPickPlugin, onClose, onRefresh }: {
  selected: ResourceResult; projectId?: string; workspaceContext?: WorkspaceCollabContext | null;
  plugins: InstalledPluginRecord[]; onPickPlugin: (record: InstalledPluginRecord) => void; onClose: () => void; onRefresh: () => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<ResourceDetailResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // A local retry bumps only this counter and re-fetches this one resource. The
  // caller's `onRefresh` re-runs the whole search and nulls its selection — fine
  // for "the search itself failed", wrong for "this one preview failed to load":
  // that path used to close the entire enlarged/detail view out from under the
  // user instead of just refreshing what actually failed.
  const [retryCount, setRetryCount] = useState(0);
  // AC-R07.2: the Enlarge width persists across restore and re-enlarge for this detail.
  const [viewport, setViewport] = useState<EnlargeViewportWidth>('fit');
  // AC-R07 preamble: the variant on show. A variant switch keeps the shown detail (and so the
  // open dialog, its width and the caller's selection) until the next variant arrives; a retry
  // reloads whichever variant is on show.
  const shownKey = useRef(selected.refKey);
  const variantRequest = useRef(0);
  const [pendingVariant, setPendingVariant] = useState<string | null>(null);
  const [variantFailed, setVariantFailed] = useState(false);
  function retry() { setRetryCount((n) => n + 1); }
  useEffect(() => {
    let cancelled = false; setDetail(null); setError(null);
    variantRequest.current += 1; setPendingVariant(null); setVariantFailed(false);
    getWorkbenchResource(shownKey.current, projectId, workspaceContext).then((value) => { if (!cancelled) setDetail(value); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason : new Error('resource-detail-failed')); });
    return () => { cancelled = true; };
  }, [selected.refKey, projectId, workspaceContext, retryCount]);
  function chooseVariant(refKey: string) {
    if (!detail || refKey === detail.resource.refKey) return;
    const request = ++variantRequest.current;
    setPendingVariant(refKey); setVariantFailed(false);
    getWorkbenchResource(refKey, projectId, workspaceContext).then((value) => {
      if (request !== variantRequest.current) return;
      shownKey.current = value.resource.refKey; setDetail(value); setPendingVariant(null);
    }).catch(() => {
      if (request !== variantRequest.current) return;
      setPendingVariant(null); setVariantFailed(true);
    });
  }
  const resource = detail?.resource ? localizeMotionRecipe(detail.resource, t) : undefined;
  const [applyOffState, setApplyOffState] = useState<{ key: string; off: boolean } | null>(null);
  const applyKey = `${projectId ?? ""}:${resource?.refKey ?? ""}`;
  const onApplyOffChange = useCallback((off: boolean) => setApplyOffState({ key: applyKey, off }), [applyKey]);
  const applyOff = applyOffState?.key === applyKey && applyOffState.off;
  const variants = detail?.variants && detail.variants.length > 1
    ? detail.variants.map(variant => ({ ...variant, title: localizeMotionRecipeVariantTitle(detail.resource, variant.title, t) }))
    : null;
  const plugin = resource?.ref.sourceType === 'plugin' ? plugins.find((record) => record.id === resource.ref.itemId) : undefined;
  return <section className={styles.detail} aria-label={localizeMotionRecipe(selected, t).title} data-testid="workbench-resource-detail">
    <Button size="sm" onClick={onClose}>{t('workbench.closeDetails')}</Button>
    {error ? <div role="alert"><p>{t('workbench.inspectError')}</p><p>{error instanceof WorkbenchRequestError ? `${error.status} · ${error.code}` : error.message}</p>{error instanceof WorkbenchRequestError ? error.nextSteps.map((step) => <p key={step}>{step}</p>) : null}<Button size="sm" onClick={retry}>{t('preview.retry')}</Button></div> : !resource ? <p role="status">{t('workbench.previewLoading')}</p> : <>
      <h3>{resource.title}</h3>
      <dl>
        <dt>{t('workbench.readiness')}</dt><dd>{resource.readiness}</dd>
        <dt>{t('workbench.rights')}</dt><dd>{resource.rightsStatus}</dd>
        <dt>{t('workbench.source')}</dt><dd>{resource.sourceAttribution.title} · {resource.ref.sourceId}</dd>
        <dt>{t('workbench.compatibility')}</dt><dd>{resource.compatibility.nativeFormat} · {resource.compatibility.state}{resource.compatibility.reason ? ` · ${resource.compatibility.reason}` : ''}</dd>
        {resource.componentFit ? <><dt>{t('workbench.components.fit')}</dt><dd><WorkbenchComponentFit fit={resource.componentFit} /></dd></> : null}
      <dt>{t('workbench.need')}</dt><dd>{resource.needDecision} · {resource.needReason}</dd>
        {resource.sourceIdentity ? <><dt>{t('workbench.sourceIdentity')}</dt><dd data-testid="workbench-source-identity"><SourceIdentity identity={resource.sourceIdentity} /></dd></> : null}
        {canOfferApply(resource)
          ? <><dt>{t('workbench.apply.capability')}</dt><dd>{adoptionCapabilityText(resource, t, applyOff)}</dd></>
          : <><dt>{t('workbench.adoptionUnavailable')}</dt><dd>{resource.adoptionCapability.reason ?? 'adapter-missing'}</dd></>}
      </dl>
      {/* The decision section renders inside the shell's children for every
          preview kind (html/component, image, font, skill/file/reference, and
          the unavailable fallback), not only skill/file/reference's own text
          detail: WorkbenchPreviewShell's expand effect inerts every DOM
          sibling of the dialog root, including this component's outer <dl>
          above, so this is the only place these fields stay reachable once
          enlarged. It renders only while enlarged; the compact view already
          shows the same fields in the <dl> above. */}
      <WorkbenchPreviewShell title={resource.title}>
        <div className={styles.enlargeBody}>
          <EnlargeControls showViewport={resource.previewCapability.available && resource.previewCapability.kind === 'html'}
            variants={variants ? <WorkbenchVariantControl variants={variants} value={pendingVariant ?? resource.refKey} onChange={chooseVariant} /> : null}
            status={pendingVariant ? <span role="status">{t('workbench.enlarge.variantLoading')}</span> : variantFailed ? <span role="alert">{t('workbench.enlarge.variantError')}</span> : null}
            dependencies={resource.targetDependencies ? <WorkbenchTargetDependencies dependencies={resource.targetDependencies} /> : null}
            viewport={<WorkbenchViewportControls value={viewport} onChange={setViewport} />} />
          <div className={styles.enlargePreview}><WorkbenchViewportContext.Provider value={viewport}>{workbenchPreviewContent(resource, retry, { ...(projectId ? { projectId } : {}), workspaceContext })}</WorkbenchViewportContext.Provider></div>
          <EnlargedOnly><div className={styles.enlargeDecision}><WorkbenchDecisionDetails resource={resource} applyOff={applyOff} /></div></EnlargedOnly>
        </div>
      </WorkbenchPreviewShell>
      {/* Existing plugin selection stages the same record; it is not a new adoption grant. */}
      {plugin ? <Button size="sm" onClick={() => onPickPlugin(plugin)}>{t('preview.usePlugin')}</Button> : null}
      <WorkbenchApplyAction key={applyKey} onApplyOffChange={onApplyOffChange} resource={resource} projectId={projectId} workspaceContext={workspaceContext} />
    </>}
  </section>;
}

/** AC-R18.6–R18.8: exact repository/commit, acquisition mode, documented connector state and next gate. */
function SourceIdentity({ identity }: { identity: NonNullable<ResourceResult['sourceIdentity']> }) {
  const t = useT();
  const pin = identity.commit ? identity.commit.slice(0, 7) : identity.contentSha256 ? `sha256:${identity.contentSha256.slice(0, 12)}` : '';
  const assessment = identity.rightsAssessment;
  const counts = identity.operationRights.reduce<Record<string, number>>((all, right) => ({ ...all, [right.decision]: (all[right.decision] ?? 0) + 1 }), {});
  return <>
    <a href={identity.repositoryUrl} target="_blank" rel="noreferrer noopener">{identity.repositoryUrl.replace(/^https:\/\//u, '')}</a>{pin ? ` @ ${pin}` : ''} · {identity.acquisitionMode}
    {identity.documentedConnector ? <><br />{t('workbench.sourceIdentityConnector')}: {identity.documentedConnector.name} · {identity.documentedConnector.state}</> : null}
    {identity.operationRights.length ? <><br />{t('workbench.sourceIdentityRights')}: {Object.entries(counts).map(([decision, count]) => `${count} ${decision}`).join(', ')}</> : null}
    {assessment ? <>
      <br />{t('workbench.sourceIdentityAssessment')}: {assessment.evaluatorRole} · {assessment.basis}
      {assessment.termsUrl ? <> · <a href={assessment.termsUrl} target="_blank" rel="noreferrer noopener">{assessment.termsUrl.replace(/^https:\/\//u, '')}</a></> : null}
      {assessment.ownerDecision ? <><br />{t('workbench.sourceIdentityOwnerDecision')} {assessment.ownerDecision.decidedAt}: {assessment.ownerDecision.citation}</> : null}
      {/* AC-R18.6: each decision with the clause-cited reason the assessment recorded. */}
      <details>
        <summary>{t('workbench.sourceIdentityRightsDetail')}</summary>
        <ul data-testid="workbench-source-rights">
          {identity.operationRights.map(right => <li key={right.operation}>{right.operation}: {right.decision}{right.reason ? ` — ${right.reason}` : ''}</li>)}
        </ul>
      </details>
    </> : null}
    <br />{t('workbench.sourceIdentityNextGate')}: {identity.nextGate}
  </>;
}

/** The row above the preview: the variant choice and its dependencies in both views, and the
 * width switch while enlarged for an HTML document. Renders nothing when it would be empty. */
function EnlargeControls({ showViewport, variants, status, dependencies, viewport }: {
  showViewport: boolean; variants: ReactNode; status: ReactNode; dependencies: ReactNode; viewport: ReactNode;
}) {
  const expanded = useContext(WorkbenchExpandedContext);
  const withViewport = expanded && showViewport;
  if (!variants && !dependencies && !status && !withViewport) return null;
  return <div className={styles.enlargeControls}>{variants}{status}{dependencies}{withViewport ? viewport : null}</div>;
}

/** Renders its children only while the surrounding WorkbenchPreviewShell is enlarged. */
function EnlargedOnly({ children }: { children: ReactNode }) {
  return useContext(WorkbenchExpandedContext) ? <>{children}</> : null;
}
