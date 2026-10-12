import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@open-design/components';
import type { FontLocalFile, FontProfile } from '@open-design/contracts';
import { useT } from '../../i18n';
import styles from './workbench.module.css';

const SPECIMEN_WEIGHTS = ['300', '400', '500', '600', '700', '800'] as const;
export type FontSpecimenStyle = 'normal' | 'italic';
export interface FontSpecimenValue { text: string; weight: number; style: FontSpecimenStyle }

/** Weights a specimen can truthfully show: the family's declared weights that an
 * admitted local file actually covers (static or variable range). */
function localWeights(profile: FontProfile, faces: readonly FontLocalFile[]): string[] {
  const covered = profile.weights.filter((weight) => faces.some((face) => face.weight.min <= weight && weight <= face.weight.max));
  return (covered.length ? covered : [...new Set(faces.map((face) => face.weight.min))].sort((a, b) => a - b)).map(String);
}

/** The font file is loaded through the standard CSS Font Loading API (no script
 * execution; a declarative @font-face source carries the same risk as any other
 * referenced media, and the browser's font sanitizer is the only parser). A unique
 * per-mount family name keeps concurrent specimens and retries from colliding in the
 * document-wide font face set. With a font profile (AC-R11.2), every admitted local
 * file loads with its own weight range, style and unicode-range, so the specimen shows
 * the real files rather than one guessed face. */
export function WorkbenchFontSpecimen({ title, url, profile, onSpecimenChange, children }: {
  title: string; url: string; profile?: FontProfile; onSpecimenChange?: (value: FontSpecimenValue) => void; children?: ReactNode;
}) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState(() => t('workbench.enlarge.fontDefaultSpecimen'));
  const faces = useMemo(() => profile?.localFiles.filter((file) => file.state === 'available' && file.url) ?? [], [profile]);
  const faceKey = faces.map((face) => face.sha256).join(',');
  const weights = useMemo(() => profile && faces.length ? localWeights(profile, faces) : [...SPECIMEN_WEIGHTS], [profile, faces]);
  const fontStyles = useMemo<FontSpecimenStyle[]>(() => faces.length ? [...new Set(faces.map((face) => face.style))].sort() : ['normal'], [faces]);
  const [weight, setWeight] = useState<string>(() => weights.includes('400') ? '400' : weights[0]!);
  const [fontStyle, setFontStyle] = useState<FontSpecimenStyle>(() => fontStyles.includes('normal') ? 'normal' : fontStyles[0]!);
  const family = useMemo(() => `od-specimen-${Math.random().toString(36).slice(2)}`, [url, attempt, faceKey]);
  useEffect(() => { if (!weights.includes(weight)) setWeight(weights.includes('400') ? '400' : weights[0]!); }, [weights, weight]);
  useEffect(() => { if (!fontStyles.includes(fontStyle)) setFontStyle(fontStyles[0]!); }, [fontStyles, fontStyle]);
  useEffect(() => { onSpecimenChange?.({ text, weight: Number(weight), style: fontStyle }); }, [text, weight, fontStyle, onSpecimenChange]);
  useEffect(() => {
    if (typeof FontFace === 'undefined' || !document.fonts) { setState('error'); return; }
    let cancelled = false;
    setState('loading');
    // Without a profile, declare the weight range the specimen offers (SPECIMEN_WEIGHTS):
    // the face otherwise defaults to the single static weight 'normal', so the selector
    // had no visual effect on a static font or triggered faux-bold synthesis.
    const created = faces.length
      ? faces.map((face) => new FontFace(family, `url(${JSON.stringify(face.url)})`, { weight: `${face.weight.min} ${face.weight.max}`, style: face.style, unicodeRange: face.unicodeRange }))
      : [new FontFace(family, `url(${JSON.stringify(url)})`, { weight: '300 800' })];
    created.forEach((face) => document.fonts.add(face));
    // A stalled connection never resolves or rejects face.load(); without this the
    // panel would show "Loading preview…" forever with no Retry affordance.
    // Matches WorkbenchHtmlPreview's existing 8-second mount timeout.
    const timeout = window.setTimeout(() => setState((current) => current === 'loading' ? 'error' : current), 8000);
    Promise.all(created.map((face) => face.load())).then(() => { if (!cancelled) setState('ready'); }).catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; window.clearTimeout(timeout); created.forEach((face) => document.fonts.delete(face)); };
  }, [url, attempt, family, faceKey]);
  return <div className={styles.specimen} data-preview-state={state} data-testid="workbench-font-specimen">
    {state === 'ready' ? <div className={`${styles.fields} ${styles.specimenBody}`}>
      <label>{t('workbench.enlarge.fontSpecimenLabel')}<textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label>{t('workbench.enlarge.fontWeightLabel')}<select value={weight} onChange={(event) => setWeight(event.target.value)}>
        {weights.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {fontStyles.length > 1 ? <label>{t('workbench.font.styleLabel')}<select value={fontStyle} onChange={(event) => setFontStyle(event.target.value as FontSpecimenStyle)}>
        {fontStyles.map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label> : null}
      <p className={styles.specimenText} data-testid="workbench-font-specimen-text" style={{ fontFamily: `'${family}', sans-serif`, fontWeight: weight, fontStyle }}>{text || title}</p>
    </div> : null}
    {/* With side panels (check, rights, spine fit) the status sits inline so a load
        failure never hides the information the user needs to decide what to do next. */}
    {state !== 'ready' ? <div className={children ? styles.statusInline : styles.status} role={state === 'loading' ? 'status' : 'alert'}>
      <span>{t(state === 'loading' ? 'workbench.previewLoading' : 'workbench.enlarge.fontError')}</span>
      {state === 'error' ? <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('preview.retry')}</Button> : null}
    </div> : null}
    {children ? <div className={styles.specimenBody}>{children}</div> : null}
  </div>;
}
