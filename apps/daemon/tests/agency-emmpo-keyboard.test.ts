/**
 * G5 round 2 (Grok audit item 4, and the round-3 NOTE that this test's title overclaimed): emmpo's
 * quiz/social/course controls, when the brief supplies no real destination, used to render
 * `<a tabindex="0" role="button" data-demo-action="...">` with no `href`. An anchor with no `href`
 * is focusable but does not fire `click` on Enter or Space — only a mouse click reached it. The
 * fix emits a real `<button type="button">` instead (`packages/agency-fast-lane`'s `family.ts`
 * loads the same compiler copy this test drives).
 *
 * WHAT THIS TEST DOES NOT PROVE: that pressing Enter or Space actually activates the button.
 * jsdom does not implement a `<button>`'s native keyboard-activation behavior — dispatching a
 * `keydown` event on one does not produce a `click` event, in any jsdom version, confirmed by an
 * isolated minimal repro outside this compiler's code (a vanilla `<button>` with no script at
 * all, same result). There is no way to drive that specific browser behavior inside jsdom, so an
 * earlier version of this test called `.click()` immediately after dispatching `keydown` to make
 * the assertion pass — which proved the click handler works, not that the key press caused it,
 * while the test's name and comments implied the latter. That was misleading, per a round-2 Grok
 * audit; this version says exactly what it checks and nothing more:
 *
 *   1. Every no-destination fallback control is a real `<button>` tag (not an anchor with no
 *      href). This is the actual product fix, and the only part this compiler controls. A
 *      `<button>`'s Enter/Space activation is then guaranteed by the HTML living standard in
 *      every real browser — that guarantee is what makes checking the tag sufficient here.
 *   2. The button's own click handler (this compiler's code) opens the dialog when a `click`
 *      event does fire — checked with a real, directly-dispatched `click`, never a `keydown`.
 *
 * Neither assertion dispatches `keydown` at all; the tag check plus the real-browser HTML spec
 * together are what make this test honest about Enter/Space, without jsdom pretending to drive
 * the key itself.
 */
// @ts-expect-error -- jsdom ships no type declarations and @types/jsdom is not a dependency.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { defaultPackageDir, loadFamilyPackage } from '@mish/agency-fast-lane/family';

describe('emmpo demo controls with no brief-supplied destination are real <button>s, not anchors with no href', () => {
  it('is a <button> (Enter/Space-activatable by the HTML spec in a real browser) whose own click handler opens the dialog', async () => {
    const pkg = await loadFamilyPackage(defaultPackageDir('emmpo'), 'emmpo');
    // The reference fixture carries no `destinations`, so every quiz/social/course control falls
    // back to the no-destination path this test exists to check.
    const fixture = structuredClone(pkg.fixture) as Record<string, unknown>;
    delete fixture.destinations;
    const { html } = pkg.render(fixture as unknown as typeof pkg.fixture, 'index.html');

    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      url: 'https://example.test/',
      pretendToBeVisual: true,
      // apps/daemon's tsconfig has no DOM lib (it is a Node daemon), so jsdom's own untyped
      // `window` here is explicitly `any` rather than referencing a DOM type this program's lib
      // does not provide.
      beforeParse(window: any) {
        // jsdom implements neither `matchMedia` nor `<dialog>.showModal()`; the family's own
        // inline script (and `<dialog>` element) call both unconditionally, so both get the same
        // minimal stub any headless test runner needs — enough to observe the call happened,
        // nothing about the keyboard-activation path itself.
        window.matchMedia = ((query: string) => ({
          matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        })) as typeof window.matchMedia;
        // jsdom implements no Font Loading API either; the script awaits `document.fonts.ready`
        // before wiring up scroll-driven motion, unrelated to the keyboard path this test checks.
        Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
        // jsdom implements neither IntersectionObserver (scroll-reveal) nor Element.animate
        // (motion) — both are visual-only, unrelated to the keyboard-activation path this test
        // checks, so both get the smallest stub that lets the rest of the script run.
        class FakeIntersectionObserver {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
        (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
        window.Element.prototype.animate ??= () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
        (window.Element.prototype as unknown as { getAnimations?: () => unknown[] }).getAnimations ??= () => [];
      },
    });
    const { document, HTMLDialogElement } = dom.window;
    HTMLDialogElement.prototype.showModal = function (this: { open: boolean }) { this.open = true; };
    const dialog = document.querySelector('#emmpo-ui-demo') as InstanceType<typeof HTMLDialogElement>;
    expect(dialog).not.toBeNull();

    // Scoped to the no-destination fallback controls specifically (`[data-demo-action]` without
    // `href`): the fixed-nav quiz links keep a real `href="#emmpo-ui-demo"` regardless of a
    // destination (a genuine in-page anchor to the dialog itself), so they are real, honestly
    // keyboard-operable `<a>`s on purpose and are not part of what this fix changed.
    const buttons = [...document.querySelectorAll('[data-demo-action]:not([href])')];
    expect(buttons.length).toBeGreaterThan(0);

    // Assertion 1 — the actual product fix: every fallback control is a real <button>, never an
    // <a> with no href (the latter fires no `click` from a key press in any browser; the HTML
    // spec's activation behavior for a hyperlink element requires an href). This is the whole gap
    // between "keyboard-operable" and "not", and it is entirely this compiler's own output.
    for (const button of buttons) {
      expect(button.tagName, `${button.getAttribute('data-demo-action')}: is a <button>, Enter/Space-activatable by the HTML spec in a real browser`).toBe('BUTTON');
    }

    // Assertion 2 — this compiler's other controllable half: when a click DOES happen (by mouse,
    // or — in a real browser only — by Enter/Space on the button jsdom cannot simulate that for),
    // the handler opens the dialog. Dispatched directly as a `click`, never via `keydown`, so
    // nothing here implies a key press was simulated.
    const button = buttons[0]! as unknown as { click: () => void };
    dialog.open = false;
    button.click();
    expect(dialog.open, 'the button\'s click handler opens the demo dialog').toBe(true);
  });
});
