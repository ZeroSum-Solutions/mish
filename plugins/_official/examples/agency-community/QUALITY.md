# Community generator quality benchmark

The authoritative implementation is `compiler/scripts/families/community/render.ts`.
The recipe, nullable fact gates, name/quote verification markers, section roster, edit-slot
identifiers and approved-assets contract are unchanged. No fixture was rewritten to fit the
new output. The asset contract supplies no photographs; the renderer provides original
geometric artwork and system typography so a no-photo brief still produces a complete page.

## Reference lock and decisions

Parent research selected [Skillshare](https://skillshare.com) (Refero
`bdac88a6-68da-4f31-850a-90b8f7633211`) for poster hierarchy, alternating black/white bands and
an accent reserved for actions. [Eindhoven Design District](https://www.eindhovendesigndistrict.com)
(`55e7a4a9-b907-4ea1-965b-4227ef158ec6`) informed the strict grid and oversized typography.
[Streamtime](https://streamtime.net) (`9eba3c0b-f4bb-46e4-aee9-43b400b71ce6`) informed the limited
geometric identity. These are design references, not copied client content, claims or assets.

The hero is larger than every section title. Four benefits form a 2×2 desktop grid and one
column on mobile. The header uses native compact mobile navigation. Tier actions preserve the
selected membership and lead to the join section. Native FAQ disclosures remain usable without
scripts. Static events carry no false link chrome.

An email supplied by the brief enables details → review → email draft. Browser validation runs
before review. Editing preserves fields. Review text uses DOM text nodes and the email subject
and body use URL encoding. Every native and prepared email recipient is URI encoded too, including
reserved characters admitted by the contact contract. Keyboard tier selection moves focus to
the first field. Draft URIs over a conservative 2048-character bound use a complete selectable
manual-copy fallback; shorter drafts also retain that fallback. No state claims an email app
opened or a message was delivered. The page never sends, persists a visitor's data or claims receipt.
No email means no form. Phone-only briefs retain a native telephone contact. No contact facts
produce an explicit missing-details note. Email and phone links work without JavaScript.

Review also handles the submit button's click, including implicit Enter activation, because
Mishh Mashh's opaque FileViewer sandbox blocks native submission before a submit event fires.
The sandbox stays `allow-scripts allow-downloads`; review still validates locally and never
submits the form. The P0 case in `e2e/ui/app-manual-edit.test.ts` exercises that real preview
boundary, fragment navigation, invalid/valid input, preserved editing and encoded manual handoff.

The renderer hashes its exact browser source into CSP. Effects composition preserves only
verified existing script hashes, adds the selected effect hashes, and rejects stale hashes,
external scripts, wildcard/permissive sources, duplicate directives and script-source overrides.
A pre-existing `script-src 'none'` never authorizes previously blocked scripts. Network and
form submission remain blocked. Styles and scripts ship inline for offline exports.

## Local evidence, 2026-09-30

Evidence lives in the worktree's ignored `.tmp/quality-proof/` directory.

- `reference.html` is the unchanged reference fixture rendered through the production family
  validate/render boundary. `reference-390.png`, `reference-1280.png`, `review-390.png` and
  `review-1280.png` show the page and application. `browser-proof.json` records no console
  exceptions, no horizontal overflow, a 77/97 px header, hero sizes 52/75.52 px against section
  sizes 38/51.2 px, a two-column desktop benefits grid, tier selection, valid review, encoded
  draft destination, editing preservation, truthful handoff status and native no-script FAQ/contact.
- `sparse-atoms.html` drops all nullable atoms and member voices. `long-at-bound.html` fills plain
  content fields to their schema bounds. Their 390/1280 screenshots and `variant-proof.json`
  record no overflow or browser exceptions under reduced motion. These are compiler stress
  probes, not evidence of model generation. Original reference fixture facts remain untouched.
- `tests.log`: 39 community/effect checks pass, including slot order/uniqueness, nullable atoms,
  format/name/quote markers, schema parity, dishonest links, bounds, authored CSS coverage,
  exact CSP hashing and fail-closed effect composition.
- `plugin-typecheck.log` and `guard.log`: package typecheck and repository guard pass.
- `css-build.log`: sanctioned CSS regeneration ran for `community`; the pinned CLI is 4.3.3.
  `compiler-sync.log`: sanctioned compiler closure synchronization ran for local verification.
- `review-regressions.log`: 56 focused structure, sparse-content, composed-page and community
  checks pass after independent review. `community-review-browser.log`: all four hermetic
  Playwright checks pass at 390/1280, covering recipient round-trip encoding, keyboard focus,
  preserved editing, Unicode URI bounds, complete manual copying and native no-script contact.
  `mail-review-proof.json`, `manual-fallback-390.png` and `manual-fallback-1280.png` show the
  reduced-motion long Unicode handoff. Reference and review screenshots were refreshed from
  the current authoritative source. These tests contact no provider, backend or email app.

Commands, from repository root with the pinned runtime:

```sh
mise exec -- node --experimental-strip-types scripts/build-ui-kit-css.ts community
mise exec -- node --experimental-strip-types scripts/sync-agency-compiler.ts
mise exec -- node --experimental-strip-types --test plugins/_official/examples/agency-community/compiler/scripts/families/community/render.test.ts plugins/_official/shared/agency-compiler/tests/effects.test.ts
mise exec -- corepack pnpm --filter @open-design/plugin-runtime typecheck
mise exec -- corepack pnpm guard
```

Root integration owns generated closure copies and COMMIT hashes, metadata and actual supported
CLI/HTTP runs for reference/sparse/long briefs. The local compiler and browser proof does not
claim provider, published-preview, inbox delivery or production-runtime verification. The page
uses the visitor's configured email app; it does not guarantee that app opens or sends.
