import GsapSectionEntrance from './GsapSectionEntrance';
import GsapScrollStory from './GsapScrollStory';
import GsapFlipFilter from './GsapFlipFilter';
import GsapSvgFeedback from './GsapSvgFeedback';

import GsapHeroLines from './GsapHeroLines';
import GsapHeroWords from './GsapHeroWords';
import GsapScrollParallax from './GsapScrollParallax';
import GsapCardStagger from './GsapCardStagger';
import GsapImageMask from './GsapImageMask';
import GsapNumberCounter from './GsapNumberCounter';

import GsapStickyStory from './GsapStickyStory';
import GsapLogoMarquee from './GsapLogoMarquee';
import GsapMagneticButton from './GsapMagneticButton';
import GsapPageTransition from './GsapPageTransition';
import GsapSectionPin from './GsapSectionPin';
import GsapCursorFollower from './GsapCursorFollower';
import GsapHoverTilt from './GsapHoverTilt';
import GsapImageCrossfade from './GsapImageCrossfade';

// G02 fixture: a plain React 18 + TypeScript project rendering the registered
// adopted GSAP units exactly as apply writes them next to this entry.
export default function App() {
  return (
    <main>
      <GsapSectionEntrance />
      <GsapScrollStory />
      <GsapFlipFilter />
      <GsapSvgFeedback />
      <GsapHeroLines />
      <GsapHeroWords />
      <GsapScrollParallax />
      <GsapCardStagger />
      <GsapImageMask />
      <GsapNumberCounter />
      <GsapStickyStory />
      <GsapLogoMarquee />
      <GsapMagneticButton />
      <GsapPageTransition />
      <GsapSectionPin />
      <GsapCursorFollower />
      <GsapHoverTilt />
      <GsapImageCrossfade />
    </main>
  );
}
