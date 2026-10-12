import { useCallback, useEffect, useState } from 'react';
import { Button } from '@mish/components';
import { describeFontSource, type FontCheckResponse, type FontProfile, type FontSourceRecord, type ResourceResult, type WorkspaceCollabContext } from '@mish/contracts';
import { postWorkbenchFontCheck } from '../../providers/workbench';
import { useT } from '../../i18n';
import { WorkbenchFontSpecimen, type FontSpecimenValue } from './WorkbenchFontSpecimen';
import { WorkbenchFontKitRows } from './WorkbenchFontKits';
import styles from './workbench.module.css';

const CHECK_DEBOUNCE_MS = 400;
type FontStateValue = 'permitted' | 'unknown' | 'blocked' | 'available' | 'missing' | 'no-local-file';
const STATE_KEYS = {
  permitted: 'workbench.font.value.permitted', unknown: 'workbench.font.value.unknown', blocked: 'workbench.font.value.blocked',
  available: 'workbench.font.value.available', missing: 'workbench.font.value.missing', 'no-local-file': 'workbench.font.value.noLocalFile',
} as const satisfies Record<FontStateValue, string>;
const glyphList = (glyphs: FontCheckResponse['glyphs']['declared']['missing'], count: number, none: string) =>
  count ? `${glyphs.map((glyph) => `${glyph.char} ${glyph.codepoint}`).join(', ')}${count > glyphs.length ? ` (+${count - glyphs.length})` : ''}` : none;

/** AC-R11.2: the user's specimen text, weight and style checked by the daemon, through
 * the same endpoint and DTO as `od workbench font-check`. */
function WorkbenchFontCheck({ resource, projectId, workspaceContext, value }: {
  resource: ResourceResult; projectId?: string; workspaceContext?: WorkspaceCollabContext | null; value: FontSpecimenValue;
}) {
  const t = useT();
  const [result, setResult] = useState<FontCheckResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFailed(false);
      postWorkbenchFontCheck({ refKey: resource.refKey, ...(projectId ? { projectId } : {}), text: value.text.slice(0, 2000), weights: [value.weight], styles: [value.style] }, workspaceContext)
        .then((next) => { if (!cancelled) setResult(next); })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, CHECK_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [resource.refKey, projectId, workspaceContext, value.text, value.weight, value.style, attempt]);
  const none = t('workbench.font.none');
  return <section className={styles.textDetailSection} data-testid="workbench-font-check" aria-live="polite">
    <h5>{t('workbench.font.check')}</h5>
    {failed ? <div role="alert"><span>{t('workbench.font.checkError')}</span> <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('preview.retry')}</Button></div>
      : !result ? <p role="status">{t('workbench.font.checkRunning')}</p>
        : <>
          <p>{t(result.passed ? 'workbench.font.checkPassed' : 'workbench.font.checkFailed')}</p>
          <dl className={styles.textDetailMeta}>
            <dt>{t('workbench.font.missingDeclared')}</dt>
            <dd data-testid="workbench-font-check-missing-declared">{result.glyphs.declared.state === 'no-declared-ranges' ? t('workbench.font.noDeclaredRanges') : glyphList(result.glyphs.declared.missing, result.glyphs.declared.missingCount, none)}</dd>
            <dt>{t('workbench.font.missingLocal')}</dt>
            <dd data-testid="workbench-font-check-missing-local">{result.glyphs.local.state === 'no-local-file' ? t('workbench.font.noLocalFileShort') : glyphList(result.glyphs.local.missing, result.glyphs.local.missingCount, none)}</dd>
            {[...result.weights.map((entry) => [String(entry.weight), entry.declared, entry.local] as const), ...result.styles.map((entry) => [entry.style, entry.declared, entry.local] as const), ...result.subsets.map((entry) => [entry.subset, entry.declared, entry.local] as const)].map(([label, declared, local]) =>
              <div key={label}><dt>{label}</dt><dd>{t(declared ? 'workbench.font.declaredYes' : 'workbench.font.declaredNo')} · {t('workbench.font.localFiles')}: {t(STATE_KEYS[local])}</dd></div>)}
            <dt>{t('workbench.font.fallback')}</dt><dd>{result.fallback.stack} ({result.fallback.glyphsRenderedByFallback})</dd>
          </dl>
        </>}
  </section>;
}

/** AC-R11.1/AC-R11.3: spine fit and counter-fit, metadata, rights and pinned source. */
function WorkbenchFontProfile({ profile }: { profile: FontProfile }) {
  const t = useT();
  const notices = [...new Map(profile.localFiles.flatMap((file) => file.notice.state === 'available' && file.notice.url ? [[file.notice.sha256, file.notice.url] as const] : [])).values()];
  return <section className={styles.textDetailSection} data-testid="workbench-font-profile">
    <h5>{t('workbench.font.spineFit')}</h5>
    <dl className={styles.textDetailMeta}>
      {profile.spineFit.map((fit) => <div key={fit.spine}>
        <dt>{t(`homeHero.spine.${fit.spine}`)}</dt>
        <dd><span>{t('workbench.font.fit')}: </span><span>{fit.fit}</span></dd>
        <dd><span>{t('workbench.font.counterFit')}: </span><span>{fit.counterFit}</span></dd>
      </div>)}
    </dl>
    <h5>{t('workbench.font.metadata')}</h5>
    <dl className={styles.textDetailMeta}>
      <dt>{t('workbench.font.weights')}</dt><dd>{profile.weights.join(', ')}</dd>
      <dt>{t('workbench.font.styles')}</dt><dd>{profile.styles.join(', ')}</dd>
      <dt>{t('workbench.font.subsets')}</dt><dd>{profile.subsets.join(', ')}</dd>
      <dt>{t('workbench.font.axes')}</dt><dd>{profile.axes.length ? profile.axes.map((axis) => `${axis.tag} ${axis.min}–${axis.max}`).join(', ') : t('workbench.font.none')}</dd>
    </dl>
    <h5>{t('workbench.font.licence')}</h5>
    <dl className={styles.textDetailMeta}>
      <dt>{t('workbench.font.licence')}</dt><dd>{profile.licence.type}{profile.licence.attribution ? ` · ${profile.licence.attribution}` : ''}</dd>
      <dt>{t('workbench.font.permissions')}</dt>
      <dd>{t('workbench.font.commercialUse')}: {t(STATE_KEYS[profile.licence.commercialUse])} · {t('workbench.font.webEmbedding')}: {t(STATE_KEYS[profile.licence.webEmbedding])} · {t('workbench.font.redistribution')}: {t(STATE_KEYS[profile.licence.redistribution])}</dd>
      <dt>{t('workbench.font.modification')}</dt><dd>{profile.licence.modification}</dd>
      {notices.length ? <><dt>{t('workbench.font.notice')}</dt><dd>{notices.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer noopener">{t('workbench.font.notice')} {index + 1}</a>)}</dd></> : null}
      <dt>{t('workbench.font.source')}</dt><dd>{describeFontSource(profile.source)}</dd>
    </dl>
    {profile.sources?.length ? <WorkbenchFontSources records={profile.sources} /> : null}
    {profile.kitDeclarations?.length ? <div data-testid="workbench-font-kits">
      <h5>{t('workbench.font.kitDeclarations')}</h5>
      <WorkbenchFontKitRows declarations={profile.kitDeclarations} />
    </div> : null}
  </section>;
}

const SOURCE_NAMES: Record<FontSourceRecord['source'], string> = { fontsource: 'Fontsource', 'google-fonts': 'Google Fonts', fontshare: 'Fontshare' };
const shortDigest = (digest: string) => digest.slice(0, 12);
/** AC-R11 preamble: every pinned source that lists the family, with its licence and notice
 * digests (or why one is missing) and whether a local file is admitted from it. */
function WorkbenchFontSources({ records }: { records: readonly FontSourceRecord[] }) {
  const t = useT();
  return <div data-testid="workbench-font-sources">
    <h5>{t('workbench.font.sources')}</h5>
    <dl className={styles.textDetailMeta}>
      {records.map((record) => <div key={record.source}>
        <dt>{record.url ? <a href={record.url} target="_blank" rel="noreferrer noopener">{SOURCE_NAMES[record.source]}</a> : SOURCE_NAMES[record.source]} · {record.identity}</dt>
        <dd>{record.licenceType} · {t(record.localFile === 'admitted' ? 'workbench.font.localFileAdmitted' : 'workbench.font.localFileNone')}</dd>
        <dd>{t('workbench.font.licenceDigest')}: {record.licenceSha256 ? <code title={record.licenceSha256}>{shortDigest(record.licenceSha256)}</code> : t('workbench.font.none')}
          {' · '}{t('workbench.font.noticeDigest')}: {record.noticeSha256 ? <code title={record.noticeSha256}>{shortDigest(record.noticeSha256)}</code> : t('workbench.font.none')}</dd>
        {record.reason ? <dd>{record.reason}</dd> : null}
      </div>)}
    </dl>
  </div>;
}

/** Font results with a profile: the real local specimen when admitted bytes exist, a
 * truthful no-local-file state otherwise, and in both cases the check and profile. */
export function WorkbenchFontDetail({ resource, projectId, workspaceContext }: { resource: ResourceResult; projectId?: string; workspaceContext?: WorkspaceCollabContext | null }) {
  const t = useT();
  const profile = resource.fontProfile!;
  const [value, setValue] = useState<FontSpecimenValue>(() => ({ text: t('workbench.enlarge.fontDefaultSpecimen'), weight: 400, style: 'normal' }));
  const onSpecimenChange = useCallback((next: FontSpecimenValue) => setValue(next), []);
  const preview = resource.previewCapability;
  const panels = <>
    <WorkbenchFontCheck resource={resource} projectId={projectId} workspaceContext={workspaceContext} value={value} />
    <WorkbenchFontProfile profile={profile} />
  </>;
  if (preview.available && preview.kind === 'reference' && preview.url && preview.reason === null && profile.localFiles.some((file) => file.state === 'available')) {
    return <WorkbenchFontSpecimen title={resource.title} url={preview.url} profile={profile} onSpecimenChange={onSpecimenChange}>{panels}</WorkbenchFontSpecimen>;
  }
  return <div className={styles.specimen} data-preview-state="unavailable" data-testid="workbench-font-unavailable">
    <div className={`${styles.fields} ${styles.specimenBody}`}>
      <p role="status">{preview.reason === 'no-local-font-file' || !preview.reason ? t('workbench.font.noLocalFile') : `${t('workbench.previewUnavailable')} · ${preview.reason}`}</p>
      <label>{t('workbench.enlarge.fontSpecimenLabel')}<textarea rows={2} value={value.text} onChange={(event) => setValue({ ...value, text: event.target.value })} /></label>
      {panels}
    </div>
  </div>;
}
