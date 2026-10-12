import { marketingRecipe } from './marketing-scaffold.js';

export const MARKETING_RECIPE_IDS = [
  'hero-lines', 'hero-words', 'scroll-parallax', 'card-stagger', 'image-mask', 'number-counter',
  'sticky-story', 'logo-marquee', 'magnetic-button', 'page-transition', 'section-pin', 'cursor-follower', 'hover-tilt', 'image-crossfade',
] as const;

const contact = '<a href="#contact" data-od-action="contact">Discuss a project</a>';
const artCss = '[data-od-art] { min-height: 18rem; border-radius: 1rem; background: radial-gradient(circle at 35% 35%, var(--od-recipe-accent, #1f4f7a), transparent 55%), linear-gradient(135deg, #edf1f5, #bcc8d4); }';

export const MARKETING_RECIPES = {
  'hero-lines': marketingRecipe({
    id: 'hero-lines', title: 'Hero line reveal', component: 'GsapHeroLines',
    purpose: 'Reveal pre-authored headline lines inside clipped wrappers while the primary link stays available',
    trigger: 'mount, once per media context', reducedMotion: 'Complete headline at rest; no clipping or translation',
    markup: `<h2><span class="od-line-mask"><span data-od-animate>Make room for</span></span><span class="od-line-mask"><span data-od-animate>your next idea.</span></span></h2>
<p>A workspace for thoughtful teams.</p>
${contact}`,
    css: '.od-marketing-hero-lines .od-line-mask { display: block; overflow: clip; padding-bottom: 0.08em; }\n.od-marketing-hero-lines [data-od-animate] { display: block; }',
    motion: `      gsap.from(all('[data-od-animate]'), { yPercent: 105, duration: 0.55, stagger: 0.08, ease });`,
  }),
  'hero-words': marketingRecipe({
    id: 'hero-words', title: 'Hero word reveal', component: 'GsapHeroWords',
    purpose: 'Introduce a short headline word by word without splitting or rewriting its text at runtime',
    trigger: 'mount, once per media context', reducedMotion: 'All words remain readable in their natural position',
    markup: `<h2><span data-od-animate>Ideas</span> <span data-od-animate>deserve</span> <span data-od-animate>room.</span></h2>
<p>Bring the work into focus.</p>
${contact}`,
    css: '.od-marketing-hero-words h2 [data-od-animate] { display: inline-block; }',
    motion: `      gsap.from(all('[data-od-animate]'), { opacity: 0, y: 16, duration: 0.35, stagger: 0.045, ease });`,
  }),
  'scroll-parallax': marketingRecipe({
    id: 'scroll-parallax', title: 'Scroll-linked parallax', component: 'GsapScrollParallax', plugins: ['ScrollTrigger'],
    purpose: 'Move an original decorative field a short distance behind stationary section copy using native scroll',
    trigger: 'section crosses the viewport, top bottom to bottom top', reducedMotion: 'Decorative field stays centered; no scroll trigger',
    markup: `<h2>A different perspective</h2>
<div class="od-parallax-window"><div data-od-art data-od-animate aria-hidden="true"></div></div>
<p>Depth supports the story without moving the controls.</p>
${contact}`,
    css: `.od-marketing-scroll-parallax .od-parallax-window { display: flow-root; overflow: clip; border-radius: 1rem; }
.od-marketing-scroll-parallax [data-od-art] { margin-block: -48px; }
${artCss.replace('[data-od-art]', '.od-marketing-scroll-parallax [data-od-art]')}
.od-marketing-scroll-parallax [data-od-art] { min-height: 24rem; }`,
    motion: `      gsap.fromTo(q('[data-od-animate]'), { y: -40 }, { y: 40, ease: 'none',
        scrollTrigger: { trigger: scope, start: 'top bottom', end: 'bottom top', scrub: 0.35, invalidateOnRefresh: true } });`,
  }),
  'card-stagger': marketingRecipe({
    id: 'card-stagger', title: 'Staggered card entrance', component: 'GsapCardStagger', plugins: ['ScrollTrigger'],
    purpose: 'Bring a small card group into view in reading order with a single entrance trigger',
    trigger: 'card grid reaches top 85% of viewport, once', reducedMotion: 'Entire grid is visible; no entrance or trigger',
    markup: `<h2>Three ways to begin</h2>
<div class="od-card-grid"><article data-od-animate><h3>Explore</h3><p>Gather your references.</p></article><article data-od-animate><h3>Shape</h3><p>Find the useful structure.</p></article><article data-od-animate><h3>Refine</h3><p>Make each detail count.</p></article></div>
${contact}`,
    css: '.od-marketing-card-stagger .od-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: 1rem; margin-block: 1.5rem; }\n.od-marketing-card-stagger article { padding: 1.5rem; border: 1px solid currentColor; border-radius: 1rem; }',
    motion: `      gsap.from(all('[data-od-animate]'), { opacity: 0, y: 24, duration: 0.45, stagger: 0.075, ease,
        scrollTrigger: { trigger: q('.od-card-grid'), start: 'top 85%', once: true } });`,
  }),
  'image-mask': marketingRecipe({
    id: 'image-mask', title: 'Image mask reveal', component: 'GsapImageMask', plugins: ['ScrollTrigger'],
    purpose: 'Open a vertical image mask on entry using an original CSS artwork placeholder that can be replaced with an owned image',
    trigger: 'artwork reaches top 85% of viewport, once', reducedMotion: 'Full image is visible; no clip-path or trigger',
    markup: `<h2>See the whole picture</h2>
<div data-od-art data-od-animate role="img" aria-label="Abstract blue field"></div>
<p>Replace this original field with your project image.</p>
${contact}`,
    css: artCss.replace('[data-od-art]', '.od-marketing-image-mask [data-od-art]'),
    motion: `      gsap.fromTo(q('[data-od-animate]'), { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 0.6, ease,
        scrollTrigger: { trigger: q('[data-od-art]'), start: 'top 85%', once: true } });`,
  }),
  'number-counter': marketingRecipe({
    id: 'number-counter', title: 'Metric counter', component: 'GsapNumberCounter', plugins: ['ScrollTrigger'],
    purpose: 'Count a clearly labelled sample metric once; assistive technology receives the final value without repeated announcements',
    trigger: 'metric reaches top 85% of viewport, once', reducedMotion: 'Final value is visible from server render and restored on live preference change',
    markup: `<h2>A sample milestone</h2>
<p><span class="od-counter" data-od-counter data-od-animate aria-hidden="true">128</span><span class="od-counter-sr">128</span> projects in this example</p>
<p>Replace the sample with a verified project metric.</p>
${contact}`,
    css: '.od-marketing-number-counter .od-counter { font-size: clamp(3rem, 9vw, 6rem); font-variant-numeric: tabular-nums; }\n.od-marketing-number-counter .od-counter-sr { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }',
    motion: `      const counter = q('[data-od-counter]');
      const finalText = counter.textContent;
      const value = Number(finalText);
      cleanups.push(() => { counter.textContent = finalText; });
      gsap.fromTo(counter, { textContent: 0 }, { textContent: value, snap: { textContent: 1 }, duration: 0.6, ease,
        scrollTrigger: { trigger: counter, start: 'top 85%', once: true } });`,
  }),
  'sticky-story': marketingRecipe({
    id: 'sticky-story', title: 'Sticky scroll story', component: 'GsapStickyStory', plugins: ['ScrollTrigger'], desktopScroll: true,
    purpose: 'Hold a decorative illustration beside three chapters that remain in the natural reading and scroll order',
    trigger: 'desktop story top reaches top +24 px; releases at story bottom, with native scroll',
    reducedMotion: 'Unpinned illustration and complete chapters in normal flow; small or short viewports use the same fallback',
    markup: `<h2>From rough idea to useful work</h2>
<div class="od-sticky-grid"><div class="od-sticky-visual" data-od-animate aria-hidden="true"><div data-od-art></div><span data-od-orbit data-od-animate></span></div><div class="od-sticky-chapters"><article><h3>Gather</h3><p>Find the references that matter.</p></article><article><h3>Compose</h3><p>Give the ideas a clear structure.</p></article><article><h3>Refine</h3><p>Make the details serve the purpose.</p></article></div></div>
${contact}`,
    css: `.od-marketing-sticky-story .od-sticky-grid { display: grid; gap: 2rem; }
.od-marketing-sticky-story .od-sticky-visual { position: relative; align-self: start; }
.od-marketing-sticky-story [data-od-orbit] { position: absolute; width: 4rem; height: 4rem; left: 45%; top: 40%; border: 2px solid currentColor; border-radius: 50%; }
.od-marketing-sticky-story .od-sticky-chapters article { padding-block: 2rem; }
@media (min-width: 768px) and (min-height: 600px) and (prefers-reduced-motion: no-preference) { .od-marketing-sticky-story .od-sticky-grid { grid-template-columns: 1fr 1fr; } .od-marketing-sticky-story .od-sticky-chapters article { min-height: 55vh; } }
${artCss.replace('[data-od-art]', '.od-marketing-sticky-story [data-od-art]')}`,
    motion: `      gsap.to(q('[data-od-orbit]'), { rotation: 120, ease: 'none', scrollTrigger: {
        trigger: q('.od-sticky-grid'), start: 'top top+=24', end: 'bottom bottom', scrub: 0.4,
        pin: q('.od-sticky-visual'), pinSpacing: false, invalidateOnRefresh: true,
      } });`,
  }),
  'logo-marquee': marketingRecipe({
    id: 'logo-marquee', title: 'Pausable logo marquee', component: 'GsapLogoMarquee',
    purpose: 'Loop original placeholder wordmarks with an explicit pause control and temporary hover/focus pause',
    trigger: 'mount; continuous until paused, pointer hover or keyboard focus',
    reducedMotion: 'One wrapping static wordmark group; duplicate and motion control hidden',
    markup: `<h2>Built with good company</h2>
<div class="od-loop-window"><div class="od-loop-track" data-od-animate><ul data-od-logos><li>North</li><li>Field</li><li>Orbit</li><li>Plain</li><li>Kind</li></ul><ul data-od-logos aria-hidden="true"><li>North</li><li>Field</li><li>Orbit</li><li>Plain</li><li>Kind</li></ul></div></div>
<button class="od-loop-control" type="button" data-od-action="pause" data-od-pause-label="Pause logos" data-od-resume-label="Resume logos" aria-pressed="false">Pause logos</button>
${contact}`,
    css: `.od-marketing-logo-marquee .od-loop-window { overflow: clip; margin-block: 2rem; }
.od-marketing-logo-marquee .od-loop-track { display: flex; width: auto; }
.od-marketing-logo-marquee [data-od-logos] { display: flex; gap: 3rem; padding: 1rem 3rem 1rem 0; margin: 0; list-style: none; font-size: 1.5rem; flex-wrap: wrap; }
.od-marketing-logo-marquee [aria-hidden=true], .od-marketing-logo-marquee .od-loop-control { display: none; }
.od-marketing-logo-marquee.od-loop-active .od-loop-track { width: max-content; }
.od-marketing-logo-marquee.od-loop-active [data-od-logos] { flex-wrap: nowrap; white-space: nowrap; }
.od-marketing-logo-marquee.od-loop-active [aria-hidden=true] { display: flex; }
.od-marketing-logo-marquee.od-loop-active .od-loop-control { display: inline-flex; }
@media (prefers-reduced-motion: reduce) { .od-marketing-logo-marquee .od-loop-track { width: auto; } .od-marketing-logo-marquee [data-od-logos] { flex-wrap: wrap; } .od-marketing-logo-marquee [aria-hidden=true], .od-marketing-logo-marquee .od-loop-control { display: none; } }`,
    motion: `      scope.classList.add('od-loop-active');
      cleanups.push(() => scope.classList.remove('od-loop-active'));
      const button = q('[data-od-action="pause"]');
      const loop = gsap.to(q('.od-loop-track'), { xPercent: -50, duration: 18, repeat: -1, ease: 'none' });
      let hovering = false;
      let focused = scope.contains(scope.ownerDocument.activeElement);
      const sync = () => loop.paused(button.getAttribute('aria-pressed') === 'true' || hovering || focused);
      sync();
      on(button, 'click', () => {
        const paused = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(paused));
        button.textContent = paused ? (button.dataset.odResumeLabel || button.textContent) : (button.dataset.odPauseLabel || button.textContent);
        sync();
      });
      on(scope, 'pointerenter', () => { hovering = true; sync(); });
      on(scope, 'pointerleave', () => { hovering = false; sync(); });
      on(scope, 'focusin', () => { focused = true; sync(); });
      on(scope, 'focusout', () => { focused = scope.contains(scope.ownerDocument.activeElement); sync(); });`,
  }),
  'magnetic-button': marketingRecipe({
    id: 'magnetic-button', title: 'Magnetic button label', component: 'GsapMagneticButton', finePointer: true,
    purpose: 'Let the decorative button label follow a fine pointer within a stationary link hit target',
    trigger: 'fine-pointer movement over the link; release on leave or keyboard focus', reducedMotion: 'Stationary labelled link; no pointer listeners or transforms',
    markup: `<h2>Meet your next collaborator</h2>
<a href="#contact" data-od-action="contact" aria-label="Discuss a project"><span data-od-animate aria-hidden="true">Discuss a project ↗</span></a>`,
    css: '.od-marketing-magnetic-button [data-od-animate] { display: inline-block; pointer-events: none; }',
    motion: `      const button = q('[data-od-action]');
      const label = q('[data-od-animate]');
      const xTo = gsap.quickTo(label, 'x', { duration: 0.3, ease });
      const yTo = gsap.quickTo(label, 'y', { duration: 0.3, ease });
      const reset = () => { xTo(0); yTo(0); };
      pointer(button, (x, y) => {
        if (scope.ownerDocument.activeElement === button) return;
        const box = button.getBoundingClientRect();
        xTo(gsap.utils.clamp(-8, 8, (x - box.width / 2) * 0.12));
        yTo(gsap.utils.clamp(-8, 8, (y - box.height / 2) * 0.12));
      });
      on(button, 'pointerleave', reset);
      on(button, 'focus', reset);`,
  }),
  'page-transition': marketingRecipe({
    id: 'page-transition', title: 'Incoming page transition', component: 'GsapPageTransition',
    purpose: 'Introduce incoming page copy on mount while normal links navigate immediately; mount the component with each route change',
    trigger: 'incoming page mount; host router remount supplies route changes', reducedMotion: 'Incoming page is immediately visible with native link navigation',
    markup: `<h2 data-od-animate>A fresh point of view</h2>
<p data-od-animate>Give the next page a short, readable entrance.</p>
<nav aria-label="Example page links"><a href="#overview" data-od-action="overview">Overview</a> <a href="#contact" data-od-action="contact">Contact</a></nav>`,
    motion: `      gsap.from(all('[data-od-animate]'), { opacity: 0, y: 12, duration: 0.3, stagger: 0.05, ease });`,
  }),
  'section-pin': marketingRecipe({
    id: 'section-pin', title: 'Bounded section pin', component: 'GsapSectionPin', plugins: ['ScrollTrigger'], desktopScroll: true,
    purpose: 'Hold one short product scene for a bounded scroll distance while its decorative field shifts; native scroll remains in charge',
    trigger: 'desktop scene top reaches top +24 px, then one capped viewport-height scroll span',
    reducedMotion: 'Ordinary unpinned scene; small or short viewports also stay in normal flow',
    markup: `<h2>A closer look</h2>
<div class="od-pin-scene" data-od-animate><div data-od-art data-od-animate aria-hidden="true"></div><p>One idea, enough room to see it.</p></div>
${contact}`,
    css: `.od-marketing-section-pin .od-pin-scene { overflow: clip; border-radius: 1rem; padding: 1rem; border: 1px solid currentColor; }
${artCss.replace('[data-od-art]', '.od-marketing-section-pin [data-od-art]')}`,
    motion: `      gsap.fromTo(q('[data-od-art]'), { x: -16 }, { x: 16, ease: 'none', scrollTrigger: {
        trigger: q('.od-pin-scene'), start: 'top top+=24', end: () => '+=' + Math.min(600, (scope.ownerDocument.documentElement.clientHeight || 800) * 0.75),
        pin: q('.od-pin-scene'), scrub: 0.4, invalidateOnRefresh: true,
      } });`,
  }),
  'cursor-follower': marketingRecipe({
    id: 'cursor-follower', title: 'Scoped cursor follower', component: 'GsapCursorFollower', finePointer: true,
    purpose: 'Add a decorative follower inside one demo surface while preserving the native cursor and all link targets',
    trigger: 'fine-pointer movement inside the surface; fades on leave', reducedMotion: 'Follower absent; native cursor and section content unchanged',
    markup: `<h2>Move through the field</h2>
<div class="od-cursor-zone"><p>Explore this surface with a pointer.</p><span data-od-dot data-od-animate aria-hidden="true"></span></div>
${contact}`,
    css: `.od-marketing-cursor-follower .od-cursor-zone { position: relative; overflow: clip; min-height: 18rem; padding: 1rem; border: 1px solid currentColor; border-radius: 1rem; }
.od-marketing-cursor-follower [data-od-dot] { position: absolute; top: 0; left: 0; width: 20px; height: 20px; box-sizing: content-box; border: 2px solid currentColor; border-radius: 50%; pointer-events: none; opacity: 0; display: none; }
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) { .od-marketing-cursor-follower [data-od-dot] { display: block; } }`,
    motion: `      const zone = q('.od-cursor-zone');
      const dot = q('[data-od-dot]');
      const xTo = gsap.quickTo(dot, 'x', { duration: 0.25, ease });
      const yTo = gsap.quickTo(dot, 'y', { duration: 0.25, ease });
      const alphaTo = gsap.quickTo(dot, 'opacity', { duration: 0.2, ease });
      pointer(zone, (x, y) => { xTo(x - 12); yTo(y - 12); alphaTo(1); });
      on(zone, 'pointerleave', () => alphaTo(0));`,
  }),
  'hover-tilt': marketingRecipe({
    id: 'hover-tilt', title: 'Restrained hover tilt', component: 'GsapHoverTilt', finePointer: true,
    purpose: 'Tilt a decorative project card inside a stationary pointer surface, with its link outside the moving card',
    trigger: 'fine-pointer movement over the card surface; neutral on leave', reducedMotion: 'Flat card; no pointer handlers or rotation',
    markup: `<h2>Work with dimension</h2>
<div class="od-tilt-hit"><article class="od-tilt-card" data-od-animate><h3>Project study</h3><p>A clear shape and a small sense of depth.</p></article></div>
<a href="#project" data-od-action="project">Read the project</a>`,
    css: '.od-marketing-hover-tilt .od-tilt-hit { perspective: 900px; padding: 1rem; }\n.od-marketing-hover-tilt .od-tilt-card { min-height: 14rem; padding: 2rem; border: 1px solid currentColor; border-radius: 1rem; transform-style: preserve-3d; }',
    motion: `      const hit = q('.od-tilt-hit');
      const card = q('[data-od-animate]');
      const xTo = gsap.quickTo(card, 'rotationX', { duration: 0.35, ease });
      const yTo = gsap.quickTo(card, 'rotationY', { duration: 0.35, ease });
      pointer(hit, (x, y) => {
        const box = hit.getBoundingClientRect();
        xTo(gsap.utils.clamp(-5, 5, (0.5 - y / box.height) * 10));
        yTo(gsap.utils.clamp(-5, 5, (x / box.width - 0.5) * 10));
      });
      on(hit, 'pointerleave', () => { xTo(0); yTo(0); });`,
  }),
  'image-crossfade': marketingRecipe({
    id: 'image-crossfade', title: 'Image hover crossfade', component: 'GsapImageCrossfade', finePointer: true,
    purpose: 'Reveal an alternate decorative field on pointer hover or keyboard focus, without hiding the caption or moving the link',
    trigger: 'fine-pointer hover or link focus; reverses on leave/blur', reducedMotion: 'Primary field at rest; caption and link stay usable',
    markup: `<h2>Another side of the work</h2>
<a class="od-crossfade" href="#project" data-od-action="project"><span class="od-crossfade-art" aria-hidden="true"><span data-od-art></span><span data-od-alt data-od-animate></span></span><span>Read the project ↗</span></a>`,
    css: `.od-marketing-image-crossfade .od-crossfade { display: grid; gap: 1rem; }
.od-marketing-image-crossfade .od-crossfade-art { position: relative; display: block; overflow: clip; border-radius: 0.75rem; }
.od-marketing-image-crossfade [data-od-art] { display: block; min-height: 18rem; background: linear-gradient(135deg, #edf1f5, #bcc8d4); }
.od-marketing-image-crossfade [data-od-alt] { position: absolute; inset: 0; opacity: 0; background: radial-gradient(circle at 65% 35%, var(--od-recipe-accent, #1f4f7a), transparent 60%); }`,
    motion: `      const link = q('[data-od-action]');
      const alphaTo = gsap.quickTo(q('[data-od-alt]'), 'opacity', { duration: 0.3, ease });
      let hovering = false;
      let focused = scope.ownerDocument.activeElement === link;
      const sync = () => alphaTo(hovering || focused ? 1 : 0);
      sync();
      on(link, 'pointerenter', () => { hovering = true; sync(); });
      on(link, 'pointerleave', () => { hovering = false; sync(); });
      on(link, 'focus', () => { focused = true; sync(); });
      on(link, 'blur', () => { focused = false; sync(); });`,
  }),
} as const;
