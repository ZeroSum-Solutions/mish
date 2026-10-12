# Motion recipes catalogue

The GSAP catalogue contains four original representative recipes and 14 project-owned marketing recipes (18 recipes, 36 target entries). Each recipe exports editable HTML/CSS/JavaScript and a React TSX component. These are behavior studies with independently written implementations; no site code, imagery or brand assets are included.

## Format and registration

`apps/daemon/src/workbench/recipes/gsap/recipes.ts` defines `GsapRecipe` and registers recipes in `GSAP_RECIPE_IDS` and `GSAP_RECIPES`. `marketing.ts` supplies the marketing cohort; `marketing-scaffold.ts` shares its motion body and scoped CSS between targets. `scaffold.ts` holds the existing page lifecycle scaffold.

| Field | Contract |
| --- | --- |
| `id`, `title`, `purpose` | Stable recipe identity, display name and task it supports |
| `plugins` | Only selected runtime plugins; currently ScrollTrigger or Flip |
| `trigger`, `reducedMotion`, `cleanup` | Inspectable behavior and lifecycle description |
| `component` | Exported React component name and materialized TSX file stem |
| `html.markup`, `.css`, `.script` | Standalone editable source, with static readable markup |
| `react` | Client component source; static SSR output, scoped `useGSAP` effect |

Root elements use `data-od-gsap="<id>"`; GSAP-styled elements use `data-od-animate`. Controls use `data-od-action` and stay visible and operable. Decorative descendants may move inside stationary controls. Generated marketing React units include their CSS in a scoped style element, so adoption needs no separate stylesheet import.

`materials.ts` derives `<id>-html` and `<id>-react` entries from the ID list. Adding a registered recipe needs no contract, router or UI change. HTML materialization writes a page, stylesheet, script and only selected local runtime files; previews inline the same source with a sandboxed no-network CSP. React materialization writes a TSX unit and declares dependencies. Content digests cover emitted bytes, adapter and dependency declarations. Existing adoption, rights, receipt and undo gates still apply; adding an entry does not certify a full workbench adoption journey.

`runtime.ts` loads the workspace's pinned GSAP 3.15.0 bytes and verifies version; it never fetches a CDN fallback. React requires `gsap ^3.15.0` and `@gsap/react ^2.1.2`. The existing GSAP Standard licence notice and operation grants remain authoritative. Only GSAP core, ScrollTrigger and Flip are supported here; no SplitText, CustomEase or smooth-scroll dependency is introduced.

Motion runs inside `gsap.matchMedia`. Static HTML/SSR shows final content. Starting in reduce mode creates no motion; live preference changes revert styles, tweens and triggers. Recipe cleanup also removes event listeners and restores custom text. HTML exposes `window.odGsapRecipes[id].revert()`. Pin recipes restore original inline attributes after GSAP teardown, which can render a scrub animation during pin cleanup. A persisted pagehide keeps the context for back/forward cache; a real pagehide stops motion; persisted pageshow restarts it. React scopes the effect to a root ref and uses context cleanup through `useGSAP` for Strict Mode and unmount. See [GSAP matchMedia documentation](https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/) and [ScrollTrigger documentation](https://gsap.com/docs/v3/Plugins/ScrollTrigger/).

## Observation register

Observed 2026-10-08 through Ego Browser navigation, rendered page snapshots and scroll/pointer input. No source scripts or stylesheets were downloaded or copied. Screenshot capture timed out; these observations support content/state structure, not frame-accurate timing or visual fidelity. Values in the behavior table are chosen recipe defaults, never reported as measured site timings.

| Public reference | Observation and limit |
| --- | --- |
| [Linear](https://linear.app/) | Hero headline with separately composed lines and a layered product demonstration. Supports a headline/product hierarchy reference; entrance timing was not measured. |
| [Stripe](https://stripe.com/) | Hero metric, partner logos and product cards with changing payment examples. Native scroll exposes the product grid. No confirmed logo-loop speed or counter timing. |
| [Vercel](https://vercel.com/) | Hero canvas/product illustration, partner row and feature/customer section after scrolling. Card and logo patterns are design interpretations, not confirmed exact animations. |
| [Apple MacBook Pro](https://www.apple.com/macbook-pro/) | Long product presentation with image, performance and comparison sections. Sticky/pinned storytelling is a proposed recipe treatment; this session did not establish precise pin boundaries. The requested iPhone 17 Pro URL redirected to the iPhone landing page, so it was not used as product-page evidence. |
| [Dennis Snellenberg](https://dennissnellenberg.com/) | Branded page-entry greeting state, large name and navigation links. Hover/navigation observations did not establish magnetic distance, tilt or follower timing. Those interactions are independently specified patterns. |

## Behavior specifications

Defaults prioritize legibility and native scroll. Entrances use GSAP `power3.out`, an ease-out curve in the requested fast-settle family of `cubic-bezier(0.23, 1, 0.32, 1)`; it is an approximation, not an exact cubic-bezier implementation. Scrubbed motion and seamless loops use `none` to keep progress uniform. Stagger and delay are zero unless listed. No recipe starts at scale zero. Distances are CSS pixels unless noted. Replace sample copy, metrics and original CSS artwork with project-owned material.

| Recipe | Trigger and timing | Easing / duration | Distance / stagger | Reduced-motion fallback |
| --- | --- | --- | --- | --- |
| `hero-lines` | Mount; pre-authored lines inside masks | `power3.out`, 550 ms per line | 105% line-height Y; 80 ms stagger | Entire headline at rest |
| `hero-words` | Mount; short pre-authored phrase | `power3.out`, 350 ms per word | 16 px Y, opacity 0→1; 45 ms stagger | Complete phrase at rest |
| `scroll-parallax` | Section top enters viewport bottom through bottom leaving top | `none`, scroll progress with 350 ms catch-up | −40→40 px Y; no stagger | Centered field, no trigger |
| `card-stagger` | Grid top reaches 85% viewport; once | `power3.out`, 450 ms per card | 24 px Y, opacity 0→1; 75 ms stagger | Entire grid visible |
| `image-mask` | Artwork top reaches 85% viewport; once | `power3.out`, 600 ms | Bottom inset 100%→0%; no stagger | Full artwork visible |
| `number-counter` | Metric top reaches 85% viewport; once | `power3.out`, 600 ms | 0→authored integer; no spatial motion/stagger | Final metric; stable assistive text |
| `sticky-story` | Eligible desktop story reaches top +24 px; releases at story bottom / viewport bottom | `none`, scroll progress with 400 ms catch-up | Decorative orbit rotates 120° across the chapters; no stagger | Unpinned artwork, all chapters in flow |
| `logo-marquee` | Mount; continuous loop; explicit pause plus temporary hover/focus pause | `none`, 18 s per cycle | Track −50% (one of two equal groups); no stagger | Single wrapping static group; duplicate/control hidden |
| `magnetic-button` | Fine pointer over link; reset on leave or keyboard focus | `power3.out`, 300 ms catch-up/reset | Label follows at 12% pointer offset, clamped ±8 px X/Y; no stagger | Stationary labelled link; no listeners |
| `page-transition` | Incoming page mount; host remounts per route change; links navigate immediately | `power3.out`, 300 ms | 12 px Y, opacity 0→1; 50 ms stagger | Incoming content immediately visible |
| `section-pin` | Eligible desktop scene reaches top +24 px; release after min(600 px, 75% viewport height) | `none`, scroll progress with 400 ms catch-up | Decorative field −16→16 px X; no stagger | Normal unpinned scene |
| `cursor-follower` | Fine-pointer movement within one surface; fades on leave | `power3.out`, 250 ms position / 200 ms opacity | Pointer X/Y within the surface minus 12 px to center the 24 px dot; no stagger | Decorative dot absent; native cursor retained |
| `hover-tilt` | Fine-pointer movement in stationary surface; reset on leave | `power3.out`, 350 ms catch-up/reset | Rotation X/Y clamped ±5°; 900 px CSS perspective; no stagger | Flat card, no pointer listeners |
| `image-crossfade` | Fine-pointer hover or keyboard focus of link; focus retains alternate after pointer exit | `power3.out`, 300 ms | Decorative alternate opacity 0→1; no translation/stagger | Primary artwork and usable caption/link |

Pinned recipes activate only at viewport widths ≥768 px and heights ≥600 px. They leave the native scrollbar and wheel behavior in charge. The marquee preserves an explicit pause choice across a preference cycle; focus may keep it temporarily paused after choosing Resume until focus leaves. Pointer recipes ignore touch pointer events and react to fine-pointer capability changes.

`page-transition` supplies only the incoming scene. Its React component must remount on route change (for example with a route key); it does not install router hooks or delay navigation for an exit animation. The HTML unit runs on document load.

The existing `section-entrance`, `scroll-story`, `flip-filter` and `svg-feedback` recipes retain their original source and behavior. Their format and adoption tests remain the baseline for the new cohort.

## Verification boundary

`tests/workbench/gsap-recipes.test.ts` covers pinning, discovery/inspect, no-network previews, materialization, receipt refusals and adoption/reuse/undo. `gsap-recipes-runtime.test.ts` iterates the registered IDs for React compilation/SSR, Strict Mode, cleanup and initial/live reduced motion, plus HTML local-runtime execution. Interaction cases cover pointer bounds/touch/coarse-pointer fallback, pause/focus behavior, counter final value, no-runtime links, sized artwork, pin spacers and live viewport changes. The production fixture builds and hydrates all 18 components together without hydration errors. jsdom uses an explicit scroll-offset shim for the API it lacks; it supplies no layout proof. These are package/DOM receipts, not native desktop, browser layout or full PRD acceptance receipts. Pinning and pointer layout also need a real-browser check before visual qualification or landing by the captain.

### React production receipt

Landing prep regenerates the G02 receipt with `buildG02ReactReceipt()` and writes both the daemon mirror and evidence JSON with `writeG02ReactReceipt()`. The fixture includes all 18 registered components. A fresh verification process checks deterministic reproduction and the production gate; recipe integration tests require that gate to accept the current unit bytes. React 18 is the covered major. Other majors remain pending.

```bash
OD_UPDATE_G02_RECEIPT=1 pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/workbench/g02-react-receipt.test.ts
pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/workbench/g02-react-receipt.test.ts tests/workbench/gsap-recipes.test.ts tests/workbench/gsap-recipes-runtime.test.ts tests/workbench/gsap-marketing-recipes.test.ts
```

Catalog content and listing digests are derived from materialized bytes at runtime; there is no separate committed GSAP catalog digest fixture. Historical evidence imported from main is retained. G02 is the generated receipt whose inputs this branch changes.

### Capability and localization

HTTP resource search/inspect and `/api/workbench/recipes/gsap/:itemId/preview` expose the registered cohort. The web resource search/detail and `od workbench search`, `inspect`, `recipe preview`, and `adoption catalogue-prepare` consume the same endpoints. The existing prepare/apply/undo flow retains rights, dependency and receipt gates.

New catalog titles, purpose, trigger, reduced-motion and cleanup descriptions are localized through typed dictionary keys in English only (owner decision 2026-10-10). The UI changes presentation only: resource refs, digest identity and adoption inputs retain their HTTP values. Recipe demo copy is editable authored English content. No generation prompt text changes relative to main, so neither legacy nor OD Next prompt composition changes.

## Landing prep verification — 2026-10-09

Merged fetched main `1aed443114526c0143f666d5129ea4aa192683b9` with a merge commit, preserving branch history. Node 24.16.0 and Corepack pnpm 10.33.2 supplied the pinned workspace environment. Generated files were rebuilt with their generators; no receipt hashes were edited.

| Gate | Result |
| --- | --- |
| G02 update command above | 1 passed, 1 intentionally skipped in update mode; regenerated both mirrors |
| Four scoped daemon files in the verification command above | 160 tests passed, including fresh deterministic receipt reproduction and the production gate |
| `pnpm guard` | Passed, exit 0 |
| `pnpm typecheck` | Passed, exit 0 |
| `pnpm --filter @open-design/web typecheck` after the final UI journey test | Passed, exit 0; test mock source ID kept as its literal type |
| `pnpm --filter @open-design/web exec vitest run -c vitest.config.ts tests/components/workbench/workbench-gsap-recipe.test.tsx` | 9 tests passed, including English/Spanish presentation and unchanged adoption identity |
| `pnpm --filter @open-design/web exec vitest run -c vitest.config.ts tests/components/workbench/workbench-resource-enlarge.test.tsx` | 42 tests passed, including Spanish search → inspect → variant switching through the real UI components and original HTTP keys |
| `pnpm i18n:check` | Passed, exit 0 |
| `pnpm tools-dev stop --namespace t4-motion-recipes --json`, then status | All three apps not running; no matched or remaining PIDs |

Independent static review by Claude Sonnet 5.5 (`claude-sonnet-5-5`, session `0e986f3e-3678-43c6-b2a6-8fe310785b4d`) found parallax margin collapse and an inactive marquee control without GSAP. Both were fixed; browser geometry confirmed the parallax correction, and a no-runtime test covers the marquee fallback. Follow-up review confirmed the fixes. Its localization wiring test-gap warning was closed by the UI journey test and by removing identity inference from display labels. No unresolved BLOCK/WARN findings remain. The reviewer did not execute tests; the results above come from landing prep.

A generated HTML fixture rendered all 14 marketing recipes in EGO Lite. Checks covered desktop/390 px horizontal overflow, live reduced-motion trigger and pin-spacer removal, final counter restoration, marquee pause/static fallback, sticky-story pin geometry, and crossfade pointer/focus behavior. The fixture is `~/Inbox/html/t4-motion-recipes.html`; screenshots are under `~/Inbox/screenshots/t4-motion-*.png`. This is browser proof of emitted HTML, plus DOM/production-build proof of React, and mocked web UI journey proof. It does not certify a full running workbench journey, native desktop delivery, every pointer geometry, or per-item PRD acceptance. Recipes retain their existing `unverified` readiness. React 18 is the receipt-covered major; the original four recipes retain their preexisting English catalog metadata.

Logs and raw independent review outputs are in this worktree's ignored `.tmp/t4-*` files. No `zs-land`, PR creation, main mutation or force push forms part of this prep.

## Historical worker verification receipts

2026-10-08, `codex/t4-motion-recipes`, Node 24.18.0 / pnpm 10.33.2. The worktree's private better-sqlite3 binary initially used another Node ABI; it was rebuilt explicitly with Node 24 before the successful tests. No tracked dependency or lockfile changes were made.

| Command / check | Result |
| --- | --- |
| `pnpm --filter @open-design/daemon test tests/workbench/gsap-recipes.test.ts tests/workbench/gsap-recipes-runtime.test.ts tests/workbench/gsap-marketing-recipes.test.ts` | 3 files, 157 tests passed; includes a real expanded build/SSR/hydration fixture receipt injected only into tests |
| `pnpm guard` | Passed, exit 0 |
| `pnpm --filter @open-design/daemon typecheck` | Passed, exit 0 |
| Independent generated-source semantic check | All 14 emitted marketing TSX components passed strict TypeScript 5.9.3 / noEmit with React 18 types and pinned GSAP packages; zero diagnostics |
| `pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/workbench/g02-react-receipt.test.ts` | 2 tests failed against the untouched committed production receipt: reproduction differs and its gate returns `receipt-unit-mismatch`. The fresh expanded fixture build itself passes. Captain regeneration is required before landing. |
| Independent implementation review | Image placeholder and updater-test findings resolved; no additional code blockers. Integration remains blocked by the production receipt. |

Commands were executed through Corepack. Logs remain in this worktree's ignored `.tmp/motion-*.log`. The full daemon suite selected by the extra `--` was interrupted; it is not a passing receipt. Public-site timings, browser pin geometry and final visual quality remain unverified. Source/tests are locally committed for the captain; this worker does not push, publish, merge or restart a shared runtime.
