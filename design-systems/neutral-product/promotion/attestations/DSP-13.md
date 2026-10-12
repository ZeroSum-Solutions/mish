# DSP-13 — screen-reader semantics

- Checker: GPT-6 Sol (delegated by Devin)
- Date: 2026-09-23
- Verdict: **fail**
- Method: Audited Chromium `ariaSnapshot()` and the DOM of the app specimen and component fixture. Checked landmarks, heading levels, accessible form names, invalid-field descriptions, live regions, table headers, tabs, and menu roles. This is an **accessibility-tree audit, not a live VoiceOver or NVDA pass**.
- Environment: macOS arm64, Node 24.16.0, headless Chromium 148.0.7778.96. No screen reader was run.

## Findings

- The app has an `aside` named `Workspace navigation`, named `Work`, `Admin`, and `Pagination` navs, one `main`, and a 1 → 2 → 3 heading hierarchy (`preview/specimen-app.html:328-411`). All 16 inspected app inputs and selects had accessible names. The invalid billing email uses `aria-invalid` and `aria-describedby="a-email-err"` (`preview/specimen-app.html:398`). Its table headers use `th scope="col"` (`preview/specimen-app.html:377`). Chromium's tree exposes these labels and column headers.
- The component fixture has header, main, footer, named navs, a 1 → 2 → 3 heading hierarchy, and names for all 14 inspected form controls. Both invalid inputs link to error text with `aria-describedby` (`components.html:528`, `components.html:694`). Status and alert examples expose `role="status"` and `role="alert"` (`components.html:592-603`). Its table uses scoped column headers (`components.html:675-676`).
- The app tabs (`preview/specimen-app.html:360-364`) and component tabs (`components.html:601`) expose `role="tab"` and `aria-selected` in the tree, but have no `aria-controls`, associated `tabpanel`, or roving `tabindex`. Enter and ArrowRight did not change selection. The component menu exposes `role="menu"` and `menuitem` (`components.html:618-623`), but ArrowDown did not move focus. The exposed roles promise interaction patterns the fixtures do not provide.
- The app specimen has no live region for a newly introduced form error; its shown error is static and described on focus. I did not test dynamic announcement. The standard specifically asks for a VoiceOver or NVDA pass (`docs/design-systems/QUALITY-STANDARD.md:198-203`), which this environment did not provide.

## Why

The accessibility tree reveals incomplete tab and menu semantics. The required live screen-reader pass also remains unperformed.
