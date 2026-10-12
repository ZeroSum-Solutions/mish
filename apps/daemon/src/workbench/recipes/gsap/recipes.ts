import { MEDIA, htmlScript, reactHeader } from './scaffold.js';
import { MARKETING_RECIPE_IDS, MARKETING_RECIPES } from './marketing.js';
import type { GsapRuntimeFile } from './runtime.js';

/**
 * AC-R08.5 representative GSAP recipes (owner-confirmed need, candidate 40):
 * section entrance (core timeline), ScrollTrigger story, Flip filter/reorder
 * and core SVG feedback. Each recipe is authored here in two target formats —
 * a standalone HTML/CSS/JS unit (`html-artifact/v1`) and an editable React TSX
 * unit (`react-source/v1`) — sharing the same markup contract:
 * `data-od-gsap` on the root, `data-od-animate` on every element GSAP may
 * style, `data-od-action` on every action. Actions are never animated, so they
 * stay readable and usable before, during and without motion. Reduced motion
 * is handled with a scoped `gsap.matchMedia`, which also reacts to a live
 * preference change. These strings are the recipe source written into
 * projects; they are not executed by the daemon.
 */
export const GSAP_RECIPE_IDS = ['section-entrance', 'scroll-story', 'flip-filter', 'svg-feedback', ...MARKETING_RECIPE_IDS] as const;
export type GsapRecipeId = typeof GSAP_RECIPE_IDS[number];

export interface GsapRecipe {
  id: GsapRecipeId;
  title: string;
  purpose: string;
  /** Plugins this recipe registers, beyond GSAP core. Only these runtime files ship with it. */
  plugins: readonly Exclude<GsapRuntimeFile, 'gsap'>[];
  trigger: string;
  reducedMotion: string;
  cleanup: string;
  /** React component name and file stem for the TSX unit. */
  component: string;
  html: { markup: string; css: string; script: string };
  react: string;
}

const sectionEntrance: GsapRecipe = {
  id: 'section-entrance', title: 'Section entrance', component: 'GsapSectionEntrance',
  purpose: 'Reveal a section\'s heading and benefits once, with the call to action visible from the start',
  plugins: [], trigger: 'mount', reducedMotion: 'Static section: nothing is hidden or moved; a live preference change reverts running motion',
  cleanup: 'Scoped matchMedia context reverted on unmount or page hide; inline styles restored',
  html: {
    markup: `<section class="od-entrance" data-od-gsap="section-entrance" aria-labelledby="od-entrance-title">
  <h2 id="od-entrance-title" data-od-animate>Care that fits your day</h2>
  <ul class="od-entrance__benefits">
    <li data-od-animate>Same-week appointments</li>
    <li data-od-animate>Clear prices before treatment</li>
    <li data-od-animate>Evening and weekend hours</li>
  </ul>
  <a class="od-entrance__cta" href="#book" data-od-action="book">Book a visit</a>
</section>`,
    css: `.od-entrance { display: grid; gap: 1rem; max-width: 40rem; padding: 2rem 1rem; }
.od-entrance__benefits { display: grid; gap: 0.5rem; margin: 0; padding-left: 1.25rem; }
.od-entrance__cta { justify-self: start; padding: 0.75rem 1.25rem; border-radius: 0.5rem; background: var(--od-recipe-accent, #1f4f7a); color: var(--od-recipe-on-accent, #fff); text-decoration: none; }
.od-entrance__cta:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
`,
    script: htmlScript('section-entrance', { motion: `      gsap.timeline({ defaults: { duration: 0.6, ease: 'power2.out' } })
        .from('[data-od-animate]', { autoAlpha: 0, y: 24, stagger: 0.12 });` }),
  },
  react: `${reactHeader('section-entrance', 'Heading and benefits rise in once on mount; the call to action is never animated.')}import { useRef } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

export function GsapSectionEntrance() {
  const root = useRef<HTMLElement>(null);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(${MEDIA}, (context) => {
      if (context.conditions?.reduce) return; // static state
      gsap.timeline({ defaults: { duration: 0.6, ease: 'power2.out' } })
        .from('[data-od-animate]', { autoAlpha: 0, y: 24, stagger: 0.12 });
    });
  }, { scope: root });

  return (
    <section ref={root} className="od-entrance" data-od-gsap="section-entrance" aria-labelledby="od-entrance-title">
      <h2 id="od-entrance-title" data-od-animate>Care that fits your day</h2>
      <ul className="od-entrance__benefits">
        <li data-od-animate>Same-week appointments</li>
        <li data-od-animate>Clear prices before treatment</li>
        <li data-od-animate>Evening and weekend hours</li>
      </ul>
      <a className="od-entrance__cta" href="#book" data-od-action="book">Book a visit</a>
    </section>
  );
}

export default GsapSectionEntrance;
`,
};

const STEPS = [
  ['Book online', 'Pick a time that suits you; the confirmation arrives by email.'],
  ['Meet your dentist', 'A short check-up and a plan in plain words, with prices up front.'],
  ['Leave with a plan', 'Your next steps and dates are saved to your account.'],
] as const;

const scrollStory: GsapRecipe = {
  id: 'scroll-story', title: 'ScrollTrigger story', component: 'GsapScrollStory',
  purpose: 'Explain a service in short steps as each step scrolls into view, without pinning, scrubbing or replacing native scroll',
  plugins: ['ScrollTrigger'], trigger: 'scroll (each step enters the viewport)',
  reducedMotion: 'Static steps with no scroll triggers; a live preference change kills the triggers and restores styles',
  cleanup: 'ScrollTrigger instances and tweens live in the scoped context and are killed on unmount or page hide',
  html: {
    markup: `<section class="od-story" data-od-gsap="scroll-story" aria-labelledby="od-story-title">
  <h2 id="od-story-title">How your first visit works</h2>
  <ol class="od-story__steps">
${STEPS.map(([title, body]) => `    <li class="od-story__step" data-od-animate data-od-step><h3>${title}</h3><p>${body}</p></li>`).join('\n')}
  </ol>
  <a class="od-story__cta" href="#book" data-od-action="book">Book a visit</a>
</section>`,
    css: `.od-story { display: grid; gap: 1.5rem; max-width: 40rem; padding: 2rem 1rem; }
.od-story__steps { display: grid; gap: 2rem; margin: 0; padding-left: 1.25rem; }
.od-story__step h3 { margin: 0 0 0.25rem; }
.od-story__cta { justify-self: start; padding: 0.75rem 1.25rem; border-radius: 0.5rem; background: var(--od-recipe-accent, #1f4f7a); color: var(--od-recipe-on-accent, #fff); text-decoration: none; }
.od-story__cta:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
`,
    script: htmlScript('scroll-story', { plugins: ['ScrollTrigger'], motion: `      root.querySelectorAll('[data-od-step]').forEach(function (step) {
        gsap.from(step, {
          autoAlpha: 0, y: 32, duration: 0.6, ease: 'power2.out',
          scrollTrigger: { trigger: step, start: 'top 85%', toggleActions: 'play none none reverse' },
        });
      });` }),
  },
  react: `${reactHeader('scroll-story', 'Each step fades up as it scrolls into view; no pinning, scrubbing or scroll hijacking.')}import { useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const STEPS = ${JSON.stringify(STEPS.map(([title, body]) => ({ title, body })), null, 2).replace(/\n/gu, '\n')};

export function GsapScrollStory() {
  const root = useRef<HTMLElement>(null);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(${MEDIA}, (context) => {
      if (context.conditions?.reduce) return; // static state, no triggers
      root.current?.querySelectorAll<HTMLElement>('[data-od-step]').forEach((step) => {
        gsap.from(step, {
          autoAlpha: 0, y: 32, duration: 0.6, ease: 'power2.out',
          scrollTrigger: { trigger: step, start: 'top 85%', toggleActions: 'play none none reverse' },
        });
      });
    });
  }, { scope: root });

  return (
    <section ref={root} className="od-story" data-od-gsap="scroll-story" aria-labelledby="od-story-title">
      <h2 id="od-story-title">How your first visit works</h2>
      <ol className="od-story__steps">
        {STEPS.map((step) => (
          <li key={step.title} className="od-story__step" data-od-animate data-od-step>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
      <a className="od-story__cta" href="#book" data-od-action="book">Book a visit</a>
    </section>
  );
}

export default GsapScrollStory;
`,
};

const TREATMENTS = [
  ['checkup', 'cleaning', 'Check-up and clean'],
  ['whitening', 'cleaning', 'Whitening'],
  ['single-implant', 'implant', 'Single implant'],
  ['implant-bridge', 'implant', 'Implant bridge'],
] as const;
const FILTERS = [['all', 'All'], ['cleaning', 'Cleaning'], ['implant', 'Implants']] as const;

const flipFilter: GsapRecipe = {
  id: 'flip-filter', title: 'Flip filter', component: 'GsapFlipFilter',
  purpose: 'Animate a result list between filters so each item keeps its identity, with buttons that work at every moment',
  plugins: ['Flip'], trigger: 'filter button press',
  reducedMotion: 'Filters apply instantly with no Flip animation; the same buttons and states work',
  cleanup: 'Flip timelines are created inside the scoped context (contextSafe in React) and killed on unmount or a real page hide; filter listeners stay for back/forward cache restores',
  html: {
    markup: `<section class="od-flip" data-od-gsap="flip-filter" aria-labelledby="od-flip-title">
  <h2 id="od-flip-title">Treatments</h2>
  <div class="od-flip__filters" role="group" aria-label="Filter treatments">
${FILTERS.map(([value, label]) => `    <button type="button" data-od-action="filter" data-od-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('\n')}
  </div>
  <ul class="od-flip__list">
${TREATMENTS.map(([id, kind, label]) => `    <li data-od-item="${id}" data-od-kind="${kind}" data-od-animate>${label}</li>`).join('\n')}
  </ul>
</section>`,
    css: `.od-flip { display: grid; gap: 1rem; max-width: 40rem; padding: 2rem 1rem; }
.od-flip__filters { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.od-flip__filters button { min-height: 44px; padding: 0.5rem 1rem; border-radius: 999px; border: 1px solid currentColor; background: transparent; color: inherit; }
.od-flip__filters button[aria-pressed="true"] { background: var(--od-recipe-accent, #1f4f7a); color: var(--od-recipe-on-accent, #fff); }
.od-flip__filters button:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
.od-flip__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
.od-flip__list li { padding: 1rem; border-radius: 0.5rem; border: 1px solid currentColor; }
`,
    script: htmlScript('flip-filter', { plugins: ['Flip'], actions: `  var items = Array.prototype.slice.call(root.querySelectorAll('[data-od-item]'));
  var buttons = Array.prototype.slice.call(root.querySelectorAll('[data-od-action="filter"]'));
  function show(kind) {
    items.forEach(function (item) { item.hidden = !(kind === 'all' || item.getAttribute('data-od-kind') === kind); });
    buttons.forEach(function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-od-filter') === kind)); });
  }
  function choose(event) {
    var kind = event.currentTarget.getAttribute('data-od-filter');
    if (state.reduce || !state.context) { show(kind); return; }
    var Flip = window.Flip;
    var layout = Flip.getState(items);
    show(kind);
    // Recorded in the matchMedia context: a preference change or teardown kills it.
    state.context.add(function () { Flip.from(layout, { duration: 0.45, ease: 'power2.inOut', absolute: true }); });
  }
  buttons.forEach(function (button) { on(button, 'click', choose); });` }),
  },
  react: `${reactHeader('flip-filter', 'Filtering animates the list with Flip; under reduced motion it applies instantly.')}import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, Flip);

type Filter = ${FILTERS.map(([value]) => `'${value}'`).join(' | ')};
const FILTERS: { value: Filter; label: string }[] = ${JSON.stringify(FILTERS.map(([value, label]) => ({ value, label })))};
const TREATMENTS: { id: string; kind: Exclude<Filter, 'all'>; label: string }[] = ${JSON.stringify(TREATMENTS.map(([id, kind, label]) => ({ id, kind, label })))};

export function GsapFlipFilter() {
  const root = useRef<HTMLElement>(null);
  const reduce = useRef(false);
  const [filter, setFilter] = useState<Filter>('all');

  const { contextSafe } = useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(${MEDIA}, (context) => {
      reduce.current = Boolean(context.conditions?.reduce);
    });
  }, { scope: root });

  // contextSafe records the Flip timeline in this component's context, so unmount kills it.
  const choose = contextSafe((next: Filter) => {
    const items = root.current?.querySelectorAll('[data-od-item]');
    const state = !reduce.current && items ? Flip.getState(items) : null;
    flushSync(() => setFilter(next));
    if (state) Flip.from(state, { duration: 0.45, ease: 'power2.inOut', absolute: true });
  });

  return (
    <section ref={root} className="od-flip" data-od-gsap="flip-filter" aria-labelledby="od-flip-title">
      <h2 id="od-flip-title">Treatments</h2>
      <div className="od-flip__filters" role="group" aria-label="Filter treatments">
        {FILTERS.map((option) => (
          <button key={option.value} type="button" data-od-action="filter" data-od-filter={option.value}
            aria-pressed={filter === option.value} onClick={() => choose(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      <ul className="od-flip__list">
        {TREATMENTS.map((item) => (
          <li key={item.id} data-od-item={item.id} data-od-kind={item.kind} data-od-animate
            hidden={!(filter === 'all' || filter === item.kind)}>
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default GsapFlipFilter;
`,
};

const svgFeedback: GsapRecipe = {
  id: 'svg-feedback', title: 'SVG save feedback', component: 'GsapSvgFeedback',
  purpose: 'Confirm a save with a drawn check mark plus a text status, never colour alone and never moving the button',
  plugins: [], trigger: 'save button press',
  reducedMotion: 'Before a save no check is shown; after a save the text status and a static check appear with no drawing animation',
  cleanup: 'The drawing timeline lives in the scoped context and is killed on unmount or a real page hide; the save listener stays for back/forward cache restores',
  html: {
    markup: `<section class="od-feedback" data-od-gsap="svg-feedback" aria-labelledby="od-feedback-title">
  <h2 id="od-feedback-title">Save your details</h2>
  <button type="button" class="od-feedback__save" data-od-action="save">Save details</button>
  <svg class="od-feedback__icon" data-od-icon hidden viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
    <circle data-od-animate data-od-ring cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="3" pathLength="1"/>
    <path data-od-animate data-od-check d="M15 25l6 6 12-13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
  </svg>
  <p class="od-feedback__status" role="status" aria-live="polite" data-od-status></p>
</section>`,
    css: `.od-feedback { display: grid; gap: 1rem; justify-items: start; max-width: 40rem; padding: 2rem 1rem; }
.od-feedback__save { min-height: 44px; padding: 0.75rem 1.25rem; border-radius: 0.5rem; border: 0; background: var(--od-recipe-accent, #1f4f7a); color: var(--od-recipe-on-accent, #fff); }
.od-feedback__save:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
.od-feedback__icon { color: var(--od-recipe-success, #1d6b3a); }
`,
    script: htmlScript('svg-feedback', { actions: `  var button = root.querySelector('[data-od-action="save"]');
  var status = root.querySelector('[data-od-status]');
  var icon = root.querySelector('[data-od-icon]');
  var marks = root.querySelectorAll('[data-od-ring], [data-od-check]');
  function save() {
    status.textContent = 'Saved. Your details are stored.';
    icon.removeAttribute('hidden'); // the check appears only once something was saved
    if (state.reduce || !state.context) return;
    state.context.add(function () {
      gsap.timeline({ defaults: { ease: 'power2.out' } })
        .fromTo(marks, { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.45, stagger: 0.15 });
    });
  }
  on(button, 'click', save);` }),
  },
  react: `${reactHeader('svg-feedback', 'A save draws a check mark and states the result in text; reduced motion shows it instantly.')}import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

export function GsapSvgFeedback() {
  const root = useRef<HTMLElement>(null);
  const reduce = useRef(false);
  const [status, setStatus] = useState('');

  const { contextSafe } = useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(${MEDIA}, (context) => {
      reduce.current = Boolean(context.conditions?.reduce);
    });
  }, { scope: root });

  const save = contextSafe(() => {
    flushSync(() => setStatus('Saved. Your details are stored.'));
    if (reduce.current) return;
    gsap.timeline({ defaults: { ease: 'power2.out' } })
      .fromTo('[data-od-ring], [data-od-check]', { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.45, stagger: 0.15 });
  });

  return (
    <section ref={root} className="od-feedback" data-od-gsap="svg-feedback" aria-labelledby="od-feedback-title">
      <h2 id="od-feedback-title">Save your details</h2>
      <button type="button" className="od-feedback__save" data-od-action="save" onClick={() => save()}>Save details</button>
      {/* The check appears only once something was saved; reduced motion shows it without drawing. */}
      <svg className="od-feedback__icon" data-od-icon hidden={!status} viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
        <circle data-od-animate data-od-ring cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" pathLength={1} />
        <path data-od-animate data-od-check d="M15 25l6 6 12-13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
      </svg>
      <p className="od-feedback__status" role="status" aria-live="polite" data-od-status>{status}</p>
    </section>
  );
}

export default GsapSvgFeedback;
`,
};

export const GSAP_RECIPES: Readonly<Record<GsapRecipeId, GsapRecipe>> = Object.freeze({
  'section-entrance': sectionEntrance, 'scroll-story': scrollStory, 'flip-filter': flipFilter, 'svg-feedback': svgFeedback,
  ...MARKETING_RECIPES,
});
