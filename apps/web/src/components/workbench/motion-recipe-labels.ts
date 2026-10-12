import type { ResourceResult } from '@mish/contracts';
import type { Dict } from '../../i18n/types';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;
const LABELS = {
  'hero-lines': { title: 'workbench.motion.hero-lines.title', purpose: 'workbench.motion.hero-lines.purpose', trigger: 'workbench.motion.hero-lines.trigger', reducedMotion: 'workbench.motion.hero-lines.reducedMotion' },
  'hero-words': { title: 'workbench.motion.hero-words.title', purpose: 'workbench.motion.hero-words.purpose', trigger: 'workbench.motion.hero-words.trigger', reducedMotion: 'workbench.motion.hero-words.reducedMotion' },
  'scroll-parallax': { title: 'workbench.motion.scroll-parallax.title', purpose: 'workbench.motion.scroll-parallax.purpose', trigger: 'workbench.motion.scroll-parallax.trigger', reducedMotion: 'workbench.motion.scroll-parallax.reducedMotion' },
  'card-stagger': { title: 'workbench.motion.card-stagger.title', purpose: 'workbench.motion.card-stagger.purpose', trigger: 'workbench.motion.card-stagger.trigger', reducedMotion: 'workbench.motion.card-stagger.reducedMotion' },
  'image-mask': { title: 'workbench.motion.image-mask.title', purpose: 'workbench.motion.image-mask.purpose', trigger: 'workbench.motion.image-mask.trigger', reducedMotion: 'workbench.motion.image-mask.reducedMotion' },
  'number-counter': { title: 'workbench.motion.number-counter.title', purpose: 'workbench.motion.number-counter.purpose', trigger: 'workbench.motion.number-counter.trigger', reducedMotion: 'workbench.motion.number-counter.reducedMotion' },
  'sticky-story': { title: 'workbench.motion.sticky-story.title', purpose: 'workbench.motion.sticky-story.purpose', trigger: 'workbench.motion.sticky-story.trigger', reducedMotion: 'workbench.motion.sticky-story.reducedMotion' },
  'logo-marquee': { title: 'workbench.motion.logo-marquee.title', purpose: 'workbench.motion.logo-marquee.purpose', trigger: 'workbench.motion.logo-marquee.trigger', reducedMotion: 'workbench.motion.logo-marquee.reducedMotion' },
  'magnetic-button': { title: 'workbench.motion.magnetic-button.title', purpose: 'workbench.motion.magnetic-button.purpose', trigger: 'workbench.motion.magnetic-button.trigger', reducedMotion: 'workbench.motion.magnetic-button.reducedMotion' },
  'page-transition': { title: 'workbench.motion.page-transition.title', purpose: 'workbench.motion.page-transition.purpose', trigger: 'workbench.motion.page-transition.trigger', reducedMotion: 'workbench.motion.page-transition.reducedMotion' },
  'section-pin': { title: 'workbench.motion.section-pin.title', purpose: 'workbench.motion.section-pin.purpose', trigger: 'workbench.motion.section-pin.trigger', reducedMotion: 'workbench.motion.section-pin.reducedMotion' },
  'cursor-follower': { title: 'workbench.motion.cursor-follower.title', purpose: 'workbench.motion.cursor-follower.purpose', trigger: 'workbench.motion.cursor-follower.trigger', reducedMotion: 'workbench.motion.cursor-follower.reducedMotion' },
  'hover-tilt': { title: 'workbench.motion.hover-tilt.title', purpose: 'workbench.motion.hover-tilt.purpose', trigger: 'workbench.motion.hover-tilt.trigger', reducedMotion: 'workbench.motion.hover-tilt.reducedMotion' },
  'image-crossfade': { title: 'workbench.motion.image-crossfade.title', purpose: 'workbench.motion.image-crossfade.purpose', trigger: 'workbench.motion.image-crossfade.trigger', reducedMotion: 'workbench.motion.image-crossfade.reducedMotion' },
} as const satisfies Record<string, Record<'title' | 'purpose' | 'trigger' | 'reducedMotion', keyof Dict>>;

/** Localize catalog presentation only; ref identities, digests and authored unit bytes stay intact. */
export function localizeMotionRecipe(resource: ResourceResult, t: Translate): ResourceResult {
  if (resource.ref.sourceId !== 'gsap') return resource;
  const match = /^(.+)-(html|react)$/u.exec(resource.ref.itemId);
  if (!match || !Object.hasOwn(LABELS, match[1]!)) return resource;
  const labels = LABELS[match[1] as keyof typeof LABELS];
  const title = t(labels.title);
  const target = match[2] === 'html' ? 'HTML' : 'React';
  return {
    ...resource, title: `${title} (${target})`,
    sourceAttribution: { ...resource.sourceAttribution, title: resource.sourceAttribution.title.replace(/ · .+$/u, ` · ${title}`) },
    compatibility: { ...resource.compatibility, reason: t(match[2] === 'html' ? 'workbench.motion.htmlCompatibility' : 'workbench.motion.reactCompatibility') },
    fitReasons: resource.fitReasons.map(reason => {
      if (reason.startsWith('Purpose: ')) return t('workbench.motion.purpose', { value: t(labels.purpose) });
      if (reason.startsWith('Trigger: ')) return t('workbench.motion.trigger', { value: t(labels.trigger) });
      if (reason.startsWith('Reduced motion: ')) return t('workbench.motion.reducedMotion', { value: t(labels.reducedMotion) });
      if (reason.startsWith('Cleanup: ')) return t('workbench.motion.cleanup');
      if (reason.startsWith('Plugins: ')) return t('workbench.motion.plugins', { value: reason.slice(9) === 'none (GSAP core only)' ? t('workbench.motion.coreOnly') : reason.slice(9) });
      if (reason.startsWith('Adapter: ')) return t('workbench.motion.adapter', { value: reason.slice(9) });
      return reason;
    }),
  };
}

/** Variant titles carry the technical adapter suffix; display labels are not resource identities. */
export function localizeMotionRecipeVariantTitle(resource: ResourceResult, title: string, t: Translate): string {
  if (resource.ref.sourceId !== 'gsap') return title;
  const id = resource.ref.itemId.replace(/-(html|react)$/u, '');
  if (!Object.hasOwn(LABELS, id)) return title;
  return title.replace(/^.+(?= \((?:HTML|React)\)$)/u, t(LABELS[id as keyof typeof LABELS].title));
}
