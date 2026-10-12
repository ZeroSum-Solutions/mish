import type { GsapRecipe } from './recipes.js';
import { MEDIA, htmlScript, reactHeader } from './scaffold.js';

export interface MarketingRecipeSpec {
  id: GsapRecipe['id'];
  title: string;
  component: string;
  purpose: string;
  trigger: string;
  reducedMotion: string;
  plugins?: GsapRecipe['plugins'];
  finePointer?: boolean;
  desktopScroll?: boolean;
  markup: string;
  css?: string;
  /** Owned JavaScript shared by the HTML and React units; q/all/on/pointer are scoped helpers. */
  motion: string;
}

/** Keep both editable outputs on the same behavior and CSS, including cleanup of event-driven tweens. */
export function marketingRecipe(spec: MarketingRecipeSpec): GsapRecipe {
  const plugins = spec.plugins ?? [];
  const selector = `.od-marketing-${spec.id}`;
  const css = `${selector} { position: relative; max-width: 64rem; padding: 2rem 1rem; color: var(--od-recipe-text, #20242b); background: var(--od-recipe-surface, #fff); }
${selector} h2 { font-size: clamp(1.75rem, 5vw, 3.5rem); line-height: 1.12; }
${selector} [data-od-action] { display: inline-flex; align-items: center; min-height: 44px; padding: 0.5rem 1rem; color: inherit; border: 1px solid currentColor; background: transparent; border-radius: 0.5rem; text-decoration: none; cursor: pointer; }
${selector} [data-od-action]:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
${spec.css ?? ''}
`;
  const markup = `<section class="od-marketing-${spec.id}" data-od-gsap="${spec.id}" aria-label="${spec.title}">
${spec.markup}
</section>`;
  const conditions = [
    ...(spec.finePointer ? ["fine: '(hover: hover) and (pointer: fine)'"] : []),
    ...(spec.desktopScroll ? ["desktop: '(min-width: 768px) and (min-height: 600px)'"] : []),
  ];
  const media = conditions.length ? MEDIA.replace(' }', `, ${conditions.join(', ')} }`) : MEDIA;
  const motionGuard = [
    ...(spec.finePointer ? ['!context.conditions.fine'] : []),
    ...(spec.desktopScroll ? ['!context.conditions.desktop'] : []),
  ].join(' || ');
  const helpers = (typed: boolean) => `
      const cleanups${typed ? ': Array<() => void>' : ''} = [];
      const ease = 'power3.out'; // ease-out family; tune alongside the catalogue defaults
      const q = (selector${typed ? ': string' : ''}) => scope.querySelector${typed ? '<HTMLElement>' : ''}(selector)${typed ? '!' : ''};
      const all = (selector${typed ? ': string' : ''}) => Array.from(scope.querySelectorAll${typed ? '<HTMLElement>' : ''}(selector));
      const on = (target${typed ? ': EventTarget' : ''}, type${typed ? ': string' : ''}, handler${typed ? ': (event: Event) => void' : ''}) => {
        const safe = (event${typed ? ': Event' : ''}) => context.add(() => handler(event));
        target.addEventListener(type, safe);
        cleanups.push(() => target.removeEventListener(type, safe));
      };
      const pointer = (target${typed ? ': HTMLElement' : ''}, handler${typed ? ': (x: number, y: number) => void' : ''}) => {
        on(target, 'pointermove', (event) => {
          const point = event${typed ? ' as PointerEvent' : ''};
          if (point.pointerType === 'touch') return;
          const box = target.getBoundingClientRect();
          if (box.width && box.height) handler(point.clientX - box.left, point.clientY - box.top);
        });
      };
`;
  const motion = (typed: boolean) => `${helpers(typed)}
${spec.desktopScroll ? `      // Pin teardown can render its scrub animation after tween reversion.
      // Restore the exact pre-motion inline attributes after that teardown.
      const savedStyles = all('[data-od-animate]').map((element) => ({ element, style: element.getAttribute('style') }));
      cleanups.push(() => savedStyles.forEach(({ element, style }) => {
        if (style === null) element.removeAttribute('style');
        else element.setAttribute('style', style);
      }));\n` : ''}
${spec.motion}
      return () => { cleanups.reverse().forEach((cleanup) => cleanup()); };`;
  const script = htmlScript(spec.id, {
    plugins,
    motion: `      ${motionGuard ? `if (${motionGuard}) return;\n      ` : ''}const scope = root;
${motion(false)}`,
  }).replace(MEDIA, media);
  // Only authored markup is converted. No runtime innerHTML or upstream source is used.
  const jsx = spec.markup.replace(/\bclass=/gu, 'className=');
  return {
    id: spec.id, title: spec.title, purpose: spec.purpose, component: spec.component,
    plugins, trigger: spec.trigger, reducedMotion: spec.reducedMotion,
    cleanup: 'Scoped matchMedia reverts tweens, triggers and styles; its cleanup removes listeners and restores custom state on preference change, unmount or real page hide',
    html: { markup, css, script },
    react: `${reactHeader(spec.id, spec.purpose)}import { useRef } from 'react';
import { gsap } from 'gsap';
${plugins.map(plugin => `import { ${plugin} } from 'gsap/${plugin}';`).join('\n')}
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP${plugins.map(plugin => `, ${plugin}`).join('')});

export function ${spec.component}() {
  const root = useRef<HTMLElement>(null);
  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(${media}, (context) => {
      if (context.conditions?.reduce${motionGuard ? ` || ${motionGuard.replaceAll('context.conditions.', 'context.conditions?.')}` : ''}) return;
      const scope = root.current!;
${motion(true)}
    });
  }, { scope: root });
  return (
    <section ref={root} className="od-marketing-${spec.id}" data-od-gsap="${spec.id}" aria-label="${spec.title}">
      <style>{${JSON.stringify(css)}}</style>
${jsx}
    </section>
  );
}

export default ${spec.component};
`,
  };
}
