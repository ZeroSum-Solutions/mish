import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WorkspaceCollabContext } from '@mish/contracts';
import { buildSrcdoc } from '../runtime/srcdoc';
import { useBrandFonts } from './DesignKitView';
import { useT } from '../i18n';
import { openExternalUrl } from '../providers/registry';
import { useResolvedTheme } from './ConnectorLogo';
import { fontStack, isLightHex, type DesignKit } from '../runtime/design-kit';
const styles = {
  overview: 'ds-overview-overview',
  showcase: 'ds-overview-showcase',
  specimen: 'ds-overview-specimen',
  heading: 'ds-overview-heading',
  disclosure: 'ds-overview-disclosure',
  section: 'ds-overview-section',
  swatches: 'ds-overview-swatches',
  palette: 'ds-overview-palette',
  eyebrow: 'ds-overview-eyebrow',
  fontSample: 'ds-overview-fontSample',
  fontMeta: 'ds-overview-fontMeta',
  fontAvailability: 'ds-overview-fontAvailability',
  colorDetails: 'ds-overview-colorDetails',
  fonts: 'ds-overview-fonts',
  rules: 'ds-overview-rules',
  showcaseSkeleton: 'ds-overview-showcaseSkeleton',
  paletteStrip: 'ds-overview-paletteStrip',
  paletteToggle: 'ds-overview-paletteToggle',
};

// Past this many colors the palette opens as a compact strip; the full
// swatch list (names + values) is one click away instead of a tile wall.
const PALETTE_STRIP_THRESHOLD = 8;
// A showcase that never reports `load` (blocked frame, stalled image) must not
// hold the skeleton forever.
const SHOWCASE_REVEAL_FALLBACK_MS = 4000;

/** A browsing overview. The complete, editable kit remains in DesignKitView. */
export function DesignSystemOverview({ kit, dataTestId, workspaceContext = null, workspaceReadGeneration, onImageError }: {
  kit: DesignKit;
  dataTestId: string;
  workspaceContext?: WorkspaceCollabContext | null;
  workspaceReadGeneration?: string;
  onImageError?: () => void;
}) {
  const t = useT();
  const theme = useResolvedTheme();
  useBrandFonts(kit.projectId, kit.fonts, workspaceContext, workspaceReadGeneration, kit.fontFaces);
  const showcaseDocument = useMemo(() => kit.showcaseHtml ? buildSrcdoc(kit.showcaseHtml) : undefined, [kit.showcaseHtml]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [showcaseHeight, setShowcaseHeight] = useState(360);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [paletteExpanded, setPaletteExpanded] = useState(false);
  const paletteListId = useId();
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const pane = stage.closest('.project-ds-picker-preview');
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === stage && entry.contentRect.width >= 1) setWidth(entry.contentRect.width);
        // The showcase occupies half the scroll pane before any disclosures open.
        if (entry.target === pane) setShowcaseHeight(Math.max(240, window.matchMedia('(max-width: 600px)').matches ? window.innerHeight * .45 : pane!.clientHeight / 2));
      }
    });
    observer.observe(stage);
    if (pane) observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const name = kit.name.replace(/\s*[·–—-]\s*Study\s*$/i, '');
  const fonts = Object.entries(kit.typography).filter(([, font]) => Boolean(font));
  // A color may serve several source tokens. Show its swatch once; retain all
  // token roles and usage guidance in the disclosure below.
  const palette = useMemo(() => {
    const unique = new Map<string, { color: DesignKit['colors'][number]; notes: string[] }>();
    for (const color of kit.colors) {
      const key = color.hex.trim().toLowerCase();
      const note = [color.name || color.role || color.hex, color.usage].filter(Boolean).join(' — ');
      const existing = unique.get(key);
      if (existing) existing.notes.push(note);
      else unique.set(key, { color, notes: [note] });
    }
    return [...unique.values()];
  }, [kit.colors]);
  const description = kit.description?.split(/(?<=[.!?])\s/)[0] || kit.tagline;
  const frameScale = Math.max(1, width) / 1280;
  const frameHeight = Math.min(showcaseHeight / frameScale, 2400);
  // Which showcase is on stage. A frame or image keeps a skeleton over the
  // stage until it reports `load`, so the box is never an empty rectangle.
  const showImage = Boolean(kit.referenceImageUrl && kit.referenceImageUrl !== failedImage);
  const kitFrameUrl = kit.system?.kitUrl ? (theme === 'dark' ? kit.system.kitDarkUrl || kit.system.kitUrl : kit.system.kitUrl) : undefined;
  const showcaseSource = showImage ? `img:${kit.referenceImageUrl}` : kitFrameUrl ? `kit:${kitFrameUrl}` : kit.showcaseHtml ? `html:${kit.showcaseHtml.length}:${name}` : null;
  const [readySource, setReadySource] = useState<string | null>(null);
  const showcaseReady = showcaseSource === null || readySource === showcaseSource;
  useEffect(() => {
    if (!showcaseSource) return;
    const timer = window.setTimeout(() => setReadySource(showcaseSource), SHOWCASE_REVEAL_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [showcaseSource]);
  const markShowcaseReady = () => setReadySource(showcaseSource);
  const collapsible = palette.length > PALETTE_STRIP_THRESHOLD;
  const paletteCollapsed = collapsible && !paletteExpanded;
  return (
    <div className={styles.overview} data-testid={dataTestId} data-variant="compact">
      <div className={styles.showcase} style={{ height: showcaseHeight }} ref={stageRef} data-testid="design-system-overview-showcase" data-ready={showcaseReady ? 'true' : 'false'}>
        {showImage ? (
          <img src={kit.referenceImageUrl} alt={`${name} design showcase`}
            onLoad={markShowcaseReady}
            onError={() => { setFailedImage(kit.referenceImageUrl ?? null); onImageError?.(); }} />
        ) : kitFrameUrl ? (
          <iframe title={`${name} component showcase`} src={kitFrameUrl} sandbox="allow-scripts" tabIndex={-1}
            onLoad={markShowcaseReady}
            style={{ width: 1280, height: frameHeight, transform: `scale(${frameScale})` }} />
        ) : kit.showcaseHtml ? (
          <iframe title={`${name} showcase`} srcDoc={showcaseDocument} sandbox="allow-scripts" tabIndex={-1}
            onLoad={markShowcaseReady}
            style={{ width: 1280, height: frameHeight, transform: `scale(${frameScale})` }} />
        ) : (
          <div className={styles.specimen} style={{ background: kit.colors[0]?.hex, color: kit.colors[0]?.hex ? (isLightHex(kit.colors[0].hex) ? '#111111' : '#ffffff') : 'var(--text)', textShadow: 'none' }}>
            <span>{t('brandDetail.typography')}</span>
            <strong style={{ fontFamily: fonts[0]?.[1] ? fontStack(fonts[0][1]) : undefined }}>{name}</strong>
            <div>{kit.colors.slice(0, 6).map((color, i) => <i key={i} style={{ background: color.hex }} />)}</div>
          </div>
        )}
        <span className={styles.showcaseSkeleton} aria-hidden="true" />
      </div>
      <section aria-label={t('brandDetail.palette')} className={`${styles.section} ${styles.palette}`}>
        <h3>{t('brandDetail.palette')}<span>{palette.length || null}</span></h3>
        {paletteCollapsed ? (
          <div className={styles.paletteStrip} aria-hidden="true">
            {palette.map(({ color }, i) => <span key={i} style={{ background: color.hex }} />)}
          </div>
        ) : null}
        {collapsible ? (
          <button
            type="button"
            className={styles.paletteToggle}
            aria-expanded={paletteExpanded}
            aria-controls={paletteListId}
            onClick={() => setPaletteExpanded((value) => !value)}
          >
            {paletteExpanded
              ? t('designSystemPicker.paletteShowLess')
              : t('designSystemPicker.paletteShowAll', { count: palette.length })}
          </button>
        ) : null}
        {palette.length ? <ul className={styles.swatches} id={paletteListId} hidden={paletteCollapsed}>
          {palette.map(({ color, notes }, i) => <li key={i} title={notes.join('\n')}>
            <i style={{ background: color.hex }} aria-hidden="true" />
            <span>{color.name || color.role || color.hex}</span>
            {(color.name || color.role || color.hex).trim().toLowerCase() !== color.hex.trim().toLowerCase() && <code>{color.hex}</code>}
          </li>)}
        </ul> : <p className={styles.eyebrow}>{t('brandDetail.noRecordedColors')}</p>}
        {kit.colors.some(color => color.usage) ? <details className={styles.disclosure}>
          <summary>{t('brandDetail.colorUsage')}</summary>
          <dl className={styles.colorDetails}>{kit.colors.filter(color => color.usage).map((color, i) => <div key={i}><dt>{color.name || color.role || color.hex}</dt><dd>{color.usage}</dd></div>)}</dl>
        </details> : null}
      </section>
      <header className={styles.heading}>
        {kit.category || kit.host ? <p className={styles.eyebrow}>{[kit.category, kit.host].filter(Boolean).join(' · ')}</p> : null}
        <h3 style={{ fontFamily: kit.typography.display ? fontStack(kit.typography.display) : undefined }}>{name}</h3>
        {description ? <p>{description}</p> : null}
      </header>
      <details className={styles.disclosure}>
        <summary>{t('brandDetail.identity')}</summary>
        <p>{kit.description || kit.tagline || name}</p>
        {kit.sourceUrl ? <a href={kit.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(kit.sourceUrl!); }}>{kit.host || kit.sourceUrl}</a> : null}
      </details>
      <section aria-label={t('brandDetail.typography')} className={styles.section}>
        <h3>{t('brandDetail.typography')}</h3>
        <div className={styles.fonts}>{fonts.map(([role, font]) => font ? (
          <div key={role}>
            <div className={styles.fontSample} style={{ fontFamily: fontStack(font), fontWeight: font.weights.includes(500) ? 500 : font.weights[0] || 400 }} aria-hidden="true">
              <strong>Aa</strong><span>{role === 'mono' ? '0123456789' : 'Abcdefghijk'}</span>
            </div>
            <div className={styles.fontMeta}><span>{role}</span><strong>{font.family}</strong><small>{font.weights.join(' / ')}</small>
              {/provisional|not identified/i.test(font.notes || '') ? <span className={styles.fontAvailability}>{t('brandDetail.fontFallback')}</span>
                : /alternative|unavailable|successor/i.test(font.notes || '') ? <span className={styles.fontAvailability}>{t('brandDetail.fontAlternative')}</span> : null}
            </div>
          </div>
        ) : null)}</div>
        {kit.fonts.some((font) => font.notes || font.fallbacks.length) ? <details className={styles.disclosure}>
          <summary>{t('brandDetail.typography')} · {t('dsCreate.notes')}</summary>
          {kit.fonts.map((font, i) => <p key={i}>{font.family}: {font.notes || font.fallbacks.join(', ')}</p>)}
        </details> : null}
      </section>
      {kit.rules || kit.layout || kit.imagery ? <details className={styles.disclosure}>
        <summary>{t('ds.guideRules')} · {t('brandDetail.imageryLayout')}</summary>
        {kit.layout?.description ? <p>{kit.layout.description}</p> : null}
        {kit.imagery?.style ? <p>{kit.imagery.style}</p> : null}
        {kit.rules ? <div className={styles.rules}><section><h4>{t('ds.guideDo')}</h4><ul>{kit.rules.do.map((rule, i) => <li key={i}>{rule}</li>)}</ul></section><section><h4>{t('ds.guideDont')}</h4><ul>{kit.rules.avoid.map((rule, i) => <li key={i}>{rule}</li>)}</ul></section></div> : null}
      </details> : null}
    </div>
  );
}
