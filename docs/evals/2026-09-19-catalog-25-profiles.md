# Design profile and index — catalog-25 run

> Copied into the repo on 2026-09-23 from the agency workspace (`work/genui-overnight-2026-09-18/route/catalog-25/REPORT.md`). The catalog like counts and the preview media paths were removed; the media and the catalog prompt text are not in this repo. This is the 25-item route corpus the family registry is measured against.

Run at 2026-09-19T17:07:43.607Z. 25/25 entries profiled successfully, 0 failed.

Rebuilt from `profiles/*.json` (`--from-profiles`): no new Jev calls, no catalog database read.

## Profiles

| id | title | spine | archetype | skin | runner-up skin (p) | format | action | family (basis, transfer) | sections p>=0.7 | components p>=0.7 | mechanics p>=0.7 | topology | ground | quality /28 | truth-risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3d-jack-portfolio-hero | 3D Jack Portfolio | TL | TL.06 | Cinematic and immersive | Experimental (0.05) | Landing page | contact | fervor (same-spine, 3) | hero, services, navigation, proof-gallery | (none) | reveal-on-scroll, cursor-following, magnetic-hover, entrance-stagger, scroll-scrubbed, horizontal-scroll, pinned-section | centered-content-stack | near-black | 17.1 | 0.95 |
| 3d-story | 3D Story | PA | PA.03 | Cinematic and immersive | Technical and utilitarian (0.01) | Landing page | signup | fervor (compatible, 2) | hero, navigation | video-background, sticky-nav | reveal-on-scroll, scroll-scrubbed | full-bleed-anchored-type | near-black | 19.1 | 0.85 |
| aetheris-voyage-hero | Aetheris Voyage | BA | none | Cinematic and immersive | Heritage and craft (0.00) | Landing page | signup | fervor (compatible, 3) | hero, navigation, stats-metrics, features | video-background, sticky-nav, floating-glass-panel, card-grid | entrance-stagger, looping-video, reveal-on-scroll | centered-content-stack | near-black | 18.2 | 0.95 |
| art-landing | Art Landing | PA | PA.01 | Cinematic and immersive | Technical and utilitarian (0.01) | Landing page | signup | fervor (compatible, 2) | hero | video-background | looping-video, scroll-scrubbed, parallax | full-bleed-anchored-type | alternating-bands | 17.1 | 0.71 |
| bl | Bloom | CS | CS.01 | Cinematic and immersive | Luxury (0.16) | Landing page | signup | (unrouted) | features, navigation, newsletter-waitlist, manifesto-statement, hero | video-background, floating-glass-panel, sticky-nav, card-grid | reveal-on-scroll, entrance-stagger, parallax, physics-lerp, scroll-scrubbed, pinned-section | full-bleed-anchored-type | near-black | 18.4 | 0.34 |
| digital-experiences | Digital Experiences | TL | TL.05 | Cinematic and immersive | Luxury (0.02) | Landing page | contact | fervor (exact, 3) | hero, stats-metrics, logo-wall, navigation | video-background, floating-glass-panel, sticky-nav, card-grid | entrance-stagger, looping-video, reveal-on-scroll | centered-content-stack | near-black | 18.3 | 0.94 |
| dreamcore-landing | Dreamcore Landing | TL | TL.05 | Cinematic and immersive | Conversational (0.00) | Landing page | read | fervor (exact, 3) | navigation | sticky-nav | entrance-stagger, scroll-scrubbed, physics-lerp, pinned-section, parallax, reveal-on-scroll | full-bleed-anchored-type | near-black | 19.2 | 0.76 |
| email-landing-page | Email Landing Page | PA | PA.01 | Cinematic and immersive | Luxury (0.01) | Landing page | signup | (unrouted) | hero, pricing, testimonials, navigation, plan-comparison, cta-band, logo-wall | video-background, toggle-switch, floating-glass-panel, filter-search | entrance-stagger, looping-video, horizontal-scroll | framed-scene | near-black | 19.8 | 0.97 |
| halo-usd-landing | USD Halo | PA | PA.04 | Cinematic and immersive | Luxury (0.26) | Landing page | signup | (unrouted) | hero, navigation, logo-wall | marquee-ticker, video-background, card-grid | marquee-drift, looping-video, auto-cycle | full-bleed-anchored-type | white-grey-template | 16.9 | 0.63 |
| health-portal | Health Portal | TL | TL.02 | Minimal and quiet | Cinematic and immersive (0.24) | Landing page | book | (unrouted) | navigation, hero, proof-gallery | number-counter, sticky-nav, floating-glass-panel, bento-grid | entrance-stagger, reveal-on-scroll, hover-signature | bento-grid | white-grey-template | 20.1 | 0.73 |
| innovation-landing | Innovation | CS | CS.01 | Cinematic and immersive | Luxury (0.02) | Landing page | signup | (unrouted) | hero, services, newsletter-waitlist, about-story | video-background, card-grid, floating-glass-panel | reveal-on-scroll, looping-video, entrance-stagger, auto-cycle | centered-content-stack | near-black | 19.3 | 0.58 |
| luxury-real-estate | Luxury Real Estate | SM | SM.03 | Luxury | Cinematic and immersive (0.06) | Landing page | none | (unrouted) | navigation, stats-metrics, hero, manifesto-statement | number-counter, sticky-nav | looping-video, pinned-section, scroll-scrubbed, entrance-stagger, reveal-on-scroll | full-bleed-anchored-type | light-paper | 19.6 | 0.84 |
| mindloop-landing | Mindloop Landing | CS | CS.01 | Cinematic and immersive | Minimal and quiet (0.04) | Landing page | signup | (unrouted) | navigation, hero, footer, cta-band, features | video-background, sticky-nav, card-grid, floating-glass-panel | reveal-on-scroll, looping-video, entrance-stagger, scroll-scrubbed | centered-content-stack | near-black | 17.6 | 0.89 |
| modern-agency | Modern Agency | TL | TL.05 | Cinematic and immersive | Experimental (0.30) | Landing page | book | fervor (exact, 3) | hero, proof-gallery, navigation | card-grid | looping-video, hover-signature | full-bleed-anchored-type | alternating-bands | 17.1 | 0.92 |
| mostar-guide | Mostar Guide | none | - | Cinematic and immersive | Technical and utilitarian (0.03) | Landing page | read | (unrouted) | navigation | carousel-slider, sticky-nav, split-screen | reveal-on-scroll, scroll-scrubbed, reduced-motion-branch, parallax, physics-lerp, pinned-section, cursor-following | full-bleed-anchored-type | near-black | 22.5 | 0.64 |
| neon-logic | Neon Logic | PA | PA.04 | Cinematic and immersive | Technical and utilitarian (0.01) | Landing page | buy | fervor (compatible, 2) | stats-metrics, footer, navigation, hero | video-background, sticky-nav, floating-glass-panel | reveal-on-scroll, looping-video, entrance-stagger, scroll-scrubbed, kinetic-type, hover-signature, physics-lerp | full-bleed-anchored-type | near-black | 18.4 | 0.91 |
| orbis-nft-landing | Orbis NFT | CO | none | Cinematic and immersive | Experimental (0.02) | Landing page | signup | (unrouted) | hero, product-grid, cta-band, navigation | video-background, card-grid, floating-glass-panel | looping-video | full-bleed-anchored-type | deep-saturated | 16.8 | 0.74 |
| portfolio-cosmic-hero | Portfolio Cosmic | TL | TL.06 | Cinematic and immersive | Technical and utilitarian (0.02) | Landing page | contact | fervor (same-spine, 3) | hero, stats-metrics, footer, navigation, blog-articles, proof-gallery | marquee-ticker, bento-grid, video-background, number-counter, card-grid, sticky-nav, floating-glass-panel | pinned-section, parallax, looping-video, marquee-drift, entrance-stagger, reveal-on-scroll, auto-cycle, scroll-scrubbed, page-transitions, hover-signature | bento-grid | near-black | 20.5 | 0.96 |
| prisma-landing | Prisma Creative Studio | LM | LM.03 | Cinematic and immersive | Catalog and grid-led (0.00) | Landing page | apply | (unrouted) | hero, features, about-story | video-background, card-grid | entrance-stagger, looping-video, reveal-on-scroll, scroll-scrubbed, kinetic-type | full-bleed-anchored-type | near-black | 21.2 | 0.96 |
| prompt-hero | PROMPT | CO | CO.01 | Cinematic and immersive | Technical and utilitarian (0.05) | Landing page | buy | (unrouted) | footer, pricing, hero | custom-cursor, video-background | reveal-on-scroll, scroll-scrubbed, cursor-following, entrance-stagger, reduced-motion-branch | full-bleed-anchored-type | alternating-bands | 19.8 | 0.89 |
| pulse-3d | Pulse 3D | LM | LM.03 | Cinematic and immersive | Experimental (0.09) | Landing page | none | (unrouted) | navigation, logo-wall, hero | marquee-ticker, video-background | scroll-scrubbed, reveal-on-scroll, marquee-drift, physics-lerp, entrance-stagger, kinetic-type, parallax, cursor-following, auto-cycle | edge-bleed-panel | alternating-bands | 19.9 | 0.68 |
| scroll-landing | Scroll Landing Page | LM | LM.02 | Cinematic and immersive | Luxury (0.01) | Landing page | buy | fervor (compatible, 3) | hero, footer, navigation, features | video-background, floating-glass-panel, sticky-nav | reveal-on-scroll, scroll-scrubbed, entrance-stagger, kinetic-type, hover-signature | full-bleed-anchored-type | near-black | 19.7 | 0.82 |
| urban-jungle-hero | Urban Jungle | TL | TL.05 | Cinematic and immersive | Data-dense (0.00) | Landing page | none | fervor (exact, 3) | navigation | video-background, marquee-ticker, floating-glass-panel, sticky-nav | scroll-scrubbed, marquee-drift, entrance-stagger, reveal-on-scroll, parallax, kinetic-type, cursor-following | full-bleed-anchored-type | near-black | 17.9 | 0.60 |
| vision-reveal | Vision Reveal | TL | TL.05 | Cinematic and immersive | Experimental (0.05) | Landing page | contact | fervor (exact, 3) | hero, navigation | floating-glass-panel | reduced-motion-branch, entrance-stagger, cursor-following, physics-lerp | full-bleed-anchored-type | light-paper | 18.6 | 0.60 |
| vortex-studio-hero | AI Designer Portfolio | TL | TL.05 | Luxury | Cinematic and immersive (0.34) | Landing page | contact | fervor (exact, 3) | pricing, testimonials, footer, hero, reviews-ratings, plan-comparison, proof-gallery | marquee-ticker, carousel-slider | entrance-stagger, reveal-on-scroll, auto-cycle, parallax, horizontal-scroll, marquee-drift, cursor-following | centered-content-stack | white-grey-template | 16.0 | 0.97 |

## Distribution

Spine: TL (9), PA (5), CS (3), LM (3), CO (2), BA (1), SM (1), none (1).
Archetype: TL.05 (6), CS.01 (3), TL.06 (2), none (2), PA.01 (2), PA.04 (2), LM.03 (2), PA.03 (1), TL.02 (1), SM.03 (1), (none) (1), CO.01 (1), LM.02 (1).
Skin: Cinematic and immersive (22), Luxury (2), Minimal and quiet (1).
Format: Landing page (25).
Topology: full-bleed-anchored-type (15), centered-content-stack (6), bento-grid (2), framed-scene (1), edge-bleed-panel (1).
Ground: near-black (15), alternating-bands (4), white-grey-template (3), light-paper (2), deep-saturated (1).
Routed family: fervor (13), (unrouted) (12).

Skin is coarse for this corpus: 22/25 entries land on "Cinematic and immersive" at mean confidence 0.91, so style search on this index should lean on topology, ground, typography, imagery and depth rather than skin.

## Agreement with the catalog's own labels

Action (catalog `action` vs `route.action`): 11/25 agree.
Motion level (catalog `motion_level` vs a mechanics/components-derived inference — a heuristic, not a second ground truth): 15/25 agree.
Slot/format (catalog `slot = full-page` vs any atlas format, all of which are full-page formats): 25/25 agree (trivial for this selection — see caveat below).

Every disagreement:

- 3d-jack-portfolio-hero: motion_level catalog=micro vs inferred=motion-led
- aetheris-voyage-hero: action catalog=none vs route.action=signup
- art-landing: action catalog=none vs route.action=signup
- bl: action catalog=none vs route.action=signup
- dreamcore-landing: action catalog=none vs route.action=read
- email-landing-page: motion_level catalog=micro vs inferred=motion-led
- halo-usd-landing: motion_level catalog=static vs inferred=motion-led
- health-portal: motion_level catalog=static vs inferred=motion-led
- innovation-landing: action catalog=none vs route.action=signup
- innovation-landing: motion_level catalog=micro vs inferred=motion-led
- luxury-real-estate: action catalog=contact vs route.action=none
- mindloop-landing: motion_level catalog=micro vs inferred=motion-led
- modern-agency: action catalog=contact vs route.action=book
- modern-agency: motion_level catalog=webgl-3d vs inferred=motion-led
- mostar-guide: action catalog=none vs route.action=read
- neon-logic: action catalog=signup vs route.action=buy
- orbis-nft-landing: action catalog=buy vs route.action=signup
- orbis-nft-landing: motion_level catalog=micro vs inferred=motion-led
- portfolio-cosmic-hero: action catalog=none vs route.action=contact
- prisma-landing: action catalog=contact vs route.action=apply
- prisma-landing: motion_level catalog=micro vs inferred=motion-led
- scroll-landing: action catalog=contact vs route.action=buy
- vision-reveal: action catalog=none vs route.action=contact
- vortex-studio-hero: motion_level catalog=micro vs inferred=motion-led

Caveat: every one of the 25 selected rows already has `slot = 'full-page'` (the selection query filters `kind = 'page'`), and every one of the atlas's 8 cross-cutting formats is itself a full-page-level format, so the format/slot agreement check above cannot fail for this particular selection — it would only discriminate on a mixed selection that also included component/hero/pricing-slot rows.

## Example find queries

`design-index find --section hero --ground near-black`

- aetheris-voyage-hero (Aetheris Voyage)
- prisma-landing (Prisma Creative Studio)
- innovation-landing (Innovation)
- portfolio-cosmic-hero (Portfolio Cosmic)
- email-landing-page (Email Landing Page)
- 3d-story (3D Story)
- mindloop-landing (Mindloop Landing)
- scroll-landing (Scroll Landing Page)
- digital-experiences (Digital Experiences)
- neon-logic (Neon Logic)
- bl (Bloom)
- 3d-jack-portfolio-hero (3D Jack Portfolio)
- urban-jungle-hero (Urban Jungle)
- mostar-guide (Mostar Guide)

`design-index find --component video-background --mechanic looping-video`

- neon-logic (Neon Logic)
- prisma-landing (Prisma Creative Studio)
- innovation-landing (Innovation)
- portfolio-cosmic-hero (Portfolio Cosmic)
- email-landing-page (Email Landing Page)
- mindloop-landing (Mindloop Landing)
- halo-usd-landing (USD Halo)
- orbis-nft-landing (Orbis NFT)
- art-landing (Art Landing)
- digital-experiences (Digital Experiences)
- aetheris-voyage-hero (Aetheris Voyage)

`design-index find --topology full-bleed-anchored-type --skin "Cinematic and immersive"`

- art-landing (Art Landing)
- scroll-landing (Scroll Landing Page)
- orbis-nft-landing (Orbis NFT)
- urban-jungle-hero (Urban Jungle)
- vision-reveal (Vision Reveal)
- 3d-story (3D Story)
- prisma-landing (Prisma Creative Studio)
- neon-logic (Neon Logic)
- prompt-hero (PROMPT)
- bl (Bloom)
- mostar-guide (Mostar Guide)
- dreamcore-landing (Dreamcore Landing)
- modern-agency (Modern Agency)
- halo-usd-landing (USD Halo)

`design-index find --component marquee-ticker --mechanic velocity-linked`

- 0 matches

Zero matches, and correctly so: this corpus's marquee mechanics register as `marquee-drift` (5 entries at p >= 0.9), never as `velocity-linked` (the highest any entry reaches is p = 0.36). The two mechanics describe different things (a continuous sideways drift vs. scroll-speed-linked motion) and this corpus's marquees are the former.

## Cost and latency

Total input tokens across 25 successful profiles: 501463.
Average ms per profile: 338.
