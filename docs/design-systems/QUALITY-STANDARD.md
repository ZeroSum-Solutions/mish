# Design-system quality standard

This standard says when a design system can feed official assets. It turns
the "Minimum promotion proof" list of the agency plan into numbered criteria.

- Record schema: `design-systems/_schema/promotion.schema.ts`
- Record file: `design-systems/<id>/promotion.json`
- Gate: `node --experimental-strip-types scripts/design-system-promotion-gate.ts [id ...] [--json]`
- The gate also runs in `pnpm guard` as "design system promotion records",
  "no unpromoted design-system references" and "default design system allowed".
- Every bundled design system must have a `promotion.json`. There is no
  exemption list: the five brand-derived systems that were exempt were
  removed on 2026-09-23.

The criterion ids below (DSP-01 to DSP-21) are the same ids that
`PROMOTION_CRITERIA` uses. Change them together.

## Lifecycle

`draft → internal-review → candidate → promoted → deprecated`

| Status | What the gate requires |
| --- | --- |
| `draft` | The record is valid. Machine results are advice only. |
| `internal-review` | Same as `draft`. The owner has asked for review. |
| `candidate` | Every machine criterion passes. The recorded machine results match what the gate computes. |
| `promoted` | Candidate rules, plus every criterion is `pass` or `na` with a justification, plus at least one independent critique of this exact version with verdict `pass`. |
| `deprecated` | The record is valid and `deprecation.deprecatedAt` is set. |

Only a `promoted` system can feed an official template, component, page,
application, deck, document, media asset, or agency deliverable. Downstream
work names the exact `designSystemId` and version.

### Candidate selectability

"Feed an official [asset]" above means one specific, gate-checked thing: a
file that ships bundled with the product — anything under `design-templates/`
or `plugins/_official/examples/` — may reference (`context.designSystem.ref`)
only a `promoted` system. The gate enforces exactly this:
`scripts/design-system-promotion-gate.ts`'s `findUnpromotedDesignSystemReferences`
(wired into `pnpm guard` as "no unpromoted design-system references") scans
those two directories and fails on any reference to a system whose status is
not `promoted`.

Default design-system selections in code have their own rule; see
"Default design system" below.

It does **not** mean a `candidate` (or earlier-status) system is hidden from
generation. A candidate stays selectable in the web UI and the `od` CLI for
interactive use, on purpose: several of its criteria are human-attested
(DSP-07 touch and keyboard operation, DSP-10 localization stress, DSP-13
screen-reader semantics, DSP-14 design-tool mapping) and can only be checked
by using the system for real. Selectability is how those sign-offs get their
evidence. A system stops being selectable only when it is withdrawn from the
catalog entirely, which is a separate decision from its promotion status.

### Default design system

A default design system is the system the product uses when the user and the
project name none: for example the `od run redesign` fallback in
`apps/daemon/src/cli.ts` and the first-run pick in `apps/web/src/App.tsx`.

- Every default in code reads `DEFAULT_DESIGN_SYSTEM_ID` from
  `packages/contracts/src/design-systems/defaults.ts`. Do not write a
  design-system id as a literal fallback anywhere else.
- A default must be `promoted`.
- **Exception while nothing is promoted.** While no bundled design system is
  `promoted`, a `candidate` system may be the default. Today that is
  `neutral-product`, the only bundled design system. The exception ends
  when the first system is promoted: from then on the default must be a
  promoted system.
- The gate enforces this: `findUnallowedDefaultDesignSystems` in
  `scripts/design-system-promotion-gate.ts`, wired into `pnpm guard` as
  "default design system allowed". A `draft`, `internal-review`,
  `deprecated` or unknown default fails.

This default is not an "official asset" in the sense above. It only picks
the starting system for interactive work; the user can change it.

## How results are recorded

Each criterion in `promotion.json` has:

| Field | Meaning |
| --- | --- |
| `result` | `pass`, `fail`, `na`, or `pending`. |
| `checkedBy` | `promotion-gate` for machine criteria. A named person or agent for human criteria. |
| `date` | Date of the check (YYYY-MM-DD). |
| `evidence` | Files, relative to the design-system folder, that prove the result. Every path must exist. |
| `note` | Optional short comment. |
| `justification` | Required when `result` is `na`. Say why the criterion does not apply. |

**Machine** criteria: the gate computes the result. If the record disagrees
with the gate, a candidate or promoted system fails. Update the record by
running the gate again.

**Human** criteria: a named person or agent attests the result. The gate
checks that the fields are present and the evidence exists. It does not
judge the quality. `promotion-gate` cannot attest a human criterion.

**Critique** criterion: the gate reads the `critiques` list. A critique counts
only when `relationship` is `independent`, the reviewer is not an author or
the owner, `versionReviewed` equals the record version, and `verdict` is
`pass`. Each critique names a findings file.

## How modes are expressed

`tokens.css` declares modes in fixed blocks. The gate reads them this way:

1. Light: the first `:root { ... }` block. The shared token schema applies to
   this block.
2. Dark, explicit: `:root[data-theme="dark"] { ... }`.
3. Dark, from the OS: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }`.

Blocks 2 and 3 must be identical. Each light token whose value is a color must
appear again in the dark blocks. `data-theme="light"` on `<html>` forces
light mode. Do not write a second bare `:root { ... }` block: the repository
token guards read every bare `:root` block as the light contract.

Reduced motion uses `@media (prefers-reduced-motion: reduce)` with a rule that
sets `--motion-fast` and `--motion-base` to `0ms`.

## Criteria

### DSP-01 Reference lock, provenance, and original rationale — HUMAN

- Evidence: a provenance section in `DESIGN.md` and `source/evidence.md`. They
  name every reference, its rights status, and the reasons for each major
  decision. Brand-derived material is marked as reference only.
- Attestation: reviewer name, date, and the evidence paths.

### DSP-02 Complete semantic tokens — MACHINE

- Evidence: `tokens.css` and `source/token-contract.report.json`.
- The gate checks: the light block declares every token in the shared schema.
  Every other token is an allowed extension for this system.

### DSP-03 Light and dark modes — MACHINE

- Evidence: `tokens.css`.
- The gate checks: both dark blocks exist, they are identical, and every color
  token has a dark value.

### DSP-04 Foundation rules documented — MACHINE

- Evidence: `DESIGN.md`.
- The gate checks: `DESIGN.md` has an H2 section for each of color,
  typography, spacing, layout, iconography, imagery, motion, content voice,
  components, states, accessibility, and responsive behavior.
- The critique judges whether the rules are specific enough to follow.

### DSP-05 Primitives, components, patterns, and states — MACHINE

- Evidence: `components.html` and `components.manifest.json`.
- The gate checks: sections with ids `primitives`, `components`, and
  `patterns`; CSS for `:hover`, `:focus-visible`, disabled, `[aria-invalid="true"]`
  (error), and `[aria-busy="true"]` (loading); an element with class
  `empty-state`.

### DSP-06 Responsive layouts at 360, 768, and 1280 — MACHINE

- Evidence: the specimens and `components.html`.
- The gate checks: every page has a viewport meta tag and a width media query.
  Every page has visual fixtures at 360 and 1280.
- The 768 layout is judged in critique. Record a 768 capture when it matters.

### DSP-07 Touch and keyboard operation — HUMAN

- Evidence: a short test note. Tab through each specimen. Operate every
  control with the keyboard. Check touch targets of 24px or more (the system
  may set a larger target).
- Attestation: tester name, date, browser and device, note path.

### DSP-08 Reduced motion — MACHINE

- Evidence: `tokens.css` and `components.html`.
- The gate checks: the reduced-motion block sets both duration tokens to
  `0ms`. Every page that uses `@keyframes` also has a
  `prefers-reduced-motion: reduce` rule.

### DSP-09 Realistic content — MACHINE

- Evidence: the specimens and `components.html`.
- The gate checks: `<html lang>` is present. No placeholder text ("lorem
  ipsum", "TODO", "TBD", "placeholder text").
- Sample figures must be labeled as sample data. The critique checks this.

### DSP-10 Localization stress — HUMAN

- Evidence: captures or notes that show long strings (for example German),
  a non-Latin script, and right-to-left text where the system claims support.
- Attestation: tester name, date, locales tried, evidence paths.
- `na` is allowed only with a justification, such as "English-only product".

### DSP-11 Contrast evidence (WCAG 2.2 AA) — MACHINE

- Evidence: `tokens.css` and `promotion/gate-report.json`.
- The gate computes the contrast of every pair in `REQUIRED_CONTRAST_PAIRS`
  plus the record's `contrast.pairs`, in light and dark modes. Text needs
  4.5:1. Large text and UI boundaries need 3:1.
- Required pairs include text tiers on `--bg`, `--surface`, and
  `--surface-warm`; `--accent` on `--bg` and `--surface`; `--accent-on` on
  `--accent`, `--accent-hover`, and `--accent-active`; status colors on
  `--surface`.
- Token values must be hex or `rgb()` colors so the gate can compute them.
  A `color-mix()` token cannot be checked and fails.

### DSP-12 Focus behavior — MACHINE

- Evidence: `tokens.css` and `components.html`.
- The gate checks: the outer color of `--focus-ring` (the color in its last
  shadow layer) has 3:1 or more against `--bg` and `--surface` in both modes.
  Every specimen and `components.html` has a `:focus-visible` rule that uses
  `var(--focus-ring)`.

### DSP-13 Screen-reader semantics — HUMAN

- Evidence: a note from a screen-reader pass (VoiceOver or NVDA) over the
  app specimen and the components page: landmarks, headings, form labels,
  error announcements, and table headers.
- Attestation: tester name, date, assistive technology, note path.

### DSP-14 Design-tool to code mapping — HUMAN

- Evidence: a mapping file that lists design-tool variable and component
  names against token and component names, with versions.
- Attestation: reviewer name, date, mapping path.
- `na` is allowed only with a justification, such as "code-first system; no
  design-tool library exists".

### DSP-15 Representative specimens — MACHINE

- Evidence: `manifest.json` and the four specimen files.
- The gate checks: the record names a website, an app or CRM, a document or
  deck, and a campaign specimen. Each file exists, is declared in
  `manifest.preview.pages`, and has `<main>` and `<title>`.

### DSP-16 Visual-regression fixtures — MACHINE

- Evidence: `promotion/evidence/`.
- The gate checks: every fixture file in the record exists and is 300 KB or
  smaller. Each specimen and `components.html` has a fixture at 360 and
  1280 in light and dark mode.

### DSP-17 Package contract and implementation checks — MACHINE

- Evidence: `manifest.json` and the derived files.
- The gate checks: every path declared in the manifest exists; the package
  quality rules pass; `design-tokens.json`, `tailwind-v4.css`, and
  `components.manifest.json` match a fresh derivation.

### DSP-18 Documentation — MACHINE

- Evidence: `DESIGN.md` and `USAGE.md`.
- The gate checks: `DESIGN.md` has a `> Category:` line and at least seven H2
  sections. `USAGE.md` has the sections Read Order, Design Highlights, Do,
  and Avoid.

### DSP-19 Changelog, ownership, and deprecation policy — MACHINE

- Evidence: `promotion.json`.
- The gate checks: the changelog has an entry for the current version; the
  owner and deprecation policy are present; a deprecated record has
  `deprecatedAt`.

### DSP-20 Independent design critique — CRITIQUE

- Evidence: a findings file for each critique.
- Critique record fields: `id`, `reviewer`, `relationship`, `date`,
  `versionReviewed`, `verdict`, `scope`, `findings`.
- The reviewer judges coherence across all specimens, not one screen. The
  reviewer must not be an author or the owner.

### DSP-21 Clean-consumer verification — MACHINE

- Evidence: the four specimens.
- The gate checks each specimen: it links exactly one stylesheet, the
  package `tokens.css`; it loads no remote resource and uses no `@import`;
  its CSS has no raw color values; every `var(--*)` it uses is declared in
  `tokens.css`; it declares no custom properties of its own.

## Changing this standard

- Add or rename a criterion in `PROMOTION_CRITERIA`, in this file, and in the
  gate checks in the same change.
- A new machine check needs a test in
  `e2e/tests/scripts/design-system-promotion-gate.test.ts` that shows it can
  fail.
- Records that exist when the change lands must be updated in the same change.
