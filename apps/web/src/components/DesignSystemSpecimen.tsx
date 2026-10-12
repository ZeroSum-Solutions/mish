import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { fontStack, isLightHex, type DesignKit, type KitColor } from '../runtime/design-kit';
import styles from './DesignSystemSpecimen.module.css';

/** Resolve by meaning first: source order alone does not tell us canvas or ink. */
function semanticColor(colors: KitColor[], patterns: RegExp[], fallback: string): string {
  for (const pattern of patterns) {
    const color = colors.find((candidate) => pattern.test(`${candidate.role} ${candidate.name} ${candidate.usage}`));
    if (color) return color.hex;
  }
  return fallback;
}

export function DesignSystemSpecimen({ kit }: { kit: DesignKit }) {
  const t = useT();
  const bg = semanticColor(kit.colors, [/^(?:--)?(?:bg|background|canvas)(?:\s|$)/i, /page canvas|main background|canvas|paper/i], '#f8f8f7');
  const recordedInk = semanticColor(kit.colors, [/^(?:--)?(?:fg|foreground|text|ink)(?:\s|$)/i, /primary text|heading|foreground/i], isLightHex(bg) ? '#16171a' : '#f7f8f8');
  const inverse = kit.colors.find((color) => /inverse text|text.*dark backgrounds?/i.test(color.usage) && isLightHex(color.hex) !== isLightHex(bg));
  const ink = isLightHex(recordedInk) === isLightHex(bg) && inverse ? inverse.hex : recordedInk;
  const surface = semanticColor(kit.colors, [/^(?:--)?surface(?:\s|$)/i, /card (?:background|surface)|panel background|elevated surface/i], bg);
  const accent = semanticColor(kit.colors, [/calls? to action|primary action|\bcta\b/i, /^(?:--)?accent(?:\s|$)/i, /brand color|brand logo|active nav|accent/i], ink);
  const display = kit.typography.display ?? kit.typography.body;
  const body = kit.typography.body ?? display;
  const sourceImage = kit.referenceImageUrl;
  const featuredColors = [...new Set([bg, surface, ink, accent, ...kit.colors.map((color) => color.hex)])]
    .map((hex) => kit.colors.find((color) => color.hex === hex))
    .filter((color): color is KitColor => Boolean(color)).slice(0, 6);
  const variables = {
    '--specimen-bg': bg,
    '--specimen-ink': ink,
    '--specimen-surface': surface,
    '--specimen-accent': accent,
    '--specimen-on-accent': isLightHex(accent) ? '#16171a' : '#ffffff',
    '--specimen-display': display ? fontStack(display) : 'system-ui, sans-serif',
    '--specimen-body': body ? fontStack(body) : 'system-ui, sans-serif',
  } as CSSProperties;

  return (
    <figure className={styles.specimen} style={variables} data-testid="design-kit-specimen" aria-label={t('ds.specimenLabel')}>
      <figcaption className={styles.caption}>
        <span>{t('ds.specimenLabel')}</span>
        <span>{kit.colors.length} {t('brandDetail.colors')} · {body?.family ?? 'System UI'}<small>{t('ds.specimenFontNote')}</small></span>
      </figcaption>
      <div className={styles.board}>
        <div className={styles.type}>
          <span className={styles.label}>01 / {t('brandDetail.typography')}</span>
          <span className={styles.letterform}>Aa</span>
          <h3 className={styles.headline}>{kit.name}</h3>
          <p className={styles.alphabet}>ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz 0123456789</p>
          <div className={styles.fontPair}>
            <span>{display?.family ?? 'System UI'}<small>{t('ds.specimenDisplay')}</small></span>
            <span>{body?.family ?? 'System UI'}<small>{t('ds.specimenBody')}</small></span>
          </div>
        </div>
        <div className={styles.application}>
          <span className={styles.label}>02 / {t(sourceImage ? 'ds.specimenInUse' : 'ds.specimenLayout')}</span>
          {sourceImage ? (
            <img className={styles.reference} src={sourceImage} alt={kit.name} loading="lazy" />
          ) : (
            <div className={styles.example}>
              <div className={styles.exampleNav}>{t('ds.specimenWorkspace')}</div>
              <div className={styles.exampleBody}>
                <span className={styles.label}>{t('ds.specimenOverview')}</span>
                <h4>{t('ds.specimenFocus')}</h4>
                <p>{t('ds.specimenFocusBody')}</p>
                <div className={styles.demoActions} aria-hidden="true"><span>{t('ds.specimenPrimary')} ↗</span><span>{t('ds.specimenSecondary')}</span></div>
              </div>
              <div className={styles.exampleFooter}>{t('ds.specimenStatus')}</div>
            </div>
          )}
        </div>
      </div>
      {kit.colors.length > 0 ? (
        <div className={styles.palette}>
          {featuredColors.map((color, index) => (
            <div className={styles.color} key={`${color.role}-${index}`}>
              <span className={styles.colorPaint} style={{ background: color.hex }} />
              <span className={styles.colorName}>{color.name || color.role}</span>
              <code>{color.hex.toUpperCase()}</code>
            </div>
          ))}
        </div>
      ) : null}
    </figure>
  );
}
