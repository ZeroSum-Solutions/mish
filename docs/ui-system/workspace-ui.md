# Workspace interface system

Scope: every application route, including Catalog. The route controller applies `data-ui-system="workspace"` to keep shared tokens, controls, navigation, and custom accent ink consistent across route changes.

## Reference lock and decisions

Primary: [Linear](https://linear.app), Refero style 554b801c-3b31-4086-a7e5-ae613cdd618b; workspace settings screen 7c3c8f7a-d100-4c94-aa23-8bf1a62db0ca. Borrow compact navigation, tonal surface separation, clear text hierarchy, sparse emphasis. Preserve Albert Sans and Mishh Mashh green.

Secondary: [shadcn/ui](https://ui.shadcn.com), style c14c0a94-1037-449e-bf5b-4cb972656ac7. Borrow predictable controls, consistent focus, crisp light-theme fields. Desktop.fm style 5b70f172-2ba2-4f26-9956-251d4cfc0329 informs restrained floating-surface depth only.

| Decision | Rule |
| --- | --- |
| Color | Neutral canvas, panel, inset and elevated roles. Green identifies selected assists and success; red errors, amber warnings, blue information. |
| Contrast | All normal text, including metadata and placeholders, reaches 4.5:1 on supported surfaces. Essential control boundaries and focus indicators reach 3:1. Disabled controls remain visibly disabled. |
| Type | Keep Albert Sans. Body 14px, metadata at least 12px, clear 1.5 line height for descriptions. No opacity on essential text. |
| Shape | Text fields 12px, action buttons and segmented choices capsules, cards 12px, larger panels 16px, dialogs 20px, capsules for segmented choices and catalog filters. Text controls grow with wrapped labels. |
| Reuse | Button/Input/Select/Textarea/Dialog remain React primitives. SegmentedControl owns keyboard/radio behavior; SelectionGroup/SelectionIndicator own shared motion. Product CSS controls layout. |
| Motion | A shared selection surface moves and resizes using Motion layoutId, with a tight spring. Text stays stationary. Groups have unique identities. Reduced motion uses a static indicator. |
| Effects | Solid readable content surfaces; translucent glass on navigation and floating menus only. Reduced transparency and unsupported blur restore solid panels. |

Use the role tokens in `apps/web/src/styles/workspace-ui.css`. Do not hardcode a light-theme hover color. Custom user accent colors remain separate from contrast-safe text and focus roles. Filled accents derive separate ink for rest, hover (86% accent), and strong (82% accent) states against the active theme. Semantic status fills use theme ink independently of a custom accent. Do not animate `all`, loop decorative effects, or introduce interaction delays.

## Preview cards

Home Examples uses `PreviewCard`, `PreviewCardMedia`, `PreviewCardCaption`,
`PreviewCardTitle`, and `PreviewCardDescription` from `@mish/components`.
Use these primitives for thumbnail selection cards. Keep independent actions
beside the card button so interactive controls are never nested.

| Part | Rule |
| --- | --- |
| Media | Full width, clipped to the frame. Images and video use `object-fit: cover`; website previews anchor at the top. Do not add gutters or arbitrary image zoom. Home deck thumbnails use a measured cover scale; full deck previews retain their existing fit. |
| Caption | 12px on all sides, 4px between title and metadata. The shared component owns these tokens; product rails set card width and media height. |
| Title | 14px / 20px, weight 600, one line with ellipsis, maximum 24ch. Home shows the short name (Watson, Fervor, Wrenfield). Move a leading draft status into the style line. Keep the original title in the native tooltip and accessible button label. |
| Metadata | 12px / 18px, weight 400, muted role token, one line with ellipsis, maximum 28ch. Home families show the short atlas style (Editorial, Cinematic, Heritage); references show Reference plus their routed family or no-family notice. Keep complete routing details in the tooltip and accessible button label. |
| Height | A shared 66px caption plus the media height and 2px outer border. Home uses 248px/150px width/media on desktop, 224px/136px below 900px, and 208px/126px below 560px. Skeletons reserve the same geometry. |
| States | Native disabled behavior, pressed selection, pending/busy status, a distinct 2px keyboard focus outline, quiet hover, and reduced-motion handling. Reserve space around the focus outline in scrollable rails. |

The thumbnail may crop a source to fill its frame. Its full preview remains the
place to inspect the complete design. Missing or failed media uses the existing
text/title fallback in the same frame.

Home's Jev artwork is `apps/web/public/images/jev-card.webp`, generated with
Higgsfield GPT Image 2 on 2026-10-03 (job `65f8b568-ebd1-4b11-9a1f-80b7985fb26c`).
It uses a mint-glass and titanium J on charcoal to match the workspace palette.
It ships as a local asset; a load failure restores the existing monogram.

Motion implementation follows [Motion layout animation](https://motion.dev/docs/react-layout-animations). Contrast policy follows [WCAG 2.2 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Theme token tests calculate actual sRGB contrast rather than compare palette snapshots.

## Black and glass refinement — 2026-10-01

The owner requested deeper black, the Settings execution-mode capsule treatment,
subtle glass, consistent Catalog styling, and fixes for overlapping text.
Primary refinement reference: [Linear Changelog](https://linear.app/changelog),
Refero style `11d3e58a-87d7-4a9a-bbf5-720f4fd3ffc6`. Preserve monochrome depth,
thin graphite borders, bright readable type, and pill controls; retain the app's
Albert Sans and green semantic emphasis. shadcn/ui remains the secondary control reference.

| Decision | Source and role |
| --- | --- |
| Silky black canvas `#080809`, working surface `#0c0c0e`, panel `#141416` | Owner's darker theme request; Linear tonal separation. |
| Glass navigation and menus, solid content cards | Owner's glass request; existing material fallbacks retain readability. |
| Capsule segmented controls and catalog filters | Owner's execution-mode screenshot. |
| Auto-height toggle rows and text navigation | Privacy screenshot: inherited fixed button height clipped multi-line hints. |
| Absolute selection decorations | Live Settings check: decoration must never occupy the icon or label grid column. |
| Shared Catalog theme and custom accent ink | Owner requested matching the rest of the application. |

### Refinement validation

- Focused interface and Settings execution checks: 4 files, 284 tests passed.
- Final interface checks after review fixes: 3 files, 134 tests passed.
- Web typecheck, repository guard, and diff whitespace checks passed.
- Browser: Settings execution and privacy at 787px; privacy and Catalog at 390px;
  Catalog in light and OS-following dark. Narrow pages have no horizontal overflow.
- Reduced-transparency emulation resolved glass to the solid panel and
  removed backdrop filtering. The final owner refinement lifts the canvas slightly to silky black. Viewport and media overrides were reset after checking.
- Separate read-only reviewer found no remaining concrete issue after the selection
  radius and fallback cascade fixes. Static review only.
- No provider generation, packaged-app, or full workflow validation is claimed.

Screenshots captured before the final slight silky-black lift: [Settings](screenshots/black-glass/settings-dark.jpg),
[privacy at 390px](screenshots/black-glass/privacy-390.jpg),
[Catalog dark](screenshots/black-glass/catalog-dark.jpg),
[Catalog light](screenshots/black-glass/catalog-light.jpg),
[Catalog at 390px](screenshots/black-glass/catalog-390.jpg).

## Previous validation (before this refinement)

Validated locally in the isolated `codex/app-ui-system` checkout, with an isolated daemon/data root and web preview. The active Catalog checkout and its running services were not changed.

| Gate | Evidence |
| --- | --- |
| Focused UI regressions | 55 files / 387 tests passed: style acceptance, UI system, appearance, theme preference, Settings, rail ownership, and chat theme seams. |
| Final palette/scope/control check | 3 files / 134 tests passed after the responsive rail fix. Includes light/dark role contrast, custom accent rest/hover/strong contrast, Catalog scope cleanup, radio keyboard behavior and reduced motion. |
| Home visibility follow-up | 5 files / 64 tests passed. Wordmark follows the theme ink; home preset cards load immediately after their reachability probe; recent HTML covers keep a glyph until loading finishes. Existing offscreen, concurrency and suspension gates remain intact. Browser inspected the complete example rail and both available recent covers in light and dark at 1046px. |
| Plugin picker follow-up | 8 files / 62 tests passed. Home and project pickers share full-name rows and baked-first thumbnails; off-screen rows release live previews. Click-after-hover remains open and selection preserves the draft caret. Checked 52 selectable records: 27 HTML, 11 media, 14 letter tiles. 48 of 49 declared preview assets resolve; the missing plugin-authoring HTML uses the verified readable fallback. Browser inspected Home in both themes at 1046px, Home at 390px, and the project picker inside a 377px chat pane in both themes. Full preview remains reachable by scrolling in narrow panes. |
| Shared primitives | Existing component tests passed (9 tests). |
| Static checks | `pnpm guard`, root `pnpm typecheck`, and `git diff --check` passed. |
| Browser | Inspected settings, home, plugins, automations/dialogs, design systems, design index and synthetic project files. Settings, plugins, automations and project selections were inspected in both themes. |
| Theme and motion | System dark resolved the same palette with no explicit theme attribute. Reduced-motion emulation rendered static indicators; ordinary motion restored shared indicators. |
| Responsive | 390px Settings and Home have no page overflow. The open rail remains usable as a floating panel below 1080px; main content retains its full grid column. Wider windows keep the docked rail. |
| Catalog scope (superseded) | The previous delivery excluded Catalog. This refinement removes that exception; the scope regression now verifies shared roles and custom accent ink through Catalog navigation. |
| Independent review | Separate read-only reviewer found no remaining issue above minor after the contrast and responsive fixes. Static review only. |

Plugin picker screenshots are `plugin-picker-light.png`, `plugin-picker-dark.png`, `plugin-picker-mobile.png`, and the project views. Home follow-up screenshots are `home-visibility-light.png` and `home-visibility-dark.png`. Screenshots are local QA artifacts under `.tmp/ui-system/shots/`, including `light-dark-settings.png`, `plugins-light.png`, `plugins-dark.png`, `project-selection-light.png`, `project-selection-dark.png`, and the 390px views. The preview uses synthetic local project content and no agent generation. This validates UI behavior and representative rendered surfaces; it does not claim packaged-app, provider, or every workflow state coverage.

The implementation adds no dependency and no API/CLI behavior. Its commits were integrated with the Catalog work in `codex/land-mishmash-sessions`; see `../session-integration-2026-10-01.md` for combined validation and preserved session branches.

## Silky fields and General control reference — 2026-10-01

The owner selected Settings → General as the application control reference.
Use its rounded capsule silhouette and soft tonal fill for shared default action
buttons. Primary, secondary, ghost, destructive and icon variants keep their
meaning and sizing. Segmented choices keep the existing raised selected surface.

Text inputs, textareas and native selects share `--ui-field-radius` (12px),
`--ui-field-surface`, and `--ui-field-sheen`: an opaque panel with a fine upper
highlight and a soft shadow. Keep input text crisp; no blur on editable content.
Native select chevrons and component-owned error/required borders stay intact.
Search rows and the Lexical composer put the finish on their enclosing surface,
so the editable element does not receive a second inset box. Hidden, terminal,
checkbox, radio, range, color and file controls are outside the text-field role.

`--ui-action-radius` and `--ui-action-surface` are opt-in workspace roles consumed
by both legacy and shared React buttons. Non-workspace consumers retain their
previous defaults. Do not globally change control heights or padding; narrow
layouts, icon controls, and multi-line labels keep their component layout.

Live browser verification and new screenshots are pending: the session browser's
saved permission setting blocks localhost access. Source checks and automated
validation are recorded in the change's pull request; earlier screenshots above
show the previous delivery, not this field polish.

Validation for this pass: 6 focused web test files / 185 tests passed, plus
2 shared primitive test files / 9 tests. Repository guard, root typecheck and
diff whitespace checks passed. Separate static review confirmed composite
searches, the single-frame composer, field states, and button variants after
the composer adjustment. No new runtime capability or CLI behavior is added.
