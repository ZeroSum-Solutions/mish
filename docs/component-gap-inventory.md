# Component gap inventory

Snapshot: 2026-10-08. Baseline: `f65f2117dc930aaeb22137a606ac1522c06717a6` on `codex/t5-component-harvest`.

Public discovery: [React Bits names index](https://reactbits.dev/get-started/index) and [21st community index](https://21st.dev/community/components). The React Bits index exposes 181 unique entries in the four requested categories. Its homepage advertises a larger total; this inventory covers the visible four-category index, excluding separate micro-interaction products. The 21st sample contains 101 unique listings across its featured, newest, popular, and category sections. It is a public-index sample, not a claim to enumerate the entire community. Names and URLs are retained in `packages/genui-catalog/data/harvest-index-snapshot.json`.

The React Bits homepage fetch included an incidental usage example. No implementation source or individual component documentation was opened or used. Subsequent discovery extracted index anchors only. Every behavior summary below is authored from the index name, or comes from existing local catalog metadata; descriptions are not upstream implementation specifications.

Baseline disk coverage: 63 GenUI entries (62 implemented; `scroll-morph-hero` is planned), 22 registered 21st originals, and 311 Cult rows. The requested estimate of 26 originals differs from the checked-in manifest. Cult is covered as licensed and bundled, as requested; that does not mean every Cult row has a runnable GenUI adapter or independent ownership. Existing six Cult-derived GenUI effects remain licensed.

“Already covered” refers to baseline runnable GenUI code, a registered original, or a named licensed Cult row. Equivalents are identified explicitly. “Added” identifies this branch's 14 implementations; `animated-content` also handles Fade Content at distance zero and `logo-loop` handles a simple marquee. Value and S/M/L are planning estimates of client-site reuse and dependency-free implementation effort. Jev 1.13 reviewed the 14 candidate briefs: it strongly favored Count Up, Animated Content, and Animated List; decorative variants were mostly medium. These are text judgments, not visual scores. Remaining estimates apply the same rubric: content/navigation/social proof high; quiet decoration medium; cursor spectacles and app-only behavior low.

Each added effect has scoped ESM/CSS, metadata, an offline preview, lifecycle tests, and a NOTICE record. Finite effects settle within four seconds; rotating text and logo loops expose pause controls. All added entries use `licenceDecision: clean-room`; source licences are explicitly unassessed because no upstream licence or source was fetched.

## React Bits

| Name | Source | Category | Behavior summary (authored) | Already covered | Coverage evidence | Value | Size | Added |
|---|---|---|---|---|---|---|---|---|
| Tech Text | [React](https://reactbits.dev/text-animations/tech-text) | text-animations | Headline appears through technical glyph styling. | no | — | med | M | — |
| Text Loop | [React](https://reactbits.dev/text-animations/text-loop) | text-animations | Headline alternates between text phrases. | no | — | med | M | — |
| Masked Heading | [React](https://reactbits.dev/text-animations/masked-heading) | text-animations | A mask reveals a heading. | yes | genui:masked-heading | med | M | — |
| Particle Text | [React](https://reactbits.dev/text-animations/particle-text) | text-animations | Particles gather into letter forms. | yes | genui:particle-text | med | L | — |
| Split Flap Text | [React](https://reactbits.dev/text-animations/split-flap-text) | text-animations | Letter panels flip to new characters. | yes | genui:split-flap-text | med | M | — |
| Warp Text | [React](https://reactbits.dev/text-animations/warp-text) | text-animations | Letter shapes bend or distort. | yes | genui:warp-text | med | M | — |
| Stroke Text | [React](https://reactbits.dev/text-animations/stroke-text) | text-animations | Text draws through its outlines. | yes | genui:stroke-text | med | M | — |
| Depth Text | [React](https://reactbits.dev/text-animations/depth-text) | text-animations | Letters have layered depth. | no | — | med | M | — |
| Fold Text | [React](https://reactbits.dev/text-animations/fold-text) | text-animations | Letters unfold into view. | no | — | med | M | — |
| Echo Text | [React](https://reactbits.dev/text-animations/echo-text) | text-animations | Repeated letter silhouettes trail the text. | no | — | med | M | — |
| Split Text | [React](https://reactbits.dev/text-animations/split-text) | text-animations | Letters or words enter in a stagger. | yes | genui:split-text | med | M | — |
| Blur Text | [React](https://reactbits.dev/text-animations/blur-text) | text-animations | Blurred words settle into focus. | yes | genui:blur-text | med | M | — |
| Circular Text | [React](https://reactbits.dev/text-animations/circular-text) | text-animations | Text runs around a circular path. | no | — | med | M | — |
| Text Type | [React](https://reactbits.dev/text-animations/text-type) | text-animations | Characters type into a headline. | no | — | high | M | text-type |
| Shuffle | [React](https://reactbits.dev/text-animations/shuffle) | text-animations | Characters rearrange before resolving. | no | — | med | M | — |
| Shiny Text | [React](https://reactbits.dev/text-animations/shiny-text) | text-animations | A light sheen moves across text. | yes | genui:shiny-text | med | S | — |
| Text Pressure | [React](https://reactbits.dev/text-animations/text-pressure) | text-animations | Letter widths respond to proximity. | no | — | med | M | — |
| Curved Loop | [React](https://reactbits.dev/text-animations/curved-loop) | text-animations | A repeating line of text follows a curve. | no | — | med | M | — |
| Fuzzy Text | [React](https://reactbits.dev/text-animations/fuzzy-text) | text-animations | Text edges shimmer with a fuzzy distortion. | no | — | low | M | — |
| Gradient Text | [React](https://reactbits.dev/text-animations/gradient-text) | text-animations | A gradient colors a headline. | no | — | high | S | gradient-text |
| Falling Text | [React](https://reactbits.dev/text-animations/falling-text) | text-animations | Letters fall into a loose arrangement. | no | — | low | M | — |
| Text Cursor | [React](https://reactbits.dev/text-animations/text-cursor) | text-animations | Letter decoration follows the cursor. | no | — | low | L | — |
| Decrypted Text | [React](https://reactbits.dev/text-animations/decrypted-text) | text-animations | Scrambled glyphs resolve into readable text. | no | — | med | M | decrypted-text |
| True Focus | [React](https://reactbits.dev/text-animations/true-focus) | text-animations | A highlight moves between focused words. | yes | genui:true-focus | med | M | — |
| Scroll Float | [React](https://reactbits.dev/text-animations/scroll-float) | text-animations | Text rises with scrolling. | no | — | med | M | — |
| Scroll Reveal | [React](https://reactbits.dev/text-animations/scroll-reveal) | text-animations | Text becomes readable as it scrolls into view. | yes | genui:scroll-reveal | med | M | — |
| ASCII Text | [React](https://reactbits.dev/text-animations/ascii-text) | text-animations | A text treatment uses character-like patterns. | no | — | low | M | — |
| Scrambled Text | [React](https://reactbits.dev/text-animations/scrambled-text) | text-animations | Letters briefly scramble before resolving. | no | — | med | M | — |
| Rotating Text | [React](https://reactbits.dev/text-animations/rotating-text) | text-animations | A heading cycles through alternate words. | no | — | med | M | rotating-text |
| Glitch Text | [React](https://reactbits.dev/text-animations/glitch-text) | text-animations | Text briefly offsets into glitch layers. | no | — | low | M | — |
| Scroll Velocity | [React](https://reactbits.dev/text-animations/scroll-velocity) | text-animations | Scrolling speed changes a text strip's movement. | no | — | med | M | — |
| Variable Proximity | [React](https://reactbits.dev/text-animations/variable-proximity) | text-animations | Variable-font letters change near a pointer. | no | — | med | M | — |
| Count Up | [React](https://reactbits.dev/text-animations/count-up) | text-animations | A number counts toward its final value. | no | — | high | S | count-up |
| Crystalized Ball | [React](https://reactbits.dev/animations/crystalized-ball) | animations | A crystalline orb catches moving light. | no | — | low | M | — |
| Electric Logo | [React](https://reactbits.dev/animations/electric-logo) | animations | An electrical glow outlines a logo. | no | — | med | M | — |
| Dither Veil | [React](https://reactbits.dev/animations/dither-veil) | animations | A stippled screen reveals the content. | no | — | med | M | — |
| Glow Cursor | [React](https://reactbits.dev/animations/glow-cursor) | animations | A soft glow follows the pointer. | no | — | low | L | — |
| Scroll Expand | [React](https://reactbits.dev/animations/scroll-expand) | animations | Content expands while scrolling. | yes | genui:scroll-expand | med | M | — |
| Ripple Distortion | [React](https://reactbits.dev/animations/ripple-distortion) | animations | A surface distorts with ripples. | yes | genui:ripple-distortion | med | M | — |
| Elastic Mesh | [React](https://reactbits.dev/animations/elastic-mesh) | animations | A flexible mesh deforms and settles. | no | — | med | M | — |
| Swarm Cursor | [React](https://reactbits.dev/animations/swarm-cursor) | animations | A cluster of points follows the pointer. | no | — | low | L | — |
| Halftone Reveal | [React](https://reactbits.dev/animations/halftone-reveal) | animations | A dot pattern reveals the content. | yes | genui:halftone-reveal | med | M | — |
| Pixel Swap | [React](https://reactbits.dev/animations/pixel-swap) | animations | Pixel blocks switch visual states. | no | — | med | M | — |
| Cursor Grid | [React](https://reactbits.dev/animations/cursor-grid) | animations | A grid reacts near the pointer. | no | — | low | L | — |
| Animated Content | [React](https://reactbits.dev/animations/animated-content) | animations | Content enters through a short reveal. | no | — | high | M | animated-content |
| Fade Content | [React](https://reactbits.dev/animations/fade-content) | animations | Content fades into view. | no | — | high | S | animated-content |
| Electric Border | [React](https://reactbits.dev/animations/electric-border) | animations | An electrical glow traces a border. | no | — | med | M | — |
| Orbit Images | [React](https://reactbits.dev/animations/orbit-images) | animations | Images orbit around a center. | no | — | low | M | — |
| Pixel Transition | [React](https://reactbits.dev/animations/pixel-transition) | animations | Tiles reveal an alternate visual face. | no | — | med | M | pixel-transition |
| Glare Hover | [React](https://reactbits.dev/animations/glare-hover) | animations | A reflected light band crosses a hovered surface. | yes | genui:glare-hover | med | S | — |
| Antigravity | [React](https://reactbits.dev/animations/antigravity) | animations | Particles move away from a nearby pointer. | no | — | low | M | — |
| Logo Loop | [React](https://reactbits.dev/animations/logo-loop) | animations | Client marks repeat in a moving strip. | no | — | high | M | logo-loop |
| Target Cursor | [React](https://reactbits.dev/animations/target-cursor) | animations | A cursor marker follows interactive targets. | no | — | low | L | — |
| Magic Rings | [React](https://reactbits.dev/animations/magic-rings) | animations | Concentric decorative rings move. | no | — | med | M | — |
| Laser Flow | [React](https://reactbits.dev/animations/laser-flow) | animations | A narrow illuminated stream flows through a scene. | no | — | low | M | — |
| Magnet Lines | [React](https://reactbits.dev/animations/magnet-lines) | animations | Short lines orient toward a pointer. | no | — | med | M | — |
| Ghost Cursor | [React](https://reactbits.dev/animations/ghost-cursor) | animations | A translucent trail follows the pointer. | no | — | low | L | — |
| Gradual Blur | [React](https://reactbits.dev/animations/gradual-blur) | animations | A blur increases progressively at an edge. | yes | genui:gradual-blur | med | M | — |
| Click Spark | [React](https://reactbits.dev/animations/click-spark) | animations | A click emits a short decorative spark. | no | — | med | M | — |
| Magnet | [React](https://reactbits.dev/animations/magnet) | animations | A control shifts slightly toward a pointer. | no | — | med | M | magnet |
| Strands | [React](https://reactbits.dev/animations/strands) | animations | Layered filament curves move. | no | — | med | M | — |
| Sticker Peel | [React](https://reactbits.dev/animations/sticker-peel) | animations | A corner appears to lift from a surface. | no | — | med | M | — |
| Pixel Trail | [React](https://reactbits.dev/animations/pixel-trail) | animations | A pixel trail follows pointer movement. | no | — | med | M | — |
| Cubes | [React](https://reactbits.dev/animations/cubes) | animations | A grid of cubes responds with depth changes. | no | — | med | M | — |
| Metallic Paint | [React](https://reactbits.dev/animations/metallic-paint) | animations | A surface reflects a metallic sheen. | yes | genui:metallic-paint | med | M | — |
| Noise | [React](https://reactbits.dev/animations/noise) | animations | A fine grain texture overlays a surface. | no | — | med | S | — |
| Shape Blur | [React](https://reactbits.dev/animations/shape-blur) | animations | A blurred shape responds to pointer movement. | no | — | med | M | — |
| Crosshair | [React](https://reactbits.dev/animations/crosshair) | animations | Crosshair lines track a pointer. | no | — | med | M | — |
| Image Trail | [React](https://reactbits.dev/animations/image-trail) | animations | Images trail behind pointer movement. | no | — | med | M | — |
| Ribbons | [React](https://reactbits.dev/animations/ribbons) | animations | Ribbon shapes follow a path. | no | — | med | M | — |
| Splash Cursor | [React](https://reactbits.dev/animations/splash-cursor) | animations | Fluid-like splashes follow the cursor. | no | — | low | L | — |
| Meta Balls | [React](https://reactbits.dev/animations/meta-balls) | animations | Nearby soft blobs merge visually. | no | — | med | M | — |
| Blob Cursor | [React](https://reactbits.dev/animations/blob-cursor) | animations | A soft blob follows the pointer. | no | — | low | L | — |
| Star Border | [React](https://reactbits.dev/animations/star-border) | animations | A luminous highlight follows a border. | no | — | med | S | star-border |
| Holo Card | [React](https://reactbits.dev/components/holo-card) | components | A card reflects a holographic color treatment. | no | — | med | M | — |
| Circular Carousel | [React](https://reactbits.dev/components/circular-carousel) | components | Items move around a circular track. | no | — | med | L | — |
| Flex Carousel | [React](https://reactbits.dev/components/flex-carousel) | components | Panels expand within a flexible carousel. | no | — | med | L | — |
| Infinite Spiral | [React](https://reactbits.dev/components/infinite-spiral) | components | Items move along a spiral path. | no | — | low | L | — |
| Depth Carousel | [React](https://reactbits.dev/components/depth-carousel) | components | Cards move through a perspective deck. | yes | genui:depth-carousel | med | L | — |
| Morph Slider | [React](https://reactbits.dev/components/morph-slider) | components | Slides change through a morphing transition. | no | — | med | L | — |
| Drift Wall | [React](https://reactbits.dev/components/drift-wall) | components | A wall of images drifts across the view. | no | — | med | M | — |
| Accordion Gallery | [React](https://reactbits.dev/components/accordion-gallery) | components | A selected gallery panel expands. | yes | genui:accordion-gallery | med | L | — |
| Specular Button | [React](https://reactbits.dev/components/specular-button) | components | A button reflects a directional highlight. | no | — | med | S | — |
| Option Wheel | [React](https://reactbits.dev/components/option-wheel) | components | Options arrange around a circular selector. | no | — | med | M | — |
| Curved Input | [React](https://reactbits.dev/components/curved-input) | components | An input follows a curved visual form. | no | — | med | M | — |
| Line Sidebar | [React](https://reactbits.dev/components/line-sidebar) | components | A sidebar selection connects to a line indicator. | no | — | med | M | — |
| Animated List | [React](https://reactbits.dev/components/animated-list) | components | List rows enter in sequence. | no | — | high | M | animated-list |
| Scroll Stack | [React](https://reactbits.dev/components/scroll-stack) | components | Cards stack as the page scrolls. | yes | genui:scroll-stack | med | M | — |
| Bubble Menu | [React](https://reactbits.dev/components/bubble-menu) | components | Menu items emerge as rounded bubbles. | no | — | med | M | — |
| Magic Bento | [React](https://reactbits.dev/components/magic-bento) | components | A tile grid combines hover lights and small motion. | yes | genui:magic-bento | med | M | — |
| Circular Gallery | [React](https://reactbits.dev/components/circular-gallery) | components | Gallery items follow a curved track. | yes | genui:circular-gallery | med | L | — |
| Reflective Card | [React](https://reactbits.dev/components/reflective-card) | components | A card shows a moving reflective surface. | yes | genui:reflective-card | med | M | — |
| Card Nav | [React](https://reactbits.dev/components/card-nav) | components | Navigation opens as a collection of cards. | yes | genui:card-nav | med | M | — |
| Stack | [React](https://reactbits.dev/components/stack) | components | Cards form a browsable deck. | yes | genui:stack | med | M | — |
| Fluid Glass | [React](https://reactbits.dev/components/fluid-glass) | components | A glass surface distorts what is behind it. | yes | genui:fluid-glass | med | L | — |
| Pill Nav | [React](https://reactbits.dev/components/pill-nav) | components | A rounded indicator follows navigation selection. | yes | genui:pill-nav | med | M | — |
| Tilted Card | [React](https://reactbits.dev/components/tilted-card) | components | A card tilts toward a hovering pointer. | yes | genui:tilted-card | med | M | — |
| Masonry | [React](https://reactbits.dev/components/masonry) | components | Images arrange into unequal-height columns. | yes | genui:masonry | med | M | — |
| Glass Surface | [React](https://reactbits.dev/components/glass-surface) | components | A translucent surface softens its backdrop. | yes | genui:glass-surface | med | M | — |
| Dome Gallery | [React](https://reactbits.dev/components/dome-gallery) | components | Gallery images wrap around a dome-like layout. | yes | genui:dome-gallery | med | L | — |
| Chroma Grid | [React](https://reactbits.dev/components/chroma-grid) | components | A gallery reveals color near the pointer. | yes | genui:chroma-grid | med | M | — |
| Folder | [React](https://reactbits.dev/components/folder) | components | A folder-shaped control reveals its contents. | no | — | med | M | — |
| Staggered Menu | [React](https://reactbits.dev/components/staggered-menu) | components | Menu rows enter with staggered timing. | yes | genui:staggered-menu | med | M | — |
| Model Viewer | [React](https://reactbits.dev/components/model-viewer) | components | A model-like object can be viewed in perspective. | yes | genui:model-viewer | med | L | — |
| Lanyard | [React](https://reactbits.dev/components/lanyard) | components | A hanging card swings from a strap. | no | — | low | M | — |
| Profile Card | [React](https://reactbits.dev/components/profile-card) | components | A profile presents identity and contact details. | no | — | high | M | — |
| Dock | [React](https://reactbits.dev/components/dock) | components | A row of shortcuts expands on hover or focus. | no | — | med | M | — |
| Gooey Nav | [React](https://reactbits.dev/components/gooey-nav) | components | A rounded navigation indicator deforms between items. | no | — | med | M | — |
| Pixel Card | [React](https://reactbits.dev/components/pixel-card) | components | A pixel field lights up within a card. | no | — | med | M | — |
| Carousel | [React](https://reactbits.dev/components/carousel) | components | A user can browse one slide at a time. | no | — | high | L | — |
| Spotlight Card | [React](https://reactbits.dev/components/spotlight-card) | components | A local spotlight follows the pointer across a card. | yes | genui:spotlight-card | med | M | — |
| Border Glow | [React](https://reactbits.dev/components/border-glow) | components | A border lights up near the pointer. | no | — | high | S | — |
| Flying Posters | [React](https://reactbits.dev/components/flying-posters) | components | Poster panels move through perspective. | yes | genui:flying-posters | med | M | — |
| Card Swap | [React](https://reactbits.dev/components/card-swap) | components | Cards exchange their position in a deck. | yes | genui:card-swap | med | M | — |
| Glass Icons | [React](https://reactbits.dev/components/glass-icons) | components | Icons sit within translucent glass tiles. | no | — | med | M | — |
| Decay Card | [React](https://reactbits.dev/components/decay-card) | components | A card image distorts as it moves. | yes | genui:decay-card | med | M | — |
| Flowing Menu | [React](https://reactbits.dev/components/flowing-menu) | components | A hovered menu row reveals a moving visual strip. | yes | genui:flowing-menu | med | M | — |
| Elastic Slider | [React](https://reactbits.dev/components/elastic-slider) | components | A slider has a spring-like visual response. | no | — | med | M | — |
| Counter | [React](https://reactbits.dev/components/counter) | components | Digits transition when a count changes. | no | — | med | M | — |
| Infinite Menu | [React](https://reactbits.dev/components/infinite-menu) | components | Menu choices move through a continuous spatial layout. | no | — | low | L | — |
| Stepper | [React](https://reactbits.dev/components/stepper) | components | A staged flow shows progress between steps. | no | — | high | M | — |
| Bounce Cards | [React](https://reactbits.dev/components/bounce-cards) | components | Cards enter with a short bounce. | no | — | med | M | — |
| Pattern Waves | [React](https://reactbits.dev/backgrounds/pattern-waves) | backgrounds | Repeating patterned curves form a moving field. | no | — | med | M | — |
| Micro Slats | [React](https://reactbits.dev/backgrounds/micro-slats) | backgrounds | Fine parallel slats form a shifting background. | no | — | med | M | — |
| Shape Waves | [React](https://reactbits.dev/backgrounds/shape-waves) | backgrounds | Repeated shapes move in a wave pattern. | no | — | med | M | — |
| Aero Shards | [React](https://reactbits.dev/backgrounds/aero-shards) | backgrounds | Translucent shards float through a scene. | no | — | med | M | — |
| Ghost Fibers | [React](https://reactbits.dev/backgrounds/ghost-fibers) | backgrounds | Fine translucent fibers flow through a field. | no | — | med | M | — |
| CRT Warp | [React](https://reactbits.dev/backgrounds/crt-warp) | backgrounds | A screen-like field bends with CRT distortion. | no | — | med | M | — |
| Molten Metal | [React](https://reactbits.dev/backgrounds/molten-metal) | backgrounds | Liquid-like metallic shapes flow across a background. | yes | genui:molten-metal | med | M | — |
| Gradient Waves | [React](https://reactbits.dev/backgrounds/gradient-waves) | backgrounds | Colored gradients move through wave forms. | no | — | med | M | — |
| Web Threads | [React](https://reactbits.dev/backgrounds/web-threads) | backgrounds | Fine connected threads form a web-like field. | no | — | med | M | — |
| Topography | [React](https://reactbits.dev/backgrounds/topography) | backgrounds | Contour lines create a topographic field. | no | — | med | M | — |
| Light Tunnel | [React](https://reactbits.dev/backgrounds/light-tunnel) | backgrounds | Illuminated geometry forms a tunnel. | no | — | med | M | — |
| Sliced Waves | [React](https://reactbits.dev/backgrounds/sliced-waves) | backgrounds | Offset slices form a moving wave. | no | — | med | M | — |
| Acid Squares | [React](https://reactbits.dev/backgrounds/acid-squares) | backgrounds | Bright square patterns move across the field. | no | — | low | M | — |
| Scanner | [React](https://reactbits.dev/backgrounds/scanner) | backgrounds | A scanning band crosses a background. | no | — | med | M | — |
| Ferrofluid | [React](https://reactbits.dev/backgrounds/ferrofluid) | backgrounds | Dark reflective blobs merge and separate. | no | — | med | L | — |
| Lightfall | [React](https://reactbits.dev/backgrounds/lightfall) | backgrounds | Vertical light streaks fall through a field. | no | — | med | M | — |
| Liquid Ether | [React](https://reactbits.dev/backgrounds/liquid-ether) | backgrounds | A soft colored fluid-like field moves. | no | — | med | L | — |
| Prism | [React](https://reactbits.dev/backgrounds/prism) | backgrounds | Prismatic shapes refract color. | no | — | med | M | — |
| Dark Veil | [React](https://reactbits.dev/backgrounds/dark-veil) | backgrounds | A subdued layered field drifts behind content. | no | — | med | M | — |
| Light Pillar | [React](https://reactbits.dev/backgrounds/light-pillar) | backgrounds | Vertical shafts of light move softly. | no | — | med | M | — |
| Silk | [React](https://reactbits.dev/backgrounds/silk) | backgrounds | A folded cloth-like gradient moves. | yes | genui:silk | med | M | — |
| Floating Lines | [React](https://reactbits.dev/backgrounds/floating-lines) | backgrounds | Parallel lines float through a background. | no | — | med | M | — |
| Side Rays | [React](https://reactbits.dev/backgrounds/side-rays) | backgrounds | Light rays enter from the side. | no | — | med | M | — |
| Light Rays | [React](https://reactbits.dev/backgrounds/light-rays) | backgrounds | Soft shafts of light drift behind content. | no | — | med | M | light-rays |
| Pixel Blast | [React](https://reactbits.dev/backgrounds/pixel-blast) | backgrounds | Pixel particles spread across a field. | no | — | med | M | — |
| Color Bends | [React](https://reactbits.dev/backgrounds/color-bends) | backgrounds | Colored bands bend and flow. | no | — | low | M | — |
| Evil Eye | [React](https://reactbits.dev/backgrounds/evil-eye) | backgrounds | An eye-like decorative field follows movement. | no | — | low | M | — |
| Line Waves | [React](https://reactbits.dev/backgrounds/line-waves) | backgrounds | Lines undulate across a background. | no | — | med | M | — |
| Radar | [React](https://reactbits.dev/backgrounds/radar) | backgrounds | A scanning sweep crosses a radar-like field. | no | — | med | M | — |
| Soft Aurora | [React](https://reactbits.dev/backgrounds/soft-aurora) | backgrounds | A subdued aurora gradient drifts behind content. | yes | genui:soft-aurora | med | M | — |
| Aurora | [React](https://reactbits.dev/backgrounds/aurora) | backgrounds | Colored light curtains drift across a background. | no | — | med | M | — |
| Plasma | [React](https://reactbits.dev/backgrounds/plasma) | backgrounds | A glowing organic field flows. | no | — | med | L | — |
| Plasma Wave | [React](https://reactbits.dev/backgrounds/plasma-wave) | backgrounds | A luminous wave flows across the background. | no | — | med | L | — |
| Particles | [React](https://reactbits.dev/backgrounds/particles) | backgrounds | Small decorative points drift behind content. | no | — | med | L | — |
| Gradient Blinds | [React](https://reactbits.dev/backgrounds/gradient-blinds) | backgrounds | Parallel gradient bands shift like blinds. | no | — | med | M | — |
| Grainient | [React](https://reactbits.dev/backgrounds/grainient) | backgrounds | A grain-textured gradient blends colors. | yes | genui:grainient | med | M | — |
| Grid Scan | [React](https://reactbits.dev/backgrounds/grid-scan) | backgrounds | An illuminated scan moves over a grid. | no | — | med | M | — |
| Beams | [React](https://reactbits.dev/backgrounds/beams) | backgrounds | Long light beams cross a background. | no | — | med | M | — |
| Pixel Snow | [React](https://reactbits.dev/backgrounds/pixel-snow) | backgrounds | Small square particles fall across the field. | no | — | med | M | — |
| Lightning | [React](https://reactbits.dev/backgrounds/lightning) | backgrounds | A branching light flash crosses the scene. | no | — | low | M | — |
| Prismatic Burst | [React](https://reactbits.dev/backgrounds/prismatic-burst) | backgrounds | A radial field separates into prism-like colors. | no | — | med | M | — |
| Galaxy | [React](https://reactbits.dev/backgrounds/galaxy) | backgrounds | A star field gives a sense of spatial depth. | no | — | med | L | — |
| Dither | [React](https://reactbits.dev/backgrounds/dither) | backgrounds | A stippled field creates a low-resolution texture. | no | — | med | M | — |
| Faulty Terminal | [React](https://reactbits.dev/backgrounds/faulty-terminal) | backgrounds | A terminal-like field flickers with visual noise. | no | — | low | M | — |
| Ripple Grid | [React](https://reactbits.dev/backgrounds/ripple-grid) | backgrounds | Ripples spread across a grid. | no | — | med | M | — |
| Dot Field | [React](https://reactbits.dev/backgrounds/dot-field) | backgrounds | A dense field of dots moves behind content. | no | — | med | M | — |
| Dot Grid | [React](https://reactbits.dev/backgrounds/dot-grid) | backgrounds | An orderly dot field reacts near a pointer. | no | — | med | S | dot-grid |
| Threads | [React](https://reactbits.dev/backgrounds/threads) | backgrounds | Fine strands drift across a background. | no | — | med | M | — |
| Hyperspeed | [React](https://reactbits.dev/backgrounds/hyperspeed) | backgrounds | Lines rush into depth to suggest speed. | no | — | low | L | — |
| Iridescence | [React](https://reactbits.dev/backgrounds/iridescence) | backgrounds | A pearlescent color field changes slowly. | yes | genui:iridescence | med | M | — |
| Waves | [React](https://reactbits.dev/backgrounds/waves) | backgrounds | Layered curves flow across a background. | no | — | med | M | waves |
| Grid Distortion | [React](https://reactbits.dev/backgrounds/grid-distortion) | backgrounds | A grid distorts around a local interaction. | no | — | med | M | — |
| Ballpit | [React](https://reactbits.dev/backgrounds/ballpit) | backgrounds | Ball-like shapes collide in a decorative field. | no | — | low | L | — |
| Orb | [React](https://reactbits.dev/backgrounds/orb) | backgrounds | A glowing sphere moves behind content. | no | — | low | M | — |
| Letter Glitch | [React](https://reactbits.dev/backgrounds/letter-glitch) | backgrounds | A letter field changes through glitch-like substitutions. | no | — | low | M | — |
| Grid Motion | [React](https://reactbits.dev/backgrounds/grid-motion) | backgrounds | Tiles move within a background grid. | no | — | med | M | — |
| Shape Grid | [React](https://reactbits.dev/backgrounds/shape-grid) | backgrounds | Repeated shapes form an animated grid. | no | — | med | M | — |
| Liquid Chrome | [React](https://reactbits.dev/backgrounds/liquid-chrome) | backgrounds | A reflective fluid field shifts across a background. | yes | genui:liquid-chrome | med | L | — |
| Balatro | [React](https://reactbits.dev/backgrounds/balatro) | backgrounds | A swirling high-contrast color field moves. | no | — | med | M | — |
## 21st.dev public index

| Name | Source | Category | Behavior summary (authored) | Already covered | Coverage evidence | Value | Size | Added |
|---|---|---|---|---|---|---|---|---|
| Scroll media expansion hero | [21st.dev](https://21st.dev/@arunachalam/components/scroll-expansion-hero) | Featured | Scroll media expansion hero presents the visual interaction named in the listing. | yes | genui:scroll-expand | high | M | — |
| Container Scroll Animation | [21st.dev](https://21st.dev/@manuarora700/components/container-scroll-animation) | Featured | Container Scroll Animation presents the visual interaction named in the listing. | yes | genui:scroll-expand | high | M | — |
| Spline Scene | [21st.dev](https://21st.dev/@serafimcloud/components/splite) | Featured | Spline Scene presents the visual interaction named in the listing. | no | — | high | L | — |
| Spotlight Card | [21st.dev](https://21st.dev/@jahed/components/spotlight-card) | Featured | A local spotlight follows the pointer across a card. | yes | genui:spotlight-card | high | M | — |
| Color Filter Image Gallery | [21st.dev](https://21st.dev/@dhxwhy/components/color-filter-gallery) | Newest | A color filter image gallery presents a decorative interaction or visual layout. | no | — | med | L | — |
| Tilted Grid Hero | [21st.dev](https://21st.dev/@ruixen.ui/components/tilted-grid-hero) | Newest | A tilted grid hero presents a decorative interaction or visual layout. | no | — | med | M | — |
| Build Pipeline | [21st.dev](https://21st.dev/@ibrandify/components/build-pipeline) | Newest | A build pipeline presents a decorative interaction or visual layout. | no | — | med | M | — |
| Storage District | [21st.dev](https://21st.dev/@ibrandify/components/storage-district) | Newest | A storage district presents a decorative interaction or visual layout. | no | — | med | M | — |
| Focus City | [21st.dev](https://21st.dev/@ibrandify/components/focus-city) | Newest | A focus city presents a decorative interaction or visual layout. | no | — | med | M | — |
| Constellation Image Gallery | [21st.dev](https://21st.dev/@dhxwhy/components/constellation-gallery) | Newest | A constellation image gallery presents a decorative interaction or visual layout. | no | — | med | L | — |
| Domino Scroll Image Gallery | [21st.dev](https://21st.dev/@dhxwhy/components/domino-gallery) | Newest | A domino scroll image gallery presents a decorative interaction or visual layout. | no | — | med | L | — |
| Lighthouse Spotlight Image Gallery | [21st.dev](https://21st.dev/@dhxwhy/components/lighthouse-gallery) | Newest | A lighthouse spotlight image gallery presents a decorative interaction or visual layout. | no | — | med | L | — |
| Isometric Elevator | [21st.dev](https://21st.dev/@lucasmarkes/components/elevator) | Newest | A isometric elevator presents a decorative interaction or visual layout. | no | — | med | M | — |
| Padlock | [21st.dev](https://21st.dev/@lucasmarkes/components/padlock) | Newest | A padlock presents a decorative interaction or visual layout. | no | — | med | M | — |
| Radial Orbital Timeline | [21st.dev](https://21st.dev/@jatin-yadav05/components/radial-orbital-timeline) | Popular | Milestones arrange around an orbital timeline. | no | — | low | L | — |
| Testimonials Columns | [21st.dev](https://21st.dev/@efferd/components/testimonials-columns-1) | Popular | Testimonials appear in vertically arranged columns. | no | — | med | M | — |
| Liquid Glass Button | [21st.dev](https://21st.dev/@designali-in/components/liquid-glass-button) | Popular | A translucent button has a fluid glass treatment. | no | — | med | S | — |
| Scroll Morph Hero | [21st.dev](https://21st.dev/@prashantsom75/components/scroll-morph-hero) | Popular | Hero content changes form as the page scrolls. | no | — | med | L | — |
| Animated hero | [21st.dev](https://21st.dev/@tommyjepsen/components/animated-hero) | Popular | A hero section introduces its content through motion. | no | — | med | M | — |
| Background Paths | [21st.dev](https://21st.dev/@kokonutd/components/background-paths) | Popular | Decorative contour paths move behind content. | yes | 21st:kokonutd-background-paths | med | M | — |
| Velaris | [21st.dev](https://21st.dev/@amanshakya307/components/velaris) | Shaders | Velaris presents a procedural visual surface. | no | — | med | M | — |
| Voice Powered Orb | [21st.dev](https://21st.dev/@isaiahbjork/components/voice-powered-orb) | Shaders | Voice Powered Orb presents a procedural visual surface. | no | — | low | M | — |
| WaterRippleImage | [21st.dev](https://21st.dev/@rahil1202/components/water-ripple-image) | Shaders | An image surface reacts with ripples. | yes | genui:water-ripple-image | med | M | — |
| Feature Shader Cards | [21st.dev](https://21st.dev/@moazamtrade/components/feature-shader-cards) | Shaders | Feature Shader Cards presents a procedural visual surface. | no | — | med | L | — |
| ATC shader | [21st.dev](https://21st.dev/@xordev/components/atc-shader) | Shaders | ATC shader presents a procedural visual surface. | yes | genui:atc-shader | med | L | — |
| Siri Wave | [21st.dev](https://21st.dev/@40973894/components/siri-wave) | Shaders | Siri Wave presents a procedural visual surface. | no | — | med | M | — |
| Liquid Effect Animation | [21st.dev](https://21st.dev/@minhxthanh/components/liquid-effect-animation) | Shaders | Liquid Effect Animation presents a procedural visual surface. | no | — | med | M | — |
| Shader Svg | [21st.dev](https://21st.dev/@reuno-ui/components/shader-svg) | Shaders | Shader Svg presents a procedural visual surface. | yes | genui:shader-svg | med | L | — |
| Sphere | [21st.dev](https://21st.dev/@designali-in/components/sphere) | Shaders | Sphere presents a procedural visual surface. | no | — | med | M | — |
| Topo Field | [21st.dev](https://21st.dev/@mengto/components/topo-field) | Shaders | Topo Field presents a procedural visual surface. | no | — | med | M | — |
| Image Stream Hero | [21st.dev](https://21st.dev/@ruixen.ui/components/image-stream-hero) | Heros | Image Stream Hero introduces a page with a headline, supporting visual, or CTA. | yes | 21st:ruixen-ui-image-stream-hero | med | M | — |
| Scroll Locked Video Hero | [21st.dev](https://21st.dev/@gughigug/components/scroll-locked-video-hero) | Heros | Scroll Locked Video Hero introduces a page with a headline, supporting visual, or CTA. | yes | genui:scroll-locked-video-hero | med | M | — |
| Black Hole Hero Section | [21st.dev](https://21st.dev/@yura/components/blackhole-hero-section) | Heros | Black Hole Hero Section introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Glyph Portal | [21st.dev](https://21st.dev/@Legacy/components/glyph-portal) | Heros | Glyph Portal introduces a page with a headline, supporting visual, or CTA. | yes | genui:glyph-portal | med | L | — |
| Gateway Flow | [21st.dev](https://21st.dev/@mengto/components/gateway-flow) | Heros | Gateway Flow introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Constellation Grid | [21st.dev](https://21st.dev/@daiwiikharihar/components/constellation-grid) | Heros | Constellation Grid introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Scroll Choreography | [21st.dev](https://21st.dev/@componentry/components/scroll-choreography) | Heros | Scroll Choreography introduces a page with a headline, supporting visual, or CTA. | yes | genui:scroll-choreography | med | M | — |
| Hero Scroll Video Pin Reveal | [21st.dev](https://21st.dev/@ajith66310/components/hero-scroll-video-pin-reveal) | Heros | Hero Scroll Video Pin Reveal introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Squeeze Carousel | [21st.dev](https://21st.dev/@yura/components/carousel-squeeze) | Features | Squeeze Carousel presents product features in a structured section. | no | — | high | L | — |
| Features 4 | [21st.dev](https://21st.dev/@meschacirung/components/features-4) | Features | Features 4 presents product features in a structured section. | no | — | high | M | — |
| Features 2 | [21st.dev](https://21st.dev/@meschacirung/components/features-2) | Features | Features 2 presents product features in a structured section. | no | — | high | M | — |
| Features 1 | [21st.dev](https://21st.dev/@meschacirung/components/features-1) | Features | Features 1 presents product features in a structured section. | no | — | high | M | — |
| Feature Comparison Table | [21st.dev](https://21st.dev/@olewandowski1/components/comparison-3) | Features | A table compares feature availability. | no | — | high | M | — |
| Features With Panel | [21st.dev](https://21st.dev/@scrollxui/components/features-with-panel) | Features | Features With Panel presents product features in a structured section. | no | — | high | M | — |
| Alternating Rows With Stats | [21st.dev](https://21st.dev/@olewandowski1/components/features-2) | Features | Alternating Rows With Stats presents product features in a structured section. | no | — | high | M | — |
| Animated Features Bento with Live Diagrams | [21st.dev](https://21st.dev/@kedhareswer/components/ink-orbit-features) | Features | Animated Features Bento with Live Diagrams presents product features in a structured section. | no | — | high | M | — |
| Comparison Section | [21st.dev](https://21st.dev/@mohammadshehadeh/components/comparison-03) | Features | Comparison Section presents product features in a structured section. | no | — | high | M | — |
| Tabbed Feature Categories | [21st.dev](https://21st.dev/@olewandowski1/components/features-4) | Features | Tabs switch between feature groups. | no | — | high | M | — |
| V0 AI Chat | [21st.dev](https://21st.dev/@kokonutd/components/v0-ai-chat) | AI Chat Components | V0 AI Chat presents an input, message, or status in a chat interface. | no | — | low | L | — |
| Ai chat input | [21st.dev](https://21st.dev/@jahed/components/ai-chat-input) | AI Chat Components | Ai chat input presents an input, message, or status in a chat interface. | yes | genui:ai-chat-input | low | L | — |
| Shining Text | [21st.dev](https://21st.dev/@preetsuthar17/components/shining-text) | AI Chat Components | A light sheen travels over text. | yes | genui:shiny-text | low | M | — |
| AI Chat Image Generation | [21st.dev](https://21st.dev/@gonzalochale/components/ai-chat-image-generation-1) | AI Chat Components | AI Chat Image Generation presents an input, message, or status in a chat interface. | no | — | low | L | — |
| AI Chat Input | [21st.dev](https://21st.dev/@preetsuthar17/components/ai-chat-input) | AI Chat Components | AI Chat Input presents an input, message, or status in a chat interface. | yes | genui:ai-chat-input | low | L | — |
| Agent Trace | [21st.dev](https://21st.dev/@n1m4mz/components/agent-trace) | AI Chat Components | A timeline displays sample agent execution events. | no | — | low | M | — |
| Message loading | [21st.dev](https://21st.dev/@jakobhoeg/components/message-loading) | AI Chat Components | An indicator shows a pending message. | no | — | low | M | — |
| Agent Dock | [21st.dev](https://21st.dev/@dqnamo/components/agent-dock) | AI Chat Components | Agent Dock presents an input, message, or status in a chat interface. | no | — | low | M | — |
| Streaming Text | [21st.dev](https://21st.dev/@theshanelevine/components/streaming-text) | AI Chat Components | Text appears progressively in a response area. | no | — | low | M | — |
| AI Assistant Interface | [21st.dev](https://21st.dev/@rafa-porto/components/ai-assistant-interface) | AI Chat Components | AI Assistant Interface presents an input, message, or status in a chat interface. | no | — | low | M | — |
| PrismaHero | [21st.dev](https://21st.dev/@rahil1202/components/prisma-hero) | Calls to Action | PrismaHero introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Hero | [21st.dev](https://21st.dev/@reuno-ui/components/hero) | Calls to Action | Hero introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Hero | [21st.dev](https://21st.dev/@ravikatiyar162/components/hero-3) | Calls to Action | Hero introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Rainbow Button | [21st.dev](https://21st.dev/@dillionverma/components/rainbow-button) | Calls to Action | Rainbow Button introduces a page with a headline, supporting visual, or CTA. | no | — | med | S | — |
| Hero 195 | [21st.dev](https://21st.dev/@shadcnblockscom/components/hero-195-1) | Calls to Action | Hero 195 introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Responsive Hero Banner | [21st.dev](https://21st.dev/@sensewood8/components/responsive-hero-banner) | Calls to Action | Responsive Hero Banner introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Floating Icons Hero Section | [21st.dev](https://21st.dev/@ravikatiyar162/components/floating-icons-hero-section) | Calls to Action | Floating Icons Hero Section introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Integration Card | [21st.dev](https://21st.dev/@shadcnspace/components/integration-card) | Calls to Action | Integration Card introduces a page with a headline, supporting visual, or CTA. | no | — | med | M | — |
| Interactive Hover Button | [21st.dev](https://21st.dev/@dillionverma/components/interactive-hover-button) | Buttons | Interactive Hover Button gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Liquid Metal Button | [21st.dev](https://21st.dev/@johuniq/components/liquid-metal-button) | Buttons | Liquid Metal Button gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Gradient Menu | [21st.dev](https://21st.dev/@minhxthanh/components/gradient-menu) | Buttons | Gradient Menu gives an interactive control a decorative surface or hover treatment. | no | — | med | M | — |
| Shiny Button | [21st.dev](https://21st.dev/@designali-in/components/shiny-button) | Buttons | Shiny Button gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Gradient Button | [21st.dev](https://21st.dev/@serafimcloud/components/gradient-button) | Buttons | Gradient Button gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Neon Button | [21st.dev](https://21st.dev/@cybergaz/components/neon-button) | Buttons | Neon Button gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Highlighter | [21st.dev](https://21st.dev/@designali-in/components/highlighter) | Buttons | Highlighter gives an interactive control a decorative surface or hover treatment. | no | — | med | S | — |
| Sign In | [21st.dev](https://21st.dev/@jahed/components/sign-in) | Testimonials | Sign In presents customer quotes or profiles. | no | — | high | M | — |
| 3D Testimonails | [21st.dev](https://21st.dev/@sean0205/components/3d-testimonails) | Testimonials | 3D Testimonails presents customer quotes or profiles. | yes | genui:3d-testimonails | high | L | — |
| Circular Testimonials | [21st.dev](https://21st.dev/@maxim.bort.devel/components/circular-testimonials) | Testimonials | Circular Testimonials presents customer quotes or profiles. | no | — | high | M | — |
| Testimonials with Marquee | [21st.dev](https://21st.dev/@serafimcloud/components/testimonials-with-marquee) | Testimonials | Testimonials with Marquee presents customer quotes or profiles. | no | — | high | M | — |
| Animated Testimonials | [21st.dev](https://21st.dev/@manuarora700/components/animated-testimonials) | Testimonials | Animated Testimonials presents customer quotes or profiles. | yes | genui:animated-testimonials | high | M | — |
| Stagger Testimonials | [21st.dev](https://21st.dev/@vaib215/components/stagger-testimonials) | Testimonials | Stagger Testimonials presents customer quotes or profiles. | no | — | high | M | — |
| Testimonial V2 | [21st.dev](https://21st.dev/@avanishverma4/components/testimonial-v2) | Testimonials | Testimonial V2 presents customer quotes or profiles. | no | — | high | M | — |
| Unique Testimonial | [21st.dev](https://21st.dev/@jatin-yadav05/components/unique-testimonial) | Testimonials | Unique Testimonial presents customer quotes or profiles. | no | — | high | M | — |
| Profile Card Testimonial Carousel | [21st.dev](https://21st.dev/@arunachalam/components/profile-card-testimonial-carousel) | Testimonials | Profile Card Testimonial Carousel presents customer quotes or profiles. | no | — | high | L | — |
| Pricing | [21st.dev](https://21st.dev/@Codehagen/components/pricing) | Pricing Sections | Pricing presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing Section | [21st.dev](https://21st.dev/@aymanch-03/components/pricing-section) | Pricing Sections | Pricing Section presents plan prices and purchase choices. | no | — | high | M | — |
| Single Pricing Card | [21st.dev](https://21st.dev/@efferd/components/single-pricing-card-1) | Pricing Sections | Single Pricing Card presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing Section | [21st.dev](https://21st.dev/@uilayout.contact/components/pricing-section) | Pricing Sections | Pricing Section presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing | [21st.dev](https://21st.dev/@ravikatiyar162/components/pricing) | Pricing Sections | Pricing presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing | [21st.dev](https://21st.dev/@uilayout.contact/components/pricing) | Pricing Sections | Pricing presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing Section | [21st.dev](https://21st.dev/@uilayout.contact/components/pricing-section-3) | Pricing Sections | Pricing Section presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing Module | [21st.dev](https://21st.dev/@ruixen.ui/components/pricing-module) | Pricing Sections | Pricing Module presents plan prices and purchase choices. | no | — | high | M | — |
| Pricing Section | [21st.dev](https://21st.dev/@kokonutd/components/pricing-section) | Pricing Sections | Pricing Section presents plan prices and purchase choices. | no | — | high | M | — |
| Squishy Pricing | [21st.dev](https://21st.dev/@vaib215/components/squishy-pricing) | Pricing Sections | Squishy Pricing presents plan prices and purchase choices. | no | — | high | M | — |
| Link Preview | [21st.dev](https://21st.dev/@manuarora700/components/link-preview) | Text Components | A link reveals a small preview on hover or focus. | no | — | high | M | — |
| Text Scroll animation  | [21st.dev](https://21st.dev/@reuno-ui/components/text-scroll-animation) | Text Components | Text Scroll animation  presents the visual interaction named in the listing. | yes | genui:text-scroll-animation | med | M | — |
| Shimmer Text | [21st.dev](https://21st.dev/@tom_ui/components/shimmer-text) | Text Components | A soft sheen travels over text. | yes | genui:shiny-text | med | M | — |
| Text Rotate | [21st.dev](https://21st.dev/@danielpetho/components/text-rotate/image-scroll) | Text Components | A heading cycles through alternate text. | no | — | med | M | rotating-text |
| Magic Text | [21st.dev](https://21st.dev/@preetsuthar17/components/magic-text) | Text Components | Magic Text presents the visual interaction named in the listing. | no | — | med | M | — |
| Gradient Text | [21st.dev](https://21st.dev/@designali-in/components/gradient-text/gradient-text) | Text Components | A gradient colors a headline. | no | — | high | S | gradient-text |
| Marquee | [21st.dev](https://21st.dev/@tom_ui/components/marquee) | Text Components | A row of text or marks repeats in a moving strip. | no | — | high | M | logo-loop |
| Hover Preview | [21st.dev](https://21st.dev/@minhxthanh/components/hover-preview) | Text Components | A pointer or keyboard interaction reveals a preview. | no | — | med | M | — |
| Handwriting SVG | [21st.dev](https://21st.dev/@pulkitxm/components/handwriting-svg) | Text Components | An SVG stroke draws handwriting. | yes | genui:handwriting-svg | med | M | — |

## Cult UI catalog (licensed, bundled)

All 311 local rows count as covered under the existing licence. This section reads names, descriptions, category, and rights metadata only; no licensed source files were opened.

| Name | Source | Category | Behavior summary (local metadata) | Already covered | Value | Size |
|---|---|---|---|---|---|---|
| agent-suggest-card-stack | Cult UI (licensed) | ui | Stack of suggestion cards for AI agent responses | yes | med | M |
| agent-suggest-card-stack-demo | Cult UI (licensed) | ui | Demo for the agent suggest card stack component | yes | med | M |
| ai-agents-parallel-processing | Cult UI (licensed) | ai | Deploy multiple AI agents to process content simultaneously. Demonstrates concurrent analysis patterns for improved performance and scalability in AI applications. | yes | med | M |
| ai-agents-sandbox | Cult UI (licensed) | ai | Playground for building and testing AI agent patterns. Experiment with different agent architectures, prompt engineering, and multi-agent workflows in a controlled environment. | yes | med | M |
| ai-artifact-chart | Cult UI (licensed) | ai | AI chat interface that generates interactive burn rate charts and financial analysis artifacts. | yes | med | M |
| ai-artifact-table | Cult UI (licensed) | ai | AI-powered spreadsheet editor with chat interface for data analysis and manipulation. | yes | med | M |
| ai-blob-warp | Cult UI (licensed) | ui | Circular avatar with Paper Design Warp shader; motion-safe pulse, pauses off-screen and when reduced motion is preferred | yes | med | M |
| ai-blob-warp-demo | Cult UI (licensed) | ui | Demo for the AI blob Warp avatar with sizes and warpProps variants | yes | med | M |
| ai-chat-agent-evaluator-optimizer-pattern | Cult UI (licensed) | agent | Dual-agent system for quality improvement. Evaluator agent analyzes output quality while optimizer agent refines and improves results through iterative feedback loops. | yes | med | L |
| ai-chat-agent-multi-step-tool-pattern | Cult UI (licensed) | agent | AI agent that executes complex multi-step workflows using typed tools. Features streaming responses, tool chaining, and decision-making for task automation. | yes | med | L |
| ai-chat-agent-orchestrater-pattern | Cult UI (licensed) | agent | AI orchestrator that coordinates multiple worker agents for complex project management. Manages task distribution, progress tracking, and result synthesis across specialized AI agents. | yes | med | L |
| ai-chat-agent-routing-pattern | Cult UI (licensed) | agent | Routes user requests to specialized AI agents. Uses AI SDK v5 streaming to classify requests and send them to the right agent for customer support. | yes | med | L |
| ai-document-processor | Cult UI (licensed) | ai | Document processing system with AI analysis and semantic search. Extracts text from PDFs, Word docs, and web pages, then uses AI to analyze content and enable search across documents. | yes | med | M |
| ai-elements-chat | Cult UI (licensed) | ai | AI chatbot built with AI Elements components. Features streaming responses, message history, and uses OpenAI's GPT-5-nano model for conversations. | yes | med | L |
| ai-elements-image | Cult UI (licensed) | ai | Image generation interface using DALL-E 3. Create custom artwork, illustrations, and visual content with AI image generation and real-time preview capabilities. | yes | med | M |
| ai-elements-inline-citation | Cult UI (licensed) | ai | Generate AI content with embedded source citations. Creates factually accurate content with clickable inline references for research, documentation, and educational materials. | yes | med | M |
| ai-elements-reasoning-chat | Cult UI (licensed) | ai | AI chat interface that reveals the AI's thinking process. Displays step-by-step reasoning, analysis, and decision-making logic for transparent and educational conversations. | yes | med | L |
| ai-elements-sources-chat | Cult UI (licensed) | ai | AI chat interface with source citations. Uses Perplexity's Sonar model to provide answers with clickable source links and references for research and fact-checking. | yes | med | L |
| ai-elements-task-demo | Cult UI (licensed) | ai | Task management component with AI workflow demonstrations. Shows how to integrate AI agents for task creation, completion tracking, and automated workflow orchestration. | yes | med | M |
| ai-elements-tool | Cult UI (licensed) | ai | Demonstration of AI tool integration. Shows how to connect AI agents with external APIs and services, featuring a weather API example with real-time data fetching. | yes | med | M |
| ai-elements-v0-clone | Cult UI (licensed) | ai | AI interface builder inspired by V0. Features chat-based component generation with live web preview, real-time code rendering, and component editing. | yes | med | M |
| ai-generate-audio | Cult UI (licensed) | ai | Generate speech and audio using OpenAI's text-to-speech API. Features voice selection, speed control, and real-time audio playback for creating voiceovers and audio content. | yes | med | M |
| ai-human-in-the-loop | Cult UI (licensed) | ai | Chat assistant with human approval workflows for safe tool execution. | yes | med | M |
| ai-image-generation | Cult UI (licensed) | ai | Generate images using OpenAI's DALL-E 3. Features batch processing, style modifiers, example prompts, and download options for creating custom artwork and illustrations. | yes | med | M |
| ai-pdf-ingest | Cult UI (licensed) | ai | Upload and process PDF documents with AI analysis. Extracts text content, generates summaries, and provides insights from PDF files using OpenAI's language models. | yes | med | M |
| ai-sdk-enrich-form | Cult UI (licensed) | ai | Form that uses AI to analyze user profiles and provide personalized suggestions. Automatically enriches profile data, suggests improvements, and offers career insights based on user input. | yes | med | M |
| ai-sdk-gemini-flash-image | Cult UI (licensed) | ai | Generates text and analyzes market research using Google's Gemini 2.5 Flash. Includes interactive charts and data visualization. | yes | med | M |
| ai-sdk-gemini-flash-image-edit | Cult UI (licensed) | ai | Generate and edit images using Google's Gemini 2.5 Flash. Create new images from text or edit existing ones with natural language. Includes version history and image comparison. | yes | med | M |
| ai-sdk-gemini-flash-text | Cult UI (licensed) | ai | Advanced text generation and market research analysis using Google's Gemini 2.5 Flash model through the Vercel AI SDK, featuring interactive charts and comprehensive data visualization | yes | med | M |
| ai-sdk-prompt-few-shot | Cult UI (licensed) | ai | Prompt engineering tool for few-shot learning. Create, test, and optimize prompts with examples, evaluate AI responses, and fine-tune model performance through experimentation. | yes | med | M |
| ai-websearch | Cult UI (licensed) | ai | Web search powered by OpenAI's websearch tool. Performs real-time web searches, analyzes results, and provides answers with source citations and references. | yes | med | M |
| analytics-chart | Cult UI (licensed) | ui | Vercel-style gradient line chart with floating tooltip cards | yes | med | M |
| analytics-chart-demo | Cult UI (licensed) | ui | Demo for the analytics chart component | yes | med | M |
| animated-badge | Cult UI (licensed) | ui | Badge with optional layout animation, live status dot, and gradient rim aligned with Animated Button / Card | yes | med | M |
| animated-badge-demo | Cult UI (licensed) | ui | Demo for the gradient-rim badge with tabular counts, live dot, and layout animation on label changes | yes | med | M |
| animated-button | Cult UI (licensed) | ui | Primary action button with animated gradient rim, frosted fill, staggered label, and loading spinner | yes | med | S |
| animated-button-demo | Cult UI (licensed) | ui | Demo for the animated gradient-rim button with translucent fill, staggered label, and loading state | yes | med | S |
| animated-card | Cult UI (licensed) | ui | Composable card with animated gradient rim, frosted fill, layered shadow, and Base UI button actions | yes | med | M |
| animated-card-demo | Cult UI (licensed) | ui | Demo for the composable animated card with gradient rim, header action, content, and footer buttons | yes | med | M |
| animated-composer | Cult UI (licensed) | ui | Multiline prompt field with shader avatar, staggered placeholder, loading line, and send/attach chrome | yes | med | M |
| animated-composer-demo | Cult UI (licensed) | ui | Demo for the multi-line composer field with shader avatar, loading line, and send/attach chrome | yes | med | M |
| animated-dropzone | Cult UI (licensed) | ui | File dropzone with animated rim, frosted fill, moving border trail, and file-type glyphs | yes | med | M |
| animated-dropzone-demo | Cult UI (licensed) | ui | Demo for the animated file dropzone with dashed rim, file-type glyphs, and upload queue | yes | med | M |
| animated-field | Cult UI (licensed) | ui | Form field layout (label, description, error) for AnimatedInput and AnimatedTextarea | yes | med | M |
| animated-field-demo | Cult UI (licensed) | ui | Demo pairing AnimatedField with AnimatedInput and AnimatedTextarea for labeled form controls | yes | med | M |
| animated-input | Cult UI (licensed) | ui | Single-line and multiline inputs with frosted fill and gradient rim for generic forms | yes | med | M |
| animated-input-demo | Cult UI (licensed) | ui | Demo for single-line and multiline animated inputs with frosted gradient rim | yes | med | M |
| animated-notification | Cult UI (licensed) | ui | Polished notification surface for local AnimatePresence use with rim variants and glyph stagger | yes | med | M |
| animated-notification-demo | Cult UI (licensed) | ui | Demo for polished in-flow notifications with rim variants and glyph stagger | yes | med | M |
| animated-progress | Cult UI (licensed) | ui | Progress bar with spring-driven determinate fill and indeterminate gradient strip | yes | med | M |
| animated-progress-demo | Cult UI (licensed) | ui | Demo for determinate and indeterminate progress with spring fill and gradient strip | yes | med | M |
| animated-search | Cult UI (licensed) | ui | Search input with animated gradient border, staggered placeholder, blur deletion on clear, loading line, and Warp shader avatar | yes | med | M |
| animated-search-demo | Cult UI (licensed) | ui | Demo for the animated gradient search field with loading and frosted fill toggle | yes | med | M |
| animated-segmented | Cult UI (licensed) | ui | Segmented control with frosted track, gradient rim, and spring sliding thumb | yes | med | M |
| animated-segmented-demo | Cult UI (licensed) | ui | Demo for the spring-animated segmented control with frosted track and sliding thumb | yes | med | M |
| animated-select | Cult UI (licensed) | ui | Composable animated select with gradient rim, frosted fill, and staggered label | yes | med | M |
| animated-select-demo | Cult UI (licensed) | ui | Demo for the animated select with staggered label, trailing indicators, and loading state | yes | med | M |
| animated-switch | Cult UI (licensed) | ui | Toggle switch with spring thumb, frosted track, and extended touch hit area | yes | med | M |
| animated-switch-demo | Cult UI (licensed) | ui | Demo for the spring-animated toggle switch with extended hit target | yes | med | M |
| animated-tabs | Cult UI (licensed) | ui | Base UI tabs with gradient indicator: underline or pill variant aligned with animated card rim colors | yes | med | M |
| animated-tabs-demo | Cult UI (licensed) | ui | Demo for Base UI tabs with gradient underline or pill indicator (underline and pill variants) | yes | med | M |
| animated-toast | Cult UI (licensed) | ui | Sonner-backed polished toasts with rim variants; mount PolishedToaster once in the root layout | yes | med | M |
| animated-toast-demo | Cult UI (licensed) | ui | Demo for Sonner-backed polished toasts with rim variants and actions | yes | med | M |
| animated-toggle-group | Cult UI (licensed) | ui | Segmented single-select control with frosted track, gradient rim, and spring-driven sliding thumb (aligned with Animated Button) | yes | med | M |
| animated-toggle-group-demo | Cult UI (licensed) | ui | Demo for the segmented single-select toggle group with spring-driven thumb and frosted track | yes | med | M |
| app-profile-minimal | Cult UI (licensed) | app-ui | Editorial-minimal user profile with spring animations, animated stat counters, and layered shadow depth. | yes | low | M |
| app-ui-grid-list-animated | Cult UI (licensed) | app-ui-grid-list | Responsive grid list with hover effects and animations. | yes | low | M |
| app-ui-grid-list-hover | Cult UI (licensed) | app-ui-grid-list | Responsive grid list with hover effects and animations. | yes | low | M |
| app-ui-onboarding | Cult UI (licensed) | app-ui-grid-list | Headless onboarding flow primitives with configurable multi-step dialogs and interactive choices. | yes | low | M |
| apple-iphone-17-pro | Cult UI (licensed) | ui | iPhone-style device frame with Dynamic Island, status bar, and configurable frame colors | yes | med | M |
| apple-iphone-17-pro-demo | Cult UI (licensed) | ui | Demo for the iPhone 17 Pro Max frame with Dynamic Island | yes | med | M |
| apple-keyboard | Cult UI (licensed) | ui | Compact Apple-style keyboard with labeled keys and media row | yes | med | M |
| apple-keyboard-demo | Cult UI (licensed) | ui | Demo for the Apple-style compact keyboard layout | yes | med | M |
| apple-pro-display-xdr | Cult UI (licensed) | ui | Studio Display–style aluminum frame, screen modes, and interactive macOS dock | yes | med | M |
| apple-pro-display-xdr-demo | Cult UI (licensed) | ui | Demo for the Pro Display XDR–style studio monitor frame | yes | med | M |
| apple-watch-ultra | Cult UI (licensed) | ui | Watch Ultra–style case, complications, crown, and action button | yes | med | M |
| apple-watch-ultra-demo | Cult UI (licensed) | ui | Demo for the Apple Watch Ultra–style watch chrome | yes | med | M |
| border-beam-button | Cult UI (licensed) | ui | border-beam glow around shadcn Button and icon button variants | yes | med | S |
| border-beam-button-demo | Cult UI (licensed) | ui | Demo for border-beam wrapped buttons and icon buttons | yes | med | S |
| border-beam-card | Cult UI (licensed) | ui | border-beam around compound Card API with balanced title and description | yes | med | M |
| border-beam-card-demo | Cult UI (licensed) | ui | Demo for border-beam around compound card layout with controls | yes | med | M |
| border-beam-input | Cult UI (licensed) | ui | border-beam on Base UI input and input-group primitives with line or full border glow | yes | med | M |
| border-beam-input-demo | Cult UI (licensed) | ui | Demo for border-beam on inputs and input groups | yes | med | M |
| cheerio-generate-object | Cult UI (licensed) | ai | Web scraper that uses AI to generate summaries of web content | yes | med | M |
| cheerio-scraper | Cult UI (licensed) | ai | A simple web scraper using Cheerio to extract content, links, and images from websites | yes | med | M |
| circuit-board | Cult UI (licensed) | ui | Animated SVG circuit illustration with glowing traces and a central chip, for hero or product sections | yes | med | M |
| circuit-board-demo | Cult UI (licensed) | ui | Demo for the circuit board marketing illustration | yes | med | M |
| collab-avatar | Cult UI (licensed) | ui | Collaboration avatar with initials and color | yes | med | M |
| collab-avatar-demo | Cult UI (licensed) | ui | Demo for the collab avatar component | yes | med | M |
| collab-toolbar | Cult UI (licensed) | ui | Toolbar component for collaborative editing UI | yes | med | M |
| collab-toolbar-demo | Cult UI (licensed) | ui | Demo for the collab toolbar component | yes | med | M |
| copy-button | Cult UI (licensed) | ui | Button that copies content to clipboard with feedback | yes | med | S |
| copy-button-demo | Cult UI (licensed) | ui | Demo for the copy button component | yes | med | S |
| feature-sticky-section | Cult UI (licensed) | ui | Sticky section with controllable panels and scroll behavior | yes | med | M |
| feature-sticky-section-demo | Cult UI (licensed) | ui | Demo for the feature sticky section component | yes | med | M |
| feedback-form-resend | Cult UI (licensed) | forms | Animated morphing feedback form component with Resend email integration. Features smooth animations, rate limiting, and email notifications. | yes | med | M |
| fluid-ai-workloads | Cult UI (licensed) | ui | Fluid visualization for AI workload states | yes | med | L |
| fluid-ai-workloads-demo | Cult UI (licensed) | ui | Demo for the fluid AI workloads component | yes | med | L |
| fluted-glass | Cult UI (licensed) | ui | Paper Design fluted-glass image shader with sensible defaults — ribbed, streaked distortions over a source image | yes | med | M |
| fluted-glass-demo | Cult UI (licensed) | ui | Interactive demo for fluted glass — image thumbnails, custom URL, Paper presets, and sliders for shader parameters | yes | med | M |
| folded-card | Cult UI (licensed) | ui | Folded card component with customizable reveal effects and timing | yes | med | M |
| folded-card-demo | Cult UI (licensed) | ui | Folded card component with customizable reveal effects and timing | yes | med | M |
| gateway-endpoint-illustration | Cult UI (licensed) | ui | Illustration for gateway endpoint concepts | yes | med | M |
| gateway-endpoint-illustration-demo | Cult UI (licensed) | ui | Demo for the gateway endpoint illustration component | yes | med | M |
| gateway-route-illustration | Cult UI (licensed) | ui | Illustration for gateway routing | yes | med | M |
| gateway-route-illustration-demo | Cult UI (licensed) | ui | Demo for the gateway route illustration component | yes | med | M |
| gateway-svg-illustration | Cult UI (licensed) | ui | SVG illustration for gateway overhead | yes | med | M |
| gateway-svg-illustration-demo | Cult UI (licensed) | ui | Demo for the gateway SVG illustration component | yes | med | M |
| globe | Cult UI (licensed) | ui | COBE-powered 3D globe with showcase presets, markers, arcs, DOM overlays, and theme-aware styling | yes | med | M |
| globe-demo | Cult UI (licensed) | ui | Interactive default showcase globe with cobe WebGL, drag, and CSS-anchored marker and arc labels | yes | med | M |
| icons | Cult UI (licensed) | ui | Icon set for file types and languages | yes | med | M |
| icons-demo | Cult UI (licensed) | ui | Demo for the icons component | yes | med | M |
| illustration-card-grid | Cult UI (licensed) | ui | Grid of cards with gateway illustrations | yes | med | M |
| illustration-card-grid-demo | Cult UI (licensed) | ui | Demo for the illustration card grid component | yes | med | M |
| illustration-comment-bubble | Cult UI (licensed) | ui | Comment bubble illustration for code or chat UI | yes | med | M |
| illustration-comment-bubble-demo | Cult UI (licensed) | ui | Demo for the illustration comment bubble component | yes | med | M |
| illustration-cursor | Cult UI (licensed) | ui | Cursor illustration and demo for collaboration UI | yes | low | L |
| illustration-cursor-demo | Cult UI (licensed) | ui | Demo for the illustration cursor component | yes | low | L |
| illustration-fluid-rendering | Cult UI (licensed) | ui | Fluid rendering illustration | yes | med | L |
| illustration-fluid-rendering-demo | Cult UI (licensed) | ui | Demo for the illustration fluid rendering component | yes | med | L |
| illustration-globe-vercel | Cult UI (licensed) | ui | Globe deployment illustration | yes | med | M |
| illustration-globe-vercel-demo | Cult UI (licensed) | ui | Demo for the illustration globe Vercel component | yes | med | M |
| illustration-graph | Cult UI (licensed) | ui | Graph illustration component | yes | med | M |
| illustration-graph-demo | Cult UI (licensed) | ui | Demo for the illustration graph component | yes | med | M |
| jina-scraper | Cult UI (licensed) | ai | A simple web scraper using Jina AI's scraper service to extract content, links, and images from websites while bypassing common scraping limitations | yes | med | M |
| kanban-board | Cult UI (licensed) | ui | Kanban board with drag-and-drop columns and cards | yes | med | M |
| kanban-board-demo | Cult UI (licensed) | ui | Demo for the kanban board component | yes | med | M |
| mac-screen | Cult UI (licensed) | ui | Classic Mac frame with an image or GIF composited into the CRT | yes | med | M |
| mac-screen-demo | Cult UI (licensed) | ui | Demo for the Mac screen frame component | yes | med | M |
| marketing-404-vercel | Cult UI (licensed) | marketing-404 | Vercel-inspired 404 page with dot-grid background, spring entrance animation, dual CTA buttons, and restrained monochromatic design. | yes | high | M |
| marketing-about-minimal | Cult UI (licensed) | marketing-about | Typography-driven about section with photography, scroll-triggered reveals, and restrained editorial aesthetics. | yes | high | M |
| marketing-about-vite | Cult UI (licensed) | marketing-about | Vite-inspired about section with an animated story block, shader visuals, and value cards. | yes | high | M |
| marketing-auth-apple | Cult UI (licensed) | auth | Apple-style authentication page with social login, animated form transitions, and refined visual polish. | yes | med | M |
| marketing-auth-minimal | Cult UI (licensed) | auth | Ultra-clean minimalist authentication page with labeled inputs, subtle animations, and maximum white space. | yes | med | M |
| marketing-auth-texture | Cult UI (licensed) | auth | Texture-style authentication page with social login, layered card chrome, and textured action buttons. | yes | med | M |
| marketing-auth-vite | Cult UI (licensed) | auth | Vite-inspired authentication page with animated form, OAuth providers, and vibrant gradient accents. | yes | med | M |
| marketing-bento-animated | Cult UI (licensed) | marketing-bento | A modern features section with an animated grid layout, icons, and interactive hover states. | yes | high | M |
| marketing-bento-core-capabilities | Cult UI (licensed) | marketing-bento | Light asymmetric bento grid with eyebrow headline, body copy, and five cards with product UI illustrations—knowledge base, research agent, integrations, writing profiles, and visual identity. | yes | high | M |
| marketing-bento-database | Cult UI (licensed) | marketing-bento | A modern features section with an animated grid layout showcasing database, auth, edge functions, and more. | yes | high | M |
| marketing-bento-modern | Cult UI (licensed) | marketing-bento | An alternative features section with a modern grid layout and interactive animations. | yes | high | M |
| marketing-bento-shadcn | Cult UI (licensed) | marketing-bento | Shadcn-inspired marketing bento section with install-path cards, animated workflow visuals, and a developer-focused CTA. | yes | high | M |
| marketing-bento-sharp | Cult UI (licensed) | marketing-bento | Comprehensive bento grid layout showcasing multiple installation and integration methods with animated visuals, interactive cards, and feature highlights. | yes | high | M |
| marketing-bento-texture | Cult UI (licensed) | marketing-bento | Texture-layered marketing bento mirroring the shadcn bento grid: install paths, neutral placeholders, TextureCardStyled tiles, and TextureButton CTAs—no motion. | yes | high | M |
| marketing-bento-vercel | Cult UI (licensed) | marketing-bento | Vercel-inspired marketing bento section with interactive feature cards, framework visualization, and enterprise-focused callouts. | yes | high | M |
| marketing-bento-vite | Cult UI (licensed) | marketing-bento | Vite-inspired bento grid with variable-span cards, gradient accent bars, icon hover animations, and spring-animated entrances. | yes | high | M |
| marketing-blog-texture | Cult UI (licensed) | marketing-blog | Blog listing with featured hero and post grid using TextureCardStyled tiles, Sparkles header chrome, layered hover shadows, staggered motion, and TextureButton CTA. | yes | high | M |
| marketing-blog-vercel | Cult UI (licensed) | marketing-blog | Vercel-inspired blog listing with featured post hero, border-separated post grid, category pills, and staggered spring entrance. | yes | high | M |
| marketing-calculator-agent-roi | Cult UI (licensed) | marketing-pricing | Advanced ROI calculator for AI agent implementations with interactive charts, cost-benefit analysis, and performance projections. Features dynamic input controls, real-time calculations, and comprehensive reporting for strategic decision-making and investment planning. | yes | high | M |
| marketing-changelog-1 | Cult UI (licensed) | marketing-features | Professional changelog interface with version history, feature highlights, and release notes. Features chronological organization, categorized updates, and interactive filtering for transparent product evolution tracking and user communication. | yes | high | M |
| marketing-comparison-hex | Cult UI (licensed) | marketing-comparison | Acme vs spreadsheets comparison table with checks and minuses in a chamfered panel matching the hex family. | yes | high | M |
| marketing-comparison-texture | Cult UI (licensed) | marketing-comparison | Accessible comparison table inside a texture card with nested-border status chips for included features. | yes | high | M |
| marketing-comparison-vercel | Cult UI (licensed) | marketing-comparison | Vercel-inspired product comparison section with bordered before/after panels, interactive feature matrix, and hover text-scramble effects. | yes | high | M |
| marketing-comparison-vite | Cult UI (licensed) | marketing-comparison | Vite-inspired product comparison section with animated before/after panels, speed-line divider, and feature matrix. | yes | high | M |
| marketing-contact-apple | Cult UI (licensed) | forms | Apple-style contact section with validated form, info cards, layered shadows, and spring entrance animations. | yes | med | M |
| marketing-contact-texture | Cult UI (licensed) | forms | Two-column contact section with texture info tiles, TextureCardStyled form, TextureInput fields, and primary submit—no motion. | yes | med | M |
| marketing-contact-vite | Cult UI (licensed) | marketing-cta | Vite-inspired contact section with a polished intake form, shader visuals, and status rail. | yes | high | M |
| marketing-cta-animated | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | M |
| marketing-cta-cosmic | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | M |
| marketing-cta-heerich | Cult UI (licensed) | marketing-cta | Closing band with ziggurat voxel SVG, slow Motion drift, mega-card scrims, and hero-matched dual buttons — two-column on large screens. | yes | high | M |
| marketing-cta-hex | Cult UI (licensed) | marketing-cta | Pre-footer call-to-action with chamfered panel, dual actions, and trust line matching the hex family. | yes | high | M |
| marketing-cta-immersive | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | M |
| marketing-cta-interactive | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | M |
| marketing-cta-particles | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | L |
| marketing-cta-particles-dark | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | L |
| marketing-cta-vite | Cult UI (licensed) | marketing-cta | Vite-inspired CTA section with elevated card, gradient accent bar, spring-animated buttons, and social proof avatars. | yes | high | M |
| marketing-cta-waves | Cult UI (licensed) | marketing-cta | A modern marketing call-to-action section with interactive animations and visual effects. | yes | high | M |
| marketing-download-minimal | Cult UI (licensed) | marketing-download | Editorial-minimal app download page with platform-aware buttons, version metadata, and staggered spring entrance animations. | yes | high | M |
| marketing-faq-accordion | Cult UI (licensed) | marketing-faq | A modern FAQ section with animated accordions and smooth transitions | yes | high | M |
| marketing-faq-apple | Cult UI (licensed) | marketing-faq | Apple-style FAQ section with refined spring animations, noise textures, and smooth accordion transitions. | yes | high | M |
| marketing-faq-hex | Cult UI (licensed) | marketing-faq | FAQ section with chamfered panel and native details/summary disclosures matching the hex marketing family. | yes | high | M |
| marketing-faq-modern | Cult UI (licensed) | marketing-faq | A modern FAQ section with animated accordions and smooth transitions | yes | high | M |
| marketing-faq-vite | Cult UI (licensed) | marketing-faq | Vite-inspired FAQ section with spring-animated accordions, gradient accents, and blur-reveal entrance. | yes | high | M |
| marketing-feature-code | Cult UI (licensed) | ui | Marketing section for code or network policy features | yes | med | M |
| marketing-feature-code-block-1 | Cult UI (licensed) | marketing-features | Feature section with animated code block and syntax highlighting | yes | high | M |
| marketing-feature-code-block-2 | Cult UI (licensed) | marketing-features | Feature section with animated code block and syntax highlighting | yes | high | M |
| marketing-feature-code-block-3 | Cult UI (licensed) | marketing-features | Feature section with animated code block and syntax highlighting | yes | high | M |
| marketing-feature-code-demo | Cult UI (licensed) | ui | Demo for the marketing feature code component | yes | med | M |
| marketing-feature-grid-1 | Cult UI (licensed) | marketing-features | Feature grid showcasing AI marketing agents with tilted card previews and hover effects. Perfect for highlighting product capabilities and use cases. | yes | high | M |
| marketing-feature-minimal | Cult UI (licensed) | marketing-features | Editorial use-cases section: 1024px framed grid, Playfair Display headlines, soft blue labels, alternating copy with vector dashboard mocks (metrics, dual-line chart, automation table) on radial blue and peach fields with dot texture. | yes | high | M |
| marketing-features-accordion-collapse | Cult UI (licensed) | marketing-features | Sticky stacked headers with scroll-driven active panel and fading body copy. | yes | high | M |
| marketing-features-animated | Cult UI (licensed) | marketing-features | Modern features section with interactive animations. | yes | high | M |
| marketing-features-apple-style | Cult UI (licensed) | marketing-features | Apple style feature section with interactive cards. | yes | high | M |
| marketing-features-dark | Cult UI (licensed) | marketing-features | Modern features section with interactive animations. | yes | high | M |
| marketing-features-heerich | Cult UI (licensed) | marketing-features | Four-pillar bento — each card embeds a distinct gallery preset with a slow auto loop (Motion); respects prefers-reduced-motion. | yes | high | M |
| marketing-features-hex | Cult UI (licensed) | marketing-features | Capability grid with chamfered diagonal panels, hatch fills, and coral accent bars matching the hex marketing family. | yes | high | M |
| marketing-features-immersive | Cult UI (licensed) | marketing-features | Cinematic features section with asymmetric bento grid, scroll-driven parallax, spring hover interactions, ambient glow, and grain texture overlay. | yes | high | M |
| marketing-features-interactive | Cult UI (licensed) | marketing-features | Modern features section with interactive animations. | yes | high | M |
| marketing-features-modern | Cult UI (licensed) | marketing-features | Editorial bento grid features section with scroll-triggered staggered reveals, spring-based hover interactions, and animated visual elements per card. | yes | high | M |
| marketing-features-quote-wave | Cult UI (licensed) | marketing-features | Animated quote section with wave text effects. | yes | high | M |
| marketing-features-responsive | Cult UI (licensed) | marketing-features | Editorial bento grid features section with spring-based animations, scroll-triggered reveals, and distinctive typography. | yes | high | M |
| marketing-features-texture | Cult UI (licensed) | marketing-features | Marketing bento grid with layered texture cards—dominant hero tile, satellite cells, and a primary TextureButton CTA. | yes | high | M |
| marketing-features-vite | Cult UI (licensed) | marketing-features | Vite-inspired features section with tab navigation, layoutId-animated indicator, 2-column panel transitions, and highlight list with check icons. | yes | high | M |
| marketing-footer-apple | Cult UI (licensed) | marketing-footer | Apple-style footer with link columns, social icons, staggered entrance animations, and noise texture background. | yes | high | M |
| marketing-footer-vercel | Cult UI (licensed) | marketing-footer | Vercel-inspired footer with border-separated grid, link columns, status indicator, and staggered scroll-triggered entrance. | yes | high | M |
| marketing-footer-vite | Cult UI (licensed) | marketing-footer | Vite-inspired marketing footer with animated gradient divider, composable link columns, newsletter signup, and shader accent. | yes | high | M |
| marketing-gallery-heerich | Cult UI (licensed) | marketing-bento | Asymmetric 12-column grid of voxel SVG presets with lazy mount, hover slice treatment, and optional scroll parallax (respects reduced motion). | yes | high | L |
| marketing-hero-abstract-painting | Cult UI (licensed) | marketing-heroes | Customizable abstract painting with psychedelic effect. | yes | high | M |
| marketing-hero-analytics | Cult UI (licensed) | ui | Analytics hero section for marketing pages | yes | med | M |
| marketing-hero-analytics-demo | Cult UI (licensed) | ui | Demo for the marketing hero analytics component | yes | med | M |
| marketing-hero-animated | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-apple | Cult UI (licensed) | marketing-heroes | Apple-style marketing hero section with refined animations and social proof. | yes | high | M |
| marketing-hero-dither | Cult UI (licensed) | marketing-heroes | Split-layout hero section with responsive dithering shader visuals, CTA, and tech stack badges. | yes | high | M |
| marketing-hero-dithering-simplex | Cult UI (licensed) | marketing-heroes | Full-height hero with two-color simplex dither shader background. | yes | high | M |
| marketing-hero-globe | Cult UI (licensed) | marketing-heroes | Responsive split hero: animated headline and supporting copy on the left, interactive WebGL globe on the right—orbit text, markers, arcs, and DOM labels anchored to the globe. Grid rhythm matches marketing-hero-dither on large screens; stacks cleanly on mobile. | yes | high | M |
| marketing-hero-gradient | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-heerich | Cult UI (licensed) | marketing-heroes | Hero with a voxel sculpture built in heerich.js: stacked masses, carved voids, and SVG output that scales infinitely in the DOM. | yes | high | M |
| marketing-hero-hex | Cult UI (licensed) | marketing-heroes | Marketing hero with clipped diagonal panels, canvas particle sphere, minimal header, CTA, and partner logo strip. | yes | high | M |
| marketing-hero-hyperspace | Cult UI (licensed) | marketing-heroes | Immersive hero section with hyperspace tunnel effect. | yes | high | M |
| marketing-hero-input | Cult UI (licensed) | marketing-heroes | Warm editorial hero section with an oversized search input, animated placeholder cycling, staggered word reveals, suggestion chips, and trust logos. | yes | high | M |
| marketing-hero-input-focused | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-input-simple | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-large-image | Cult UI (licensed) | marketing-heroes | Centered SaaS hero with dot-grid header, staggered headline animation, gradient lower band, and overlapping product screenshot. | yes | high | M |
| marketing-hero-liquid-metal | Cult UI (licensed) | marketing-heroes | Split-layout hero section with responsive LiquidMetal shader visuals, CTA, and tech stack badges. | yes | high | M |
| marketing-hero-logo-cloud | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-moss | Cult UI (licensed) | marketing-heroes | Full-height hero with organic Perlin noise moss shader background. | yes | high | M |
| marketing-hero-nav-menu | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-navigation | Cult UI (licensed) | marketing-heroes | Editorial hero with floating glass navigation, oversized serif typography, spring-animated mega dropdowns, and refined stat cards. | yes | high | M |
| marketing-hero-neuro | Cult UI (licensed) | marketing-heroes | Full-height hero with flowing Neuro noise shader background. | yes | high | M |
| marketing-hero-radial-gradient | Cult UI (licensed) | marketing-heroes | Animated radial gradient background with breathing effect. | yes | high | M |
| marketing-hero-ribbon | Cult UI (licensed) | marketing-heroes | Minimal full-viewport hero with centered copy (max-w-7xl) and a curved SVG-path ribbon of square tiles (path-tangent rotation, hover slowdown). | yes | high | M |
| marketing-hero-simple | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-text-roll | Cult UI (licensed) | marketing-heroes | Modern hero section with gradient background and animations. | yes | high | M |
| marketing-hero-vercel | Cult UI (licensed) | marketing-heroes | Vercel-inspired hero with text-scramble, staggered spring animations, and infinite logo slider. | yes | high | M |
| marketing-hero-vite | Cult UI (licensed) | marketing-heroes | Vite-inspired marketing hero section with animated terminal output and vibrant shader visuals. | yes | high | M |
| marketing-hero-warp | Cult UI (licensed) | marketing-heroes | Full-height hero with animated warp shader background (checks pattern). | yes | high | M |
| marketing-integrations-1 | Cult UI (licensed) | marketing-integrations | Dynamic integrations showcase featuring popular third-party services and APIs with seamless connection capabilities. Displays integration status, configuration options, and real-time connectivity testing for enhanced platform connectivity and workflow automation. | yes | high | M |
| marketing-integrations-2 | Cult UI (licensed) | marketing-integrations | Circular fan-out layout showcasing AI integrations with radiating connection lines. Features interactive hover effects, tooltips, and dynamic positioning for visual integration highlights. | yes | high | M |
| marketing-integrations-hex | Cult UI (licensed) | marketing-integrations | Integration logo grid with SVG marks (same set as horizontal rail) inside a chamfered hex panel. | yes | high | M |
| marketing-integrations-horizontal | Cult UI (licensed) | marketing-integrations | Split-layout integrations section with editorial copy, horizontal logo rails, staggered entrance motion, and product-style integration cards. | yes | high | M |
| marketing-integrations-vertical | Cult UI (licensed) | marketing-integrations | Diamond-shaped logo grid with radial gradient fade, staggered spring entrance animations, and layered shadow depth. Showcases tech stack integrations. | yes | high | M |
| marketing-model-comparison-2 | Cult UI (licensed) | marketing-comparison | Compare AI models like GPT-4, Claude, and Gemini. Includes filtering, sorting, performance metrics, and pricing data. | yes | high | L |
| marketing-model-comparison-2-compact | Cult UI (licensed) | marketing-comparison | Compare AI models in a compact table format. Includes horizontal scrolling, sortable columns, and condensed data for quick evaluation. | yes | high | L |
| marketing-model-comparison-2-hover | Cult UI (licensed) | marketing-comparison | Compare AI models with hover details for GPT-4, Claude, and Gemini. Includes filtering, sorting, and performance metrics. | yes | high | L |
| marketing-model-comparison-table-1 | Cult UI (licensed) | marketing-comparison | Comprehensive comparison table showcasing leading AI models with detailed performance metrics, pricing analysis, and capability assessments. Features interactive filtering, sorting capabilities, and side-by-side comparisons for informed model selection and evaluation. | yes | high | L |
| marketing-nav-floating | Cult UI (licensed) | marketing-navigation | Floating glass pill navigation with spring mega-dropdowns, promo callout card, scroll-aware blur, and mobile accordion — same nav pattern as the hero-navigation marketing section. | yes | high | M |
| marketing-nav-minimal | Cult UI (licensed) | marketing-navigation | Clean minimal navigation with mega-menu dropdowns, hover interactions, promo cards, and mobile accordion menu. | yes | high | M |
| marketing-nav-vercel | Cult UI (licensed) | marketing-navigation | Vercel-inspired navigation with border-divided aesthetic, monochromatic palette, and restrained scroll behavior. | yes | high | M |
| marketing-navigation-apple | Cult UI (licensed) | marketing-navigation | Apple-style sticky navigation with scroll-aware backdrop blur, layoutId active indicator, and animated mobile menu. | yes | high | M |
| marketing-navigation-vite | Cult UI (licensed) | marketing-navigation | Scroll-aware sticky navigation header with spring-based animations, matching the hero-vite design language. | yes | high | M |
| marketing-pricing-apple | Cult UI (licensed) | marketing-pricing | Apple-style pricing section with animated billing toggle, layered shadow cards, and spring-based price transitions. | yes | high | M |
| marketing-pricing-hex | Cult UI (licensed) | marketing-pricing | Three-tier pricing with chamfered panels, monthly/annual toggle, and highlighted tier stroke matching the hex family. | yes | high | M |
| marketing-pricing-texture | Cult UI (licensed) | marketing-pricing | Three-column pricing with TextureCardStyled tiers, muted popular emphasis, tabular prices, and TextureButton CTAs. | yes | high | M |
| marketing-pricing-vercel | Cult UI (licensed) | marketing-pricing | Vercel-inspired pricing section with border-separated tier grid, animated billing toggle, and spring-based price transitions. | yes | high | M |
| marketing-pricing-vite | Cult UI (licensed) | marketing-pricing | Vite-inspired 3-tier pricing section with spring-animated billing toggle, gradient accents, and staggered card entrance. | yes | high | M |
| marketing-process-heerich | Cult UI (licensed) | marketing-roadmap | Three-step timeline with a mini voxel sculpture per phase (monolith, lantern, ziggurat), Motion loops, and the same stone / void step badges. | yes | high | M |
| marketing-roadmap-0 | Cult UI (licensed) | marketing-roadmap | Roadmap section with close line animations. Features timeline visualization, milestone tracking, and smooth scroll-triggered animations for showcasing product development progress. | yes | high | M |
| marketing-roadmap-vite | Cult UI (licensed) | marketing-roadmap | Vite-inspired roadmap timeline with vertical gradient line, status-colored nodes, alternating cards, and spring animations. | yes | high | M |
| marketing-stats-globe | Cult UI (licensed) | marketing-stats | Statistics section with an interactive 3D globe visualization powered by cobe and animated metric cards with spring-based counters. | yes | high | M |
| marketing-stats-hex | Cult UI (licensed) | marketing-stats | Four-metric band with tabular numerals and dividers inside one chamfered panel matching the hex family. | yes | high | M |
| marketing-stats-vite | Cult UI (licensed) | marketing-stats | Vite-inspired hero-sized statistics section with animated counters, gradient accent bars, and trend indicators. | yes | high | M |
| marketing-sticky-section | Cult UI (licensed) | marketing-features | Sticky scroll-linked marketing section with interactive project navigation, synchronized panels, and image-backed storytelling for product showcases. | yes | high | M |
| marketing-team-animated | Cult UI (licensed) | marketing-team | Team showcase with animations. Features team member cards, hover effects, and smooth transitions for creating a team presentation experience. | yes | high | M |
| marketing-team-minimal | Cult UI (licensed) | marketing-team | Minimal team showcase section. Features avatar displays, role descriptions, and subtle animations for presenting team members in marketing and product pages. | yes | high | M |
| marketing-team-vite | Cult UI (licensed) | marketing-team | Vite-inspired team section with spring-animated cards, gradient accents, blur-reveal heading, and social links. | yes | high | M |
| marketing-teams-vercel | Cult UI (licensed) | marketing-team | Vercel-inspired team section with border-separated grid, spring-animated entrance with blur-reveal, avatar social links, and restrained monochromatic design. | yes | high | M |
| marketing-testimonials-hex | Cult UI (licensed) | marketing-social-proof | Featured quote plus two chamfered tiles with optional initials avatars matching the hex marketing family. | yes | high | M |
| marketing-waitlist-minimal | Cult UI (licensed) | marketing-waitlist | Conversion-focused waitlist page with email capture, social proof avatar stack, and staggered spring entrance. | yes | high | M |
| merging-bubbles | Cult UI (licensed) | ui | Merging bubbles visualization | yes | med | M |
| merging-bubbles-demo | Cult UI (licensed) | ui | Demo for the merging bubbles component | yes | med | M |
| nextjs-forms-validation | Cult UI (licensed) | forms | Form handling system with server actions and Zod validation. Features client-side validation, server-side processing, and type-safe form submissions for modern web applications. | yes | med | M |
| openai-chatbot-ai-sdk | Cult UI (licensed) | ai | Chatbot implementation using OpenAI's GPT-5-nano and AI SDK. Features streaming responses, conversation history, and real-time chat interface for natural language interactions. | yes | med | L |
| organic | Cult UI (licensed) | landing-page | Full-page layout: sticky organic navbar, dither simplex hero, scrolling project gallery (camera + dual marquee), social proof band, pattern guide with organic cards, shader settings spec, interactive tabs illustration, who-it's-for columns, FAQ accordion, primary CTA with organic button, and footer. Plum, magenta, and lime brand system. | yes | med | M |
| organic--banner-section | Cult UI (licensed) | landing-page | The banner section section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--faq | Cult UI (licensed) | landing-page | The faq section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--hero | Cult UI (licensed) | landing-page | The hero section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--pattern-guide | Cult UI (licensed) | landing-page | The pattern guide section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--primary-cta | Cult UI (licensed) | landing-page | The primary cta section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--shader-settings | Cult UI (licensed) | landing-page | The shader settings section of the Organic Dither page, converted on its own. | yes | med | L |
| organic--site-footer | Cult UI (licensed) | landing-page | The site footer section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--social-proof | Cult UI (licensed) | landing-page | The social proof section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--tabs-showcase | Cult UI (licensed) | landing-page | The tabs showcase section of the Organic Dither page, converted on its own. | yes | med | M |
| organic--use-cases | Cult UI (licensed) | landing-page | The use cases section of the Organic Dither page, converted on its own. | yes | med | M |
| organic-button | Cult UI (licensed) | ui | Anchor-based CTA with fixed SVG end caps, shared surface colors via CSS variables, and size and animation variants | yes | med | S |
| organic-button-demo | Cult UI (licensed) | ui | Demo for the organic-shaped CTA anchor with sizes, colors, and custom icon | yes | med | S |
| organic-card | Cult UI (licensed) | ui | Composable marketing card with optional link root, image slot, eyebrow/title/body, accent band, and footer CTA | yes | med | M |
| organic-card-demo | Cult UI (licensed) | ui | Demo for the organic marketing card with image, band, and footer CTA | yes | med | M |
| organic-card-small | Cult UI (licensed) | ui | Compact card with SVG silhouette, category and date, motion morph on hover, and optional link | yes | med | M |
| organic-card-small-demo | Cult UI (licensed) | ui | Demo for the compact organic silhouette card with motion hover | yes | med | M |
| polar-payment-subscription | Cult UI (licensed) | payments | Payment system powered by Polar.sh. Features product configuration, secure payment processing, webhook integration, and subscription management for creators and businesses. | yes | med | M |
| polished-expansion | Cult UI (licensed) | expansion-packs | A collection of polished shadcn/ui style components. | yes | med | M |
| react-server-components-ai-ui | Cult UI (licensed) | ai | UI generation using React Server Components and AI. Creates interfaces based on user input, demonstrating server-side rendering patterns and AI component generation. | yes | med | M |
| reddit-editor-agent | Cult UI (licensed) | ai | A Reddit editor agent that uses the AI SDK to edit Reddit posts. | yes | med | M |
| sass-colorful | Cult UI (licensed) | landing-page | Full-page marketing layout: navbar, hero, social proof, how-it-works steps, features, testimonials, integrations, primary CTA, FAQ, and footer. | yes | med | M |
| sass-colorful--faq | Cult UI (licensed) | landing-page | The faq section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--features | Cult UI (licensed) | landing-page | The features section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--hero | Cult UI (licensed) | landing-page | The hero section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--how-it-works | Cult UI (licensed) | landing-page | The how it works section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--integrations | Cult UI (licensed) | landing-page | The integrations section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--navbar | Cult UI (licensed) | landing-page | The navbar section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--primary-cta | Cult UI (licensed) | landing-page | The primary cta section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--site-footer | Cult UI (licensed) | landing-page | The site footer section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--social-proof | Cult UI (licensed) | landing-page | The social proof section of the SaaS Colorful page, converted on its own. | yes | med | M |
| sass-colorful--testimonials | Cult UI (licensed) | landing-page | The testimonials section of the SaaS Colorful page, converted on its own. | yes | med | M |
| security-checkpoint | Cult UI (licensed) | ui | Security checkpoint illustration or component | yes | med | M |
| security-checkpoint-demo | Cult UI (licensed) | ui | Demo for the security checkpoint component | yes | med | M |
| shadow-card | Cult UI (licensed) | ui | Composable marketing card with L-shaped extrusion, optional pixel gradient mesh, and Radix Slot on the root | yes | med | M |
| shadow-card-demo | Cult UI (licensed) | ui | Demo for the shadow card — extruded edge, backdrop, pixel gradient, and composable slots | yes | med | M |
| social-proof-apple | Cult UI (licensed) | marketing-social-proof | Apple-style social proof section with animated stats, testimonial cards, and logo strip. | yes | high | M |
| social-proof-vercel | Cult UI (licensed) | marketing-social-proof | Vercel-inspired social proof section with animated stat counters, testimonial grid, logo marquee, and trust banner using border-separated grid design language. | yes | high | M |
| social-proof-vite | Cult UI (licensed) | marketing-social-proof | Vite-inspired social proof section with logo marquee, animated metrics, and developer testimonial cards. | yes | high | M |
| speech-bubble | Cult UI (licensed) | ui | Speech bubble component | yes | med | M |
| speech-bubble-demo | Cult UI (licensed) | ui | Demo for the speech bubble component | yes | med | M |
| stripe-upstash-subscription | Cult UI (licensed) | payments | Subscription management system with Stripe and Redis. Features secure payment processing, webhook handling, subscription lifecycle management, and customer portal integration. | yes | med | M |
| supabase-semantic-image-search | Cult UI (licensed) | ai | Image search using OpenAI embeddings and Supabase Vector Store | yes | med | M |
| tabs-illustration-vercel | Cult UI (licensed) | ui | Tabs with Vercel-style illustrations | yes | med | M |
| tabs-illustration-vercel-demo | Cult UI (licensed) | ui | Demo for the tabs illustration Vercel component | yes | med | M |
| trigger-dev-actions | Cult UI (licensed) | featured | A block demonstrating how to create and manage background tasks using Trigger.dev v3 | yes | high | M |
| vercel-ai-sdk-core | Cult UI (licensed) | ai | Vercel AI SDK Core is a library that provides a set of tools for building AI agents. | yes | med | M |
| vercel-collab-toolbar-demo | Cult UI (licensed) | ui | Demo for the Vercel collab toolbar component | yes | med | M |
| wizard-expandable | Cult UI (licensed) | ui | Expandable multi-step wizard with optional forward validation, scrollable step rail, and Motion height transitions | yes | med | M |
| wizard-expandable-demo | Cult UI (licensed) | ui | Demo for the expandable step wizard with validation and Motion transitions | yes | med | M |

## Verification and handoff

The final catalog has 77 entries, of which 76 have code and demos. The one existing planned entry remains planned. The 14 new entries are `gradient-text`, `count-up`, `rotating-text`, `decrypted-text`, `animated-content`, `magnet`, `star-border`, `logo-loop`, `dot-grid`, `light-rays`, `waves`, `animated-list`, `text-type`, and `pixel-transition`. New bundles peak at 4,195 bytes of JS and 2,032 bytes of CSS, under the 8,192 / 6,144 byte limits.

| Command | Receipt |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | Passed; pinned Node 24.16.0 / pnpm 10.33.2. Workspace postinstall was skipped to preserve the worker path boundary. |
| `pnpm --filter @mish/genui-catalog build` | Passed; generated 77-entry catalog data with 76 implemented previews. |
| `pnpm --filter @mish/genui-catalog typecheck` | Passed; source, component, script, and test declarations. |
| `pnpm --filter @mish/genui-catalog check` | Passed; catalog matches seed/meta and measured bundles. |
| `pnpm --filter @mish/genui-catalog test` | Passed: 763 tests in 69 files. Baseline: 660 tests in 67 files. Added: 103 tests in two files. Existing jsdom canvas/media “not implemented” notices remain non-fatal. |
| `pnpm guard` | Could not start: missing `@mish/contracts/dist/index.mjs`. The fresh worktree has no other workspace build outputs. No files in contracts, apps, or other packages were generated or edited. |
| `TSX_TSCONFIG_PATH=packages/genui-catalog/.tmp/guard-tsconfig.json pnpm guard` | Passed, exit 0. Temporary aliases resolve missing workspace exports to their checked-in TypeScript sources. This is a source-mode guard receipt, not proof of built workspace package exports. The ignored config stays in this worktree; integration should bootstrap its normal workspace dependencies and run plain guard. |
| `pnpm --filter @mish/genui-catalog preview:harvest` | Passed; generates `.tmp/harvest-preview.html` and standalone normal/reduced demo documents. Offline preview sheet opened in EGO Lite. |
| `git diff --check` | Passed. All tracked changes stay in the allowed GenUI package and this report. |

Browser checks used the actual built sandbox demos in Chromium, at 390 × 844 and 1,240 × 860 CSS pixels. All 14 mounted at both widths with document width equal to viewport width. All 14 forced-reduced-motion demos had zero running animations. Updated text variants retain words and grapheme clusters; keyboard Space toggled pixel faces and both pause buttons; pixel focus showed an outline; live system reduced motion preserved focus on the rotating-text button and stopped its animation. The reduced logo strip displayed all original marks without the duplicate. These receipts do not claim Safari, physical-device, or assistive-technology testing. Screenshots and JSON receipts remain under `packages/genui-catalog/.tmp/` as ignored local QA artifacts.

The preview uses fictional sample studio copy and placeholder metrics, not factual client claims. Finite effects have a visible static fallback when observer/animation APIs are unavailable. Text effects preserve interactive descendants as a static fallback. Repeated `destroy()` restores original markup, nodes, and listeners. Source tests cover cancellation, option precedence, reduced-motion changes, inert clone IDs, observer cleanup, and default palette contrast.

Independent packet review used the subscription `grok-4.7-build` lane through `codex-senior-review`. Session `01a11f48-9ae5-7d31-95e1-97cd1e51b76f` completed with `stopReason: end_turn` after resuming its initially cancelled request. Scope: all 14 component sources/CSS, the runtime helper, catalog builder, and initial behavior tests in a static packet. The review returned no BLOCK, three WARN, and four NIT findings. It did not inspect rendered pixels.

Verified findings and disposition:

- Word wrapping: fixed during browser QA before the final review returned. Text effects now group graphemes within word wrappers; the 390px settled headline keeps whole ordinary words.
- Hidden-text positioning: fixed during browser QA. Low-specificity positioned hosts anchor each readable span at top/left zero.
- Pixel coverage: verified and fixed. Tiles hold a wider opaque plateau, stagger scales to duration, and the face switches at the center of the shared plateau. Durations below 160ms snap. A browser MutationObserver captured all 32 tile opacities at exactly 1 at the semantic swap. The review's suggested raw last-delay addition was not used because it could outlast the leading tile's cover.
- Pixel layout: replaced the hidden-attribute CSS override with an inactive class, `aria-hidden`, and `inert`; both faces remain in the grid. This also closes the review's hypothetical UA-style conflict.
- Pause target height: already fixed at 44px.
- Resume while focused: verified and fixed by limiting automatic hover/focus pausing to the visual stage/viewport. Keyboard Space resumed the logo animation and rotated to the next word while focus stayed on its control.
- Missing IntersectionObserver: added a bounded viewport-geometry fallback for logo-loop, with abortable scroll/resize listeners. The new test confirms an offscreen loop pauses without the observer.
- Invalid pixel markup retaining its mounted marker: retained as the existing static-fallback/idempotent-mount contract. Call `destroy()` before retrying with changed markup; no nodes or data are lost.

Raw review packets, source hashes, model usage, completed response, test logs, and browser receipts are retained in ignored `.tmp/` artifacts. Final source tests and browser checks verified the fixes; Grok did not re-review the final patch. Implementation checkpoint: `6a3e5a6fe1`; the final receipt commit changes only this report.

## Deferred work

Shader-heavy fluids, physically simulated balls, advanced cursor replacements, spatial galleries, and 3D scenes remain gaps. They need larger performance and device-validation budgets. Generic pricing, feature, and testimonial sections already have licensed Cult coverage; this branch focuses on missing effect behaviors. No 21st generated metadata or existing originals needed changes. The application catalog publishing and Agency asset sync belong to integration ownership and were not run under this worker contract.
