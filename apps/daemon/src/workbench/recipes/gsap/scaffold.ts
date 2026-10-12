export const MEDIA = "{ motion: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }";

/**
 * Shared HTML scaffold. Motion is optional: without the runtime (or a needed
 * plugin) the static section stays readable and its actions still work.
 * `motion` runs inside a scoped `gsap.matchMedia` branch for
 * `prefers-reduced-motion: no-preference`; `actions` wire listeners with
 * `on(...)` and read `state.reduce` / `state.context`. A back/forward-cache
 * (persisted) pagehide keeps everything; a real pagehide stops motion and a
 * persisted pageshow starts it again. Page lifecycle never drops an action
 * listener; only the host's explicit `revert()` removes them.
 */
export const htmlScript = (id: string, parts: { motion?: string; actions?: string; plugins?: readonly string[] }) => `/* GSAP recipe gsap/${id} (html-artifact/v1). Edit freely: copy, timing and easing are plain values. */
(function () {
  'use strict';
  var id = '${id}';
  var registry = (window.odGsapRecipes = window.odGsapRecipes || {});
  var root = document.querySelector('[data-od-gsap="' + id + '"]');
  if (!root) return;
  var gsap = window.gsap || null;
${(parts.plugins ?? []).map(plugin => `  if (gsap && !window.${plugin}) gsap = null;
  if (gsap) gsap.registerPlugin(window.${plugin});`).join('\n')}${(parts.plugins ?? []).length ? '\n' : ''}  var state = { reduce: false, context: null };
  var mm = null;
  var listeners = [];
  function on(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }
  function startMotion() {
    if (!gsap || mm) return;
    mm = gsap.matchMedia(root);
    mm.add(${MEDIA}, function (context) {
      state.reduce = Boolean(context.conditions.reduce);
      state.context = context;
      if (state.reduce) return; // static state
${parts.motion ?? '      // Motion starts from the actions below.'}
    });
  }
  function stopMotion() {
    if (!mm) return;
    mm.revert();
    mm = null;
    state.context = null;
  }
${parts.actions ?? ''}
  startMotion();
  function onPageHide(event) { if (!event.persisted) stopMotion(); }
  function onPageShow(event) { if (event.persisted) startMotion(); }
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  function revert() {
    stopMotion();
    while (listeners.length) { var entry = listeners.pop(); entry[0].removeEventListener(entry[1], entry[2]); }
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  registry[id] = { revert: revert };
})();
`;

export const reactHeader = (id: string, summary: string) => `'use client';

/**
 * GSAP recipe gsap/${id} (react-source/v1), adopted by Mishh Mashh.
 * ${summary}
 * Requires gsap ^3.15.0 and @gsap/react ^2.1.2 in this project's package.json.
 * GSAP is used under its Standard "no charge" licence: https://gsap.com/standard-license
 * Edit freely: copy, timing and easing are plain values below.
 */
`;

