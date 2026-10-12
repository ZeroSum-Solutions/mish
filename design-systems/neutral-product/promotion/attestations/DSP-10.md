# DSP-10 — localization stress

- Checker: GPT-6 Sol (delegated by Devin)
- Date: 2026-09-23
- Verdict: **fail**
- Method: In headless Chromium, injected long German, Japanese, and Arabic strings into headings, navigation, buttons, labels, and table headers at runtime. Set `lang` to `de`, `ja`, or `ar`, and set `dir="rtl"` for Arabic. Tested all five pages at 1280, 768, and 360px (45 page/locale/width combinations). Compared page `scrollWidth` with viewport width and inspected visible clipping. The source files were not edited.
- Environment: macOS arm64, Node 24.16.0, headless Chromium 148.0.7778.96, desktop emulation. Screenshots are `cwebp -q 80` WebP.

## Findings

- German stress at 360px made `preview/specimen-website.html` **378px wide in a 360px viewport**. `#hero-title` and `.hero-actions` extended to x=378, and the heading and primary action were cut at the right edge. See `preview/specimen-website.html:363-369` and `evidence/specimen-website-de-360.webp`. This fails the no-horizontal-page-scroll rule in `DESIGN.md:207-219`.
- The Japanese website sample wrapped without page overflow (`evidence/specimen-website-ja-360.webp`). The app, document, campaign, and component fixtures had no page-level overflow in the German and Japanese runs at 360px. The document table and app tabs use internal horizontal scrolling; that is distinct from page overflow.
- Arabic with `dir="rtl"` did not create page-level overflow in the 360px app or component fixture (`evidence/specimen-app-rtl-360.webp`, `evidence/components-rtl-360.webp`). This is a rendering stress check, not an RTL conformance claim. The package marks its pages `lang="en"`; `DESIGN.md:25-27` claims script coverage from system fonts, and `DESIGN.md:158` calls for locale-formatted numbers. It does not claim RTL support or provide RTL layout rules.
- The other German captures document the tested app, document, campaign, and component layouts. The component tab strip remains horizontally scrollable (`evidence/components-de-tabs-360.webp`).

## Why

One supported long-string stress case causes clipped content and horizontal page scroll on the phone website.
