# DSP-14 — design-tool mapping

- Checker: GPT-6 Sol (delegated by Devin)
- Date: 2026-09-23
- Verdict: **na**
- Method: Inventoried all files in `design-systems/neutral-product`, checked `manifest.json` and `source/evidence.md`, and searched the package for Figma, Sketch, Penpot, and mapping files.
- Environment: Repository worktree on macOS; source inspection only.

## Findings

- `manifest.json:1-30` identifies an original, bundled code package and lists code artifacts, not a design-tool library. `source/evidence.md:5-7` says it was not imported or sampled from a design file. The package inventory contains no design-tool library or variable/component mapping.

## Justification

This is a code-first system with no design-tool library to map. The standard explicitly permits `na` for that case (`docs/design-systems/QUALITY-STANDARD.md:205-211`).
