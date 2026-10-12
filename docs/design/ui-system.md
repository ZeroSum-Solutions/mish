# Mishh Mashh UI system

The rules every web UI change follows. Tokens live in
`apps/web/src/styles/tokens.css` (roles) and `apps/web/src/styles/base.css`
(raw `--spacing-*` / `--font-size-*` steps); glass materials live in
`apps/web/src/styles/material.css`; reusable components live in
`packages/components`. This document says which token to reach for and why.
When a design draft for a surface (for example the chat panel drafts, which
are not part of this repository) pins a value, the draft wins for that surface.

## 1. Character

Mishh Mashh is a quiet, neutral workspace. Neutrals carry the interface;
brand green (`--brand*`, `--send-ground`) is sparse feedback and emphasis
only. Albert Sans for UI, IBM Plex Mono for code and numbers. Upgrades keep
this character: no new hues, no gradients on chrome, no decorative motion.

## 2. Hierarchy

Each screen has one primary action, at most a few secondary actions, and
everything else is tertiary.

| Level | Treatment |
|---|---|
| Primary | `Button variant="primary"`: solid `--text-strong` pill. One per view region. |
| Secondary | `Button variant="secondary"` or default: hairline border, no fill. |
| Tertiary | `Button variant="ghost"`, `IconButton`, text links. |
| Destructive | Secondary treatment plus `--red` text; confirm in a dialog. |

Hierarchy in text is size **and** weight together (section 3). Never rely
on color alone: `--text-strong` for titles and values, `--text` for body,
`--text-muted` for supporting copy, `--text-soft` for metadata, `--text-faint`
only for placeholders and disabled.

## 3. Typography

Use the role shorthands with `font:`. Line heights are on a 2px rhythm.

| Role | Token | Size / line | Weight | Use |
|---|---|---|---|---|
| Display | `--font-display` | 40 / 46 | 600 | Hero headings (one per page) |
| Headline | `--font-headline` | 28 / 34 | 600 | Page titles |
| Heading | `--font-heading` | 20 / 28 | 600 | Dialog titles, section headers |
| Title | `--font-title` | 16 / 24 | 600 | Card titles, panel headers |
| Title small | `--font-title-sm` | 14 / 20 | 600 | List-row titles, group labels |
| Body | `--font-body` | 14 / 22 | 400 | Default reading text |
| Body small | `--font-body-sm` | 13 / 20 | 400 | Dense panels, chat prose |
| Label | `--font-label` | 13 / 18 | 500 | Control labels, chips, menu items |
| Control | `--font-control` | 14 / normal | 500 | Button and toggle text (controls size by their own height) |
| Caption | `--font-caption` | 12 / 16 | 400 | Metadata, timestamps, helper text |
| Micro | `--font-micro` | 11 / 14 | 500 | Badges, counters (never body text) |

Tracking: `--tracking-snug` (-0.01em) at 20px and up, `--tracking-tight`
(-0.02em) at 28px and up, `--tracking-wide` only on micro uppercase labels.
Numbers that change in place use `font-variant-numeric: tabular-nums`.

## 4. Spacing and padding

Everything sits on a 4px grid (`--space-1` = 4px … `--space-16` = 64px;
`--space-half` = 2px for optical nudges only). Choose by relationship:

| Relationship | Token |
|---|---|
| Icon ↔ its label inside a control | `--space-1` / `--space-2` |
| Between related controls in a row | `--space-2` |
| Between fields in a form, items in a list | `--space-3` |
| Card inset | `--inset-card` (16px) |
| Panel inset | `--inset-panel` (20px) |
| Dialog inset | `--inset-dialog` (24px) |
| Between groups inside a panel | `--space-6` / `--space-8` |
| Between page sections | `--space-12`+ |

Menus pad by `--inset-menu` (4px) with items at `--inset-menu-item`
(8px × 12px). Nested radius = outer radius − padding.

## 5. Sizing

Controls land on five heights: `--control-h-xs` 24, `--control-h-sm` 28,
`--control-h-compact` 32 (square icon buttons and filter chips),
`--control-h-md` 36 (default), `--control-h-lg` 44 (touch / hero CTAs).
Icon glyphs are 16px in sm/md controls, 18px in lg. Icon-only targets are
never smaller than 28px. Text measure for reading copy stays at or below
68ch.

## 6. Shape

Radii come from the scale in `tokens.css` only (use these role names; the
`--radius-small … --radius-2xlarge` tier underneath is legacy, kept for
existing consumers — don't reach for it in new code): `--radius-xs` 2 (inline
code), `--radius-sm` 4 (small controls, menu items), `--radius-md` 8
(cards, menus, inputs), `--radius-lg` 12 (panels, dialogs), `--radius-xl`
16 (large surfaces, composer), `--radius-pill` (chips, primary and
secondary buttons).

## 7. Elevation and glass

Two layers exist:

- **Content layer** — cards, panels, lists. Solid fills (`--bg`,
  `--bg-panel`, `--bg-elevated`). Elevation 0–2.
- **Functional layer** — anything floating over content: menus, popovers,
  select lists, floating toolbars, docks. Glass material
  (`--glass-surface`, the *thick* material, so busy content behind never
  fights the menu's text; `backdrop-filter: var(--glass-backdrop)`). Nested
  flyouts never stack two translucent layers over each other. A
  `--glass-surface-sheen` top-edge highlight, a hairline
  `--material-separator` border, elevation 3.
- **Dialogs and drawers** — float like the functional layer but hold dense
  content, so they keep a **solid** fill (`--bg-elevated` / `--bg-panel`) and
  borrow only `--elevation-4` and the `--glass-surface-sheen` edge.

| Tier | Token | Meaning |
|---|---|---|
| 0 | `--elevation-0` | Flush with the page |
| 1 | `--elevation-1` | Resting card or input |
| 2 | `--elevation-2` | Hovered / raised card, sticky bar |
| 3 | `--elevation-3` | Menu, popover, select list |
| 4 | `--elevation-4` | Dialog, sheet |

Layering rules:

- A flyout nested inside another blurred layer (a submenu, a plugin
  preview beside its menu) is **solid** `--bg-elevated`: a second blur can
  only see its parent, so stacked glass reads as a smear.
- Choosing inside a card renders the list **in** that card (tabs and a
  scrolling list), never a second floating layer on top of it.
- A list of providers or settings uses `DisclosureRow`: name, status
  `Badge` and one action at a glance; details expand in the row.

- Navigation selection (rail items, tabs) uses the segmented thumb
  (`--segmented-thumb` + its shadow) as the moving selection surface.
- Edge-reveal overlays (the collapsed nav rail) use the thick glass mixed
  halfway toward `--bg-elevated` (dense list over arbitrary imagery) at
  elevation 3, open after ~120ms of rest at the edge, close after ~260ms of
  grace or on Escape, never open during a drag or under a modal, and appear
  instantly under reduced motion.
- An empty state is one panel with one action, and never repeats the page's
  primary action. Use `EmptyState` (`variant="plain"` inside a drawer, card
  or popover).
- A pane is one surface: its header, body and composer share one ground
  (the chat pane's `--chat-pane-ground`), with no seams or second fills
  between regions.
- A card nested inside another card or panel takes the radius one step
  below its parent (`--radius-lg` panel holds `--radius-md` cards).
- In a menu, the active row is marked with the segmented thumb, and an
  item that is already open says so as quiet `--text-soft` text, not as a
  second pill or button.
- A search field in a popover header carries the focus feedback itself
  (`data-ui-field-shell`); the row draws no rule.
- A preview stage shows a skeleton until its content loads. Palettes over
  eight colors show as one strip with an expand control.

Exceptions: tooltips and tooltip-like hover cards stay solid
(`--bg-elevated`) because they sit over arbitrary preview content and must
keep contrast. Surfaces whose stylesheet documents a deliberate solid or flat
decision keep it. Text on glass uses the
`--vibrancy-*` tokens. `prefers-reduced-transparency` falls back to solid
surfaces at the token level (material.css), so consumers need no extra rule.

## 8. Interaction states

Every interactive element defines all of these:

| State | Rule |
|---|---|
| Rest | Token colors from its variant. |
| Hover | One step stronger: fill to the next `--bg-*` step or border to `--border-strong`; text to `--text-strong`. `--motion-hover` (150ms) `--ease-out-quint`. Never flip a dark control to light. |
| Press | **Spring-loaded**: `transform: scale(var(--press-scale))` (0.97; icon-only `--press-scale-icon` 0.92; cards, rows and menu items `--press-scale-card` 0.99). On `:active`, set `transition-duration` with one entry per transitioned property so only `transform` uses `--motion-press` (90ms); the release springs back on `--spring-snappy`. |
| Focus | **Text fields:** the 1px border becomes the *shimmer* — a slow conic sweep with a contrast-safe base (`--focus-shimmer-base`, 3:1+) and a brand-tinted highlight (`styles/workspace-ui.css`); no halo ring, no size change; static under reduced motion. Selects and bottom-rule search rows only strengthen their border. **Everything else:** `outline: var(--focus-outline); outline-offset: var(--focus-offset)` on `:focus-visible` only, so mouse clicks never draw a box; keyboard users always see where they are (WCAG 2.4.7). |
| Selected | `aria-pressed` / `aria-selected` / `aria-current`, `--border-selected` or `--bg-subtle` fill, `--text-strong` text. |
| Disabled | `--text-faint`, no hover, `cursor: not-allowed`, no transform. |
| Busy | `Button loading`: keeps width, spinner covers the label (hidden with `opacity`, so it still names the button), `aria-busy`. |

Hover feedback on cards: lift by `--hover-lift` (-1px) and move from
elevation 1 to 2.

## 9. Motion

| Token | Curve | Duration | Use |
|---|---|---|---|
| `--spring-snappy` | ~2% overshoot | `--spring-snappy-duration` 360ms | Press release, toggles, chips |
| `--spring-smooth` | no overshoot | `--spring-smooth-duration` 560ms | Panels, drawers, layout shifts |
| `--spring-pop` | ~5% overshoot | `--spring-pop-duration` 340ms | Menus, popovers, toasts, dialogs entering |
| `--ease-out-quint` | cubic-bezier(0.23, 1, 0.32, 1) | `--motion-enter` 200ms / `--motion-exit` 140ms | Fades, color, opacity |

Legacy duration aliases (`--duration-*`, `--dur-*`, `--curve-*`, `--ease-out`)
remain for existing consumers and draft-pinned surfaces (tooltips); new code
uses only the tokens in this table.

Rules: always pair a spring curve with its duration token. Floating layers
enter from `translateY(var(--enter-offset))` and `scale(var(--enter-scale))`
(0.96), never from `scale(0)`. Exits are faster than entrances. `ease-in`
is never used for UI. Animate only `transform` and `opacity` for movement.
Accordions use `.accordion-collapsible` (grid-rows 0fr → 1fr). Elements that
show conditionally stay mounted and toggle a class so exits can play.
`prefers-reduced-motion` collapses springs and travel at the token level.

## 10. Components

Reach for `@mish/components` before writing markup:

| Component | Use |
|---|---|
| `Button` | Text actions. `variant`: primary, secondary, ghost, subtle, primary-ghost; `size`: default, sm, icon; `loading`. |
| `IconButton` | Icon-only actions. `label` is required (accessible name + tooltip); `variant`: ghost, subtle, solid, glass; `pressed` for toggles. |
| `Chip` | Filters, modes, suggestions. `selected` (pass `true`/`false` on toggle chips so every chip announces `aria-pressed`; omit only on action chips), `icon`, `trailing`, `size`. |
| `Badge` | Non-interactive status or count. `tone`, `dot`. Status tones mix their hue 55% with `--text-strong`, so 11px text clears 4.5:1 on its fill in both themes. |
| `Surface` | Containers. `variant`: solid, glass, sunken, outline; `elevation` 0–4; `radius`; `padding`; `interactive` (clickable card: focusable, `role="button"` unless you pass a role, Enter/Space fire `onClick`). |
| `Dialog` | Modal tasks. Pops in on the pop spring at elevation 4. |
| `Input`, `Select`, `Textarea` | Form fields. |
| `PreviewCard` | Media card with caption, title and description (template and example tiles). |
| `VisuallyHidden` | Screen-reader-only text and live status. |
| `DisclosureRow` | A row (title, summary, status, one action) that expands to show its details; settings and provider lists. |
| `EmptyState` | One designed empty state: optional 20px icon tile, a title line, an optional sentence and one action. `variant`: panel (page-level, default), plain (inside a drawer, card or popover). |
| `Spinner` | Indeterminate activity; give it a `label` when nothing else announces it. It stops rotating under reduced motion. |

If a needed primitive is missing, add a small focused one to
`packages/components` with a colocated CSS Module and a test, following the
tokens above.

### Choosing a selection control

Pills were overused. Pick by the job, and use exactly one look per job:

| Job | Control | Look |
|---|---|---|
| One exclusive choice among 2–5 (theme, view, scope, source) | `SegmentedControl` (`components/ui`) or `.subtab-pill` for legacy markup | Recessed pill track (`--segmented-track`), raised thumb (`--segmented-thumb`) that slides to the choice |
| Optional filters or modes in a row | `Chip` | Calm: borderless, `--chip-text`; hover `--chip-hover-fill`; selected `--chip-selected-fill` + `--chip-selected-text` |
| One choice among 6+ (providers, models, systems) | Searchable list or select inside one card | Rows with a status dot or `Badge`; selected row checked |
| Status, never clickable | `Badge` | Tinted, 11px |

Never render more than about eight chips in a row; past that, use a searchable list.

## 11. Accessibility floor

- Text contrast at least 4.5:1 (3:1 for 18px+ or 600-weight 14px+).
- Every icon-only control has an accessible name.
- Keyboard focus is always visible (section 8); never remove an outline
  without the replacement ring.
- Hit targets at least 28px; 44px for primary touch targets.
- State is announced with ARIA (`aria-pressed`, `aria-expanded`,
  `aria-busy`), not only drawn.

## 12. Review checklist

Before a UI change is ready, confirm:

1. Every new color, space, radius, shadow and duration is a token.
2. The screen has one primary action.
3. Type uses a role from section 3.
4. All interactive states from section 8 exist.
5. Floating menus and popovers use glass + elevation 3; dialogs stay solid at elevation 4; both enter on a spring.
6. Light and dark both checked; reduced motion checked for anything that moves.
7. A screenshot of the entry point is attached to the PR.
