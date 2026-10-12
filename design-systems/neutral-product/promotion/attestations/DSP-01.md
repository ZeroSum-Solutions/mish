# DSP-01 — provenance

- Checker: GPT-6 Sol (delegated by Devin)
- Date: 2026-09-23
- Verdict: **fail**
- Method: Read the source record, design rules, manifest, and specimen markup. Inventoried package files and searched for remote assets, external URLs, copied kits, and design files.
- Environment: Repository worktree on macOS; source inspection only.

## Findings

- `DESIGN.md:11-26` explains the neutral surfaces, one accent, and system font choices. `source/evidence.md:18-24` says icons are drawn for this package and there are no images or vendored fonts. The inspected package contains HTML, SVG markup, CSS, token data, and review images. I found no copied brand assets or remote font or image loads. This is a source inspection, not proof of independent authorship.
- `source/evidence.md:11-16` names two references: the Wave 0 plan and the quality standard. It does not state the rights status for either reference. It says no external visual reference was used, which is clear, but does not satisfy the standard's explicit rights-status field for every named reference (`docs/design-systems/QUALITY-STANDARD.md:107-112`).
- `DESIGN.md:86-105` sets an 8px layout grid and spacing exceptions. It gives the rule but no reason for this major foundation choice. The provenance section gives reasons for color and fonts only.

## Why

The reference lock lacks explicit rights status for its named internal references and does not give reasons for every major foundation decision. The absence of copied brand material does not close those gaps.
