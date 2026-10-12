# Neutral Product

> Category: Productivity & SaaS
> Calm, neutral product UI. One steel-blue accent, system fonts, 8px rhythm, light and dark modes.

Neutral Product is archetype 1 of the agency design-system core. It is the
default for software that people use for hours: admin tools, CRMs, portals,
dashboards, and the marketing and document surfaces that sit next to them.
It is an original system. It does not copy or imitate a brand.

## Provenance and rationale

- **Source.** Written from first principles for the Mishh Mashh agency core
  (plan: "Recommended 10% design-system core", item 1). No brand site, kit, or
  proprietary font was sampled. Colors were chosen by contrast math, not
  picked from a reference product.
- **Fonts.** System stacks only. Nothing is vendored or loaded from a CDN, so
  the system has no font license to track.
- **Why neutral.** A product that people read all day needs low visual noise.
  Neutral surfaces let data, status colors, and the one accent carry meaning.
  Color is information, not decoration.
- **Why one accent.** The accent marks the next action and the current
  location. If it appears everywhere, it marks nothing. Target: two or fewer
  accent areas per screen (primary button plus active navigation item).
- **Why system fonts.** They render fast, match the user's platform, cover
  many scripts, and remove a layout-shift risk. Hierarchy comes from size,
  weight, and spacing.

## Color

Semantic roles, not a palette. Components reference roles only.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | #f8f8f7 | #111214 | Page canvas. |
| `--surface` | #ffffff | #191a1d | Cards, panels, tables, inputs. |
| `--surface-warm` | #f0f0ee | #212226 | Sunken areas: table headers, code, sidebars. |
| `--fg` | #16171a | #ededeb | Primary text, headings. |
| `--fg-2` | #3a3c41 | #cfd0cd | Body text in dense UI. |
| `--muted` | #55585f | #a9abb0 | Secondary text, help text. |
| `--meta` | #65686f | #979a9f | Timestamps, captions, placeholders. |
| `--border` | #dedfdb | #2d2f33 | Card edges and dividers (decorative). |
| `--border-soft` | #ebebe8 | #242629 | Table row separators. |
| `--border-strong` | #878a90 | #6f727a | Form-control boundaries (3:1). |
| `--accent` | #1e5a78 | #6cb4d9 | Primary action, links, current location, focus. |
| `--accent-on` | #ffffff | #0b1820 | Text on accent. |
| `--success` | #1d7348 | #5cc995 | Success text and icons. |
| `--warn` | #8a5300 | #e2ab4a | Warning text and icons. |
| `--danger` | #b3261e | #f0857a | Errors and destructive actions. |

Rules:

- Status never relies on color alone. Pair it with an icon and a word.
- Tinted status backgrounds use `color-mix(in oklab, var(--success), transparent 88%)`
  so they follow the mode. Do not add tint tokens.
- Borders are quiet. Controls that a user must find (inputs, checkboxes,
  selects) use `--border-strong`.
- The accent is a steel blue with low saturation. Do not replace it with a
  saturated or gradient accent.

## Typography

One family for display and body (the platform UI font). Monospace for code,
IDs, and tabular figures.

| Token | Size | Use |
| --- | --- | --- |
| `--text-xs` | 12px | Captions, badges, table meta. |
| `--text-sm` | 14px | Dense UI: tables, forms, navigation. |
| `--text-base` | 16px | Body text, marketing body. |
| `--text-lg` | 18px | Lead paragraphs, card titles. |
| `--text-xl` | 22px | Section titles inside apps. |
| `--text-2xl` | 28px | Page titles in apps, H2 on marketing pages. |
| `--text-3xl` | 36px | H1 on documents and phone heroes. |
| `--text-4xl` | 48px | Marketing hero only. |

- Weights: 400 body, 500 labels and table headers, 600 headings. Do not use
  700+ for headings; size carries the hierarchy.
- `--leading-body` 1.55 for reading. `--leading-tight` 1.2 for headings.
- `--tracking-display` (-0.015em) applies from `--text-2xl` up only.
- Line length: 60–75 characters for reading text (`max-width: 68ch`).
- Numbers in tables use `font-variant-numeric: tabular-nums`.

## Spacing

The layout grid is 8px. `--space-2` (8), `--space-4` (16), `--space-6` (24),
`--space-8` (32), and `--space-12` (48) set layout: gaps, padding, section
spacing. `--space-1` (4) and `--space-3` (12) are for spacing inside a
component, such as an icon and its label. `--space-5` (20) exists because the
shared schema requires it; do not use it for layout.

- Page sections: `--section-y-desktop` 96, `--section-y-tablet` 72,
  `--section-y-phone` 48.
- Control height: 40px default (8 × 5), 32px compact for dense tables.
- Card padding: `--space-6` desktop, `--space-4` phone.

## Layout

- Container: `--container-max` 1200px with gutters 32 / 24 / 16.
- App shell: 240px sidebar, fluid content, 56px top bar. The sidebar
  collapses into a top menu under 768px.
- Marketing grid: 12 columns at 1280, 6 at 768, 1 at 360. Content is left
  aligned. Heroes are left aligned with a product image or proof on the
  right; they are not centered stacks.
- Documents: one reading column (`68ch`) with an optional side rail for
  metadata. Deck slides use a 16:9 frame with a 48px safe margin.
- Radius: `--radius-sm` 6 for controls, `--radius-md` 8 for cards,
  `--radius-lg` 12 for large media, `--radius-pill` for badges only.
- Elevation: flat by default. `--elev-ring` for cards. `--elev-raised` only
  for elements that float over content (menus, popovers, dialogs, toasts).

## Iconography

- Line icons, 1.5px stroke, 16px in dense UI and 20px in navigation.
  `currentColor` only, so icons follow text color in both modes.
- Icons are inline SVG with `aria-hidden="true"` when a text label is next to
  them. An icon-only button needs an `aria-label`.
- No emoji as icons. No filled and outlined icons mixed in one view.
- Status icons: check-circle (success), alert-triangle (warning),
  x-octagon or alert-circle (danger), info-circle (neutral).

## Imagery

- Product screenshots and plain diagrams first. Show the real interface
  in a device-free frame with `--radius-lg` and `--elev-ring`.
- Photography, when used, is natural light, real work settings, and neutral
  color grading. No stock "team high-five" images.
- No decorative gradients, glows, glass panels, or 3D blobs.
- Every meaningful image has alt text that says what the image shows.
  Decorative images use `alt=""`.
- Charts use the text colors for axes and labels, `--accent` for the primary
  series, and status colors only when the series means that status.

## Motion

- Motion confirms a change. It does not decorate.
- `--motion-fast` 140ms for hover, press, and color changes.
  `--motion-base` 200ms for entering elements (menus, toasts, drawers).
- `--ease-standard` is a strong ease-out: `cubic-bezier(0.23, 1, 0.32, 1)`.
  Do not use ease-in for UI.
- Enter from `opacity: 0` and `translateY(4px)` or `scale(0.96)`. Never from
  `scale(0)`.
- Reduced motion: `tokens.css` sets both durations to 0ms under
  `prefers-reduced-motion: reduce`. Keyframe animations (spinners, skeletons)
  must stop or become static under the same query. A page may set
  `data-motion="full"` on `<html>` only when motion carries meaning that a
  static state cannot show.

## Content voice

- Plain, direct, and specific. Short sentences. Active voice.
- Buttons say what happens: "Create invoice", "Save changes", "Delete
  contact". Not "Submit" or "OK".
- Errors say what went wrong and how to fix it: "Enter an email address
  with an @ sign." Not "Invalid input."
- Empty states say why the area is empty and give one next action.
- Sentence case for all UI text, including headings and buttons.
- Numbers: use the user's locale. Dates in tables: "12 Sep 2026".
- Do not invent metrics, testimonials, or customer names in production
  content. Specimens use clearly fictional companies and label sample data.

## Components

`components.html` is the executable reference. Groups:

- **Primitives:** buttons (primary, secondary, ghost, danger, icon), links,
  inputs, textarea, select, checkbox, radio, switch, badge, keyboard key,
  avatar, divider.
- **Components:** card, table, tabs, alert, toast, menu, dialog, pagination,
  breadcrumb, stat tile, progress bar, spinner, skeleton.
- **Patterns:** filter bar with table, settings form with validation, empty
  state, sidebar navigation, page header with actions.

Buttons: 40px tall, `--radius-sm`, 16px horizontal padding, `--text-sm` at
weight 500. One primary button per view region.

## States

Every interactive component shows these states:

| State | Treatment |
| --- | --- |
| Default | Tokens as specified. |
| Hover | Surface shifts one step (`--surface-warm`) or accent darkens (`--accent-hover`). |
| Focus | `box-shadow: var(--focus-ring)` on `:focus-visible` only. |
| Active | `--accent-active`, or `--surface-warm` on neutral controls. |
| Disabled | `opacity: 0.5`, `cursor: not-allowed`, native `disabled` attribute. |
| Error | `aria-invalid="true"`, `--danger` border and message with icon. |
| Loading | `aria-busy="true"`, spinner or skeleton, label stays visible. |
| Empty | `.empty-state`: short reason, one action. |
| Selected | `--accent` 2px inset bar or check mark, plus `aria-selected`/`aria-current`. |

## Accessibility

- Target: WCAG 2.2 AA. The promotion gate computes contrast for every
  declared text/background pair in both modes.
- Text contrast ≥ 4.5:1. Control boundaries and focus rings ≥ 3:1.
- Focus ring: 2px gap in the surface color plus 2px accent ring. Visible on
  every background the system defines.
- Touch targets: 40px minimum (24px is the WCAG floor; 40px is ours).
  Compact 32px rows keep a 40px hit area with padding.
- Use native elements (`button`, `a`, `input`, `select`, `dialog`). Tables
  use `th scope`. Every form control has a visible `label`.
- Error messages are linked with `aria-describedby`. Live updates (toasts)
  use `role="status"`.

## Responsive behavior

| Width | Behavior |
| --- | --- |
| 360 (phone) | One column. 16px gutter. Tables become stacked rows or scroll inside their card with a visible edge. Sidebar becomes a top menu. |
| 768 (tablet) | Two columns where content allows. 24px gutter. Sidebar collapses. |
| 1280 (desktop) | Full layout. 32px gutter. 1200px container. |

- Breakpoints in CSS: `max-width: 1023px` (tablet and below) and
  `max-width: 599px` (phone).
- Type steps down on phones: hero `--text-4xl` → `--text-3xl`; page titles
  `--text-2xl` → `--text-xl`.
- No horizontal page scroll at 360px.

## Do and avoid

**Do**

- Use one primary action per region and make it the only accent-filled
  element there.
- Left-align text and hero content.
- Show real states: empty, loading, error, and long content.

**Avoid**

- Purple or multi-color gradients, glass panels, neon glows.
- Centered hero stacks with a floating badge above the headline.
- Emoji icons, decorative illustrations, invented metrics.
- Raw hex values in component CSS. Use tokens.
