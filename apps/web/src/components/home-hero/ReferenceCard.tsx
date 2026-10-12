// One stored design-index profile as a Home card.
//
// The preview is remote catalog media, so it goes through `MediaSurface`: it
// mounts only near the viewport, sends no referrer, decodes lazily, and a
// dead URL falls back to the same generated title card the five preview-less
// profiles render. Captions show a short title and "Reference" with the routed
// family (or "No family yet"). Tooltips and the accessible name retain the
// full title, spine and archetype. The profiled source text is never shown.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PreviewCard, PreviewCardMedia, PreviewCardCaption, PreviewCardTitle, PreviewCardDescription,
} from '@open-design/components';
import type { DesignProfile } from '@open-design/contracts';
import { useT } from '../../i18n';
import { MediaSurface } from '../plugins-home/cards/MediaSurface';
import { useInView } from '../plugins-home/useInView';
import { ReferenceTitleSurface } from './ReferenceTitleSurface';
import { compactCardTitle } from './card-labels';
import type { ReferenceMedia } from '../plugins-home/websiteCards';
import {
  archetypeNameForId,
  referenceArchetypeId,
  referenceFamilyId,
  referenceMedia,
  referenceSpineCode,
  referenceTitle,
  SPINE_NONE,
} from '../plugins-home/websiteCards';

/**
 * The URLs a card is currently trying to load, as one comparable string.
 *
 * A stored profile can be replaced in place (`od design-index add --replace`)
 * and keep its digest while gaining new preview URLs. Cards are keyed by
 * digest, so this component survives that swap: a failure recorded against the
 * old URLs must not condemn the new ones.
 */
function mediaIdentity(media: ReferenceMedia): string {
  if (!media) return '';
  return media.kind === 'video'
    ? `video|${media.videoUrl}|${media.poster ?? ''}`
    : `image|${media.poster}`;
}

interface Props {
  profile: DesignProfile;
  disabled?: boolean;
  onPick: (profile: DesignProfile) => void;
}

/** `TL · Local appointment business · watson`, or the no-family notice. */
export function referenceCardLine(profile: DesignProfile, noFamilyLabel: string): string {
  const parts: string[] = [];
  const spine = referenceSpineCode(profile);
  if (spine !== SPINE_NONE) parts.push(spine);
  const archetypeId = referenceArchetypeId(profile);
  if (archetypeId) parts.push(archetypeNameForId(archetypeId) ?? archetypeId);
  parts.push(referenceFamilyId(profile) ?? noFamilyLabel);
  return parts.join(' · ');
}

export function ReferenceCard({ profile, disabled = false, onPick }: Props) {
  const t = useT();
  const [mediaFailed, setMediaFailed] = useState(false);
  const media = useMemo(() => referenceMedia(profile), [profile]);
  const identity = mediaIdentity(media);
  useEffect(() => {
    setMediaFailed(false);
  }, [identity]);
  // Mount the clip/poster a few hundred pixels ahead of the viewport; only
  // decode and play once the card is truly on screen.
  const { ref: nearRef, inView } = useInView<HTMLSpanElement>({ rootMargin: '360px', once: false });
  const { ref: visibleRef, inView: visible } = useInView<HTMLSpanElement>({
    rootMargin: '0px',
    once: false,
  });
  const setPreviewRef = useCallback(
    (node: HTMLSpanElement | null) => {
      nearRef.current = node;
      visibleRef.current = node;
    },
    [nearRef, visibleRef],
  );

  const title = referenceTitle(profile) || t('designIndex.untitled');
  const line = referenceCardLine(profile, t('homeHero.reference.noFamily'));
  const showMedia = media !== null && !mediaFailed;

  return (
    <span className="home-hero__plugin-preset-cell" role="listitem">
      <PreviewCard
        type="button"
        className="home-hero__plugin-preset"
        data-testid="home-hero-design-reference"
        data-reference-id={profile.source?.digest ?? ''}
        aria-label={`${title} — ${t('homeHero.reference.badge')} · ${line}`}
        disabled={disabled}
        onClick={() => onPick(profile)}
      >
        <PreviewCardMedia className="home-hero__plugin-preset-preview" aria-hidden ref={setPreviewRef}>
          {showMedia ? (
            <div
              className="plugins-home__preview plugins-home__preview--media"
              data-preview-kind="media"
            >
              <MediaSurface
                preview={{
                  kind: 'media',
                  mediaType: media.kind === 'video' ? 'video' : 'image',
                  poster: media.poster ?? null,
                  videoUrl: media.kind === 'video' ? media.videoUrl : null,
                  audioUrl: null,
                  imageOnly: media.kind === 'image',
                }}
                pluginTitle={title}
                inView={inView}
                visible={visible}
                autoPlayInView={media.kind === 'video'}
                // Catalog clips come from a third-party host: retrieve them
                // through a request that states a referrer policy, which the
                // <video> element itself cannot.
                clipFetch="no-referrer"
                onMediaError={() => setMediaFailed(true)}
              />
            </div>
          ) : (
            <ReferenceTitleSurface profile={profile} title={title} />
          )}
        </PreviewCardMedia>
        <PreviewCardCaption className="home-hero__plugin-preset-meta">
          <PreviewCardTitle className="home-hero__plugin-preset-title" title={title}>
            {compactCardTitle(title)}
          </PreviewCardTitle>
          {/* The reference badge shares the card's single metadata line. */}
          <PreviewCardDescription className="home-hero__plugin-preset-subtitle" title={`${t('homeHero.reference.badge')} · ${line}`}>
            {`${t('homeHero.reference.badge')} · ${referenceFamilyId(profile) ?? t('homeHero.reference.noFamily')}`}
          </PreviewCardDescription>
        </PreviewCardCaption>
      </PreviewCard>
    </span>
  );
}
