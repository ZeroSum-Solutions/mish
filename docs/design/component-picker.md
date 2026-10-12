# Kit-aware component picker

The workbench resource picker defaults to components whose recorded fit matches the active project kit. **Show all components** adds inspection results while preserving the same Apply gates. Missing kit, target or token evidence produces **Fit unknown**. A verified kit with no matching entries produces an empty fits view; Show all remains available. Plain resource search retains its existing discovery behavior.

Ranking uses explicit saved conversion priorities, spine and observed colour, radius and type adaptability. The existing contextual selector handles saved project constraints. Results include typed reasons; ties and list mode use the existing title comparator and resource identity. Ranking makes no model call. Colour and sizing suggestions retain their existing first-group placements.

## Contract

POST `/api/workbench/components/rank` and POST `/api/workbench/components/list` accept the existing resource-search request with optional `componentPicker: {kitId, kitSourceId, showAll, mode}`. The route selects its own mode. POST `/api/workbench/resources/search` opts into the picker only when `componentPicker` is supplied. Responses include revision-bound `componentFit` and `componentRanking` records with the selected kit's source and ID. Resource inspect returns fit facts for the active project kit. A saved kit revision that is unavailable is not replaced with a newer revision. Explicit CLI selections use the current catalog revision.

The CLI forms are `od components rank --kit <id> --json` and `od components list --kit <id> --json`. Use `--kit-source <source>` to select another source; legacy selections default to `design-systems`. Both commands accept the existing project, context, query-file and pagination options. Missing required arguments return exit code 2 before discovery. Saved design-system references can include `sourceId`; the legacy context resolver validates only `design-systems` and rejects another source instead of substituting a same-ID kit.

D17 limits the component Apply gate to target/adapter compatibility and admission. Acceptance evidence appears as an informational badge: passed, failed, pending or outdated. Prepare and Apply use the required production hook, observe the actual insertion directory's nearest manifest, and resolve installed packages only within the project root. The existing catalogue preparer still checks rights, notices, dependencies and file replacement. GSAP's standalone HTML adapter supports every project framework. shadcn retains its existing `catalogue-files` adapter; G02 receipts govern the `react-source/v1` adapters. Show all and contextual scoring settings cannot clear Apply blockers.

## V05 integration

An unapproved kit can rank and appear as a fit. Apply into a selected kit requires a fresh approval for its exact source, ID and revision under the current request authority. An unavailable selected kit blocks Apply. A project without a selected kit uses the component's target/admission gate.

The server wires `ComponentKitApprovalResolver` to V05's fresh scoped selectability service, which reads the full-content approval revision. Draft, missing, unapproved and revoked kits block Apply. Vetted built-in and approved Team kits pass this admission check. The resolver verifies workspace membership and the selected discovery source, ID and digest, then rechecks V05 approval after reading discovery bytes. A stale selection or changed approval fails closed. An unapproved Team copy does not fall back to an approved Personal copy with the same ID.

## Evidence and observation

This change does not admit catalog content. Admitted shadcn and GSAP material can reach their existing Prepare/Apply paths with pending acceptance evidence. Runtime-authored TSX/JS styles remain unknown to the CSS observer; external styles and unresolved kit token bindings also remain unknown. Show all keeps these entries inspectable.

Target observation uses asynchronous filesystem access. The picker shares a bounded, one-second cache with in-flight read deduplication. Prepare and Apply observe the target afresh. Pagination binds fit and approval changes, and each result's accessible name includes fit status and acceptance information.

## Implementation

The HTTP schemas live in [components.ts](../../packages/contracts/src/api/components.ts). [component-ranking.ts](../../apps/daemon/src/workbench/component-ranking.ts) owns deterministic fit and Apply gates; [resources.ts](../../apps/daemon/src/workbench/resources.ts) integrates them into discovery and inspect. [component-gate.ts](../../apps/daemon/src/workbench/component-gate.ts) supplies the production hook to [workbench-adoption.ts](../../apps/daemon/src/routes/workbench-adoption.ts). [component-kit-approval.ts](../../apps/daemon/src/workbench/component-kit-approval.ts) binds V05 approval to the request's selected kit. [component-target.ts](../../apps/daemon/src/workbench/component-target.ts) owns target observation and caching. [components-cli.ts](../../apps/daemon/src/components-cli.ts) shares the workbench transport. The web extends [WorkbenchResourceSearch.tsx](../../apps/web/src/components/workbench/WorkbenchResourceSearch.tsx) and its existing detail and Apply views, with English and Spanish labels.

The accepted scope remains [AC-R05 and AC-R18 in the PRD](../plans/2026-10-02-design-workbench/prd.md). D17 defines this component gate; these tests do not close the full PRD acceptance criteria.
