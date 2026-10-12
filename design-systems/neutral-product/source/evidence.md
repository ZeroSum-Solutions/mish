# Neutral Product Source Evidence

## Source Scope

Neutral Product is an original system authored for the Mishh Mashh agency
design-system core (Wave 0). It was not imported, crawled, or sampled from any
brand site, UI kit, or design file.

## Reference lock

- Plan: `docs/plans/2026-09-22-design-system-wave-0.md` (archetype 1, Neutral
  Product).
- Standard: `docs/design-systems/QUALITY-STANDARD.md`.
- No external visual references were used. Color values come from WCAG
  contrast targets (see `promotion/gate-report.json`), not from a reference
  product.

## Fonts and assets

- Fonts: platform system stacks only (`system-ui` and OS fallbacks,
  `ui-monospace`). No font files are vendored or loaded remotely.
- Icons: inline SVG line icons drawn for this package (1.5px stroke,
  24px grid). No icon library is copied.
- Images: none. Product previews in specimens are built from HTML and tokens.

## Token contract

`source/token-contract.report.json` maps every TOKEN_SCHEMA binding to its line
in `tokens.css`. `design-tokens.json`, `tailwind-v4.css`, and
`components.manifest.json` are derived from `tokens.css` and
`components.html` with the renderers in `packages/contracts/src/design-systems/`.
Regenerate them; do not edit them by hand.

## Sample content

Specimen companies (Plainfield, Harbour Studio, Aurora Dental Group, and the
other client names), people, prices, and figures are fictional. Email
addresses use the reserved `.example` domain.
