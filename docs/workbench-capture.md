# Workbench capture and screenshot drafts

Last reviewed: 2026-10-09.

This guide covers R14 capture, draft, unit-save and standalone insertion contracts. The
[accepted criteria](plans/2026-10-02-design-workbench/prd.md#ac-r14) remain the
acceptance authority. Native capture validation and explicit conversion remain separate acceptance gates.

## Workflow

1. Choose a project and open its capture hub. Desktop browser canvas can save
   page or region pixels. Web canvas accepts PNG, JPEG or WebP upload and paste,
   and offers permission-granted screen sharing when the browser supports it.
   HEIC/HEIF is not supported yet; export those screenshots as PNG or JPEG
   before uploading. The upload panel gives this recovery message in English.
   The browser cannot read pixels from an arbitrary cross-origin frame; use an
   uploaded screenshot or the browser's screen-sharing picker.
2. Save the capture before generating. The daemon strips embedded metadata,
   including EXIF/GPS, then records immutable image bytes, their hash,
   capture time, mode, source URL when supplied, frame size,
   crop and viewport metadata. Upload/paste may have no known viewport or URL.
   Saved captures remain available after reload or restart while their stored
   bytes remain available.
3. Open a saved capture, describe the draft and specify its required actions.
   The comparison dialog shows the original beside the selected ready output.
   Its static preview disables generated actions; editable source retains them.
   It shows assumptions for missing content, substituted assets and visual
   details. Pixels do not specify hidden behavior; name required menus, links,
   forms and other actions in the prompt.
4. Iterate on the latest ready revision. Each accepted request creates another
   persisted revision; earlier ready and failed revisions remain viewable in
   the Drafts tab and revision selector. A pending revision must finish before
   another iteration in the same draft. Selecting an older revision does not
   make it the next iteration's parent.
5. From a ready revision, choose **Save output region**, enter a root CSS
   selector, review the plan, declare rights and save a component, block,
   section or page. The saved source identifies the exact draft and revision.

## Insert a saved unit into a second project

In the saved-unit list, choose **Insert into project…**, select another
project and choose **Add editable artifact**. AC-R14.4 standalone insertion
copies the unit's HTML/CSS/JS and permitted assets into a new project directory.
All eight current project kinds accept these separate files. Managed and
imported-folder projects use their existing project root and write authority.
The primary artifact stays unchanged. The copied lineage record retains
unit/revision identity, opaque source-project linkage, source hashes, rights
status, notices, dependencies and actions. Full lineage, principal identity and
rights evidence text stay in the principal-owned daemon receipt.
Static project-root resource URLs to carried files become relative URLs in the
copies. Receipt hashes identify the materialized files; the unit keeps the
original bytes and hashes. Arbitrary runtime URL construction stays as authored
and needs action verification in the destination preview.

**Open editable artifact** opens the actual entry file in the project's file
viewer in a new tab. Use its preview to run declared actions and the existing
Edit controls or project file API to change the copied files. Placement reports `inserted` only after all
files have been written. The receipt reports `actionVerification: not-run`;
opening and testing the action supplies separate evidence. Dependencies remain
declared and are never installed by insertion.

**Undo insertion** hashes every receipt-listed copied file before removal.
If any file was edited, it returns HTTP 409 `insert-conflict` with those paths
and removes nothing. The UI lists the edited files and asks for confirmation.
CLI callers opt in with `--discard-edits`; HTTP callers use `{discardEdits: true}`.
Confirmed undo first saves the edited bytes under `.od-undo/<insertId>/` in
the destination project and reports that directory as `recoveryPath` in the
receipt. Recovery receipts remain visible after reopening the unit panel.
The directory groups all attempts so prior recovery copies remain discoverable.
If backup fails, undo removes nothing. Each retry keeps prior backups.
Undo removes empty directories created for copied files and retains
unrelated files added later. Symlinked or replaced project roots are refused.
The source project and saved unit remain unchanged. The persisted receipt
restores UI undo when the popover reopens and supports CLI undo after daemon
restart. `od workbench unit insertions <unitId>` lists authorized receipts.
An interrupted insertion remains
`inserting` and can be undone by its receipt ID; it cannot report `inserted`.
If a crash leaves an unproven filesystem effect, undo returns `insert-conflict`
and preserves that path for recovery rather than reporting a completed undo.

Reuse requires permitted per-file rights and an allowed `reuse-private-project`
grant for the caller and destination. Unknown or reference-only files return
HTTP 403 with typed reason `rights-blocked` before any target write. Captured
proprietary assets cannot be silently added. Notices stay with the copied
lineage. Grants requiring visible attribution or other unsupported obligations
return `rights-blocked` until an appropriate adapter can satisfy them.
Insertion grants private reuse; public publication requires separate rights.

Inline primary-content embedding remains tracked as **B-029 inline adapter
gap**. An `inline-primary-content` request returns HTTP 422 with
`unsupported-target-format`. AC-R14.5 format conversion remains unimplemented.

## CLI and HTTP

The web UI and `od` share daemon endpoints and contract parsers. All CLI
capture/draft/plan/save/list/show commands below require `--json`. Insertion
and undo accept it optionally and return the same structured receipt. File-input
options accept `-` for stdin.

| Operation | CLI |
| --- | --- |
| Import screenshot | `od workbench capture import --file <image> --metadata-file <metadata> --json` |
| Resume capture | `od workbench capture list --project <id> --json`; `od workbench capture show --project <id> --id <captureId> --json` |
| Create or iterate draft | `od workbench draft-from-capture create --input-file <request> [--prompt-file <path|->] --json [--wait]` |
| List all draft revisions | `od workbench draft-from-capture list --project <id> --json` |
| Read exact revision | `od workbench draft-from-capture show --project <id> --id <draftId> --revision <number> --json` |
| Insert standalone unit | `od workbench unit insert <unitId> --project <id> [--json]` |
| List insertion receipts | `od workbench unit insertions <unitId> [--json]` |
| Undo insertion | `od workbench unit undo-insert <insertId> [--discard-edits] [--json]` |
| Review and save unit | `od workbench unit plan --input-file <request> --json`; `od workbench unit save --input-file <request> --json` |

`od workbench capture take` reports unsupported capability: native capture
requires the desktop browser canvas. Create/import/save/insert accept an optional
`--idempotency-key`. Workspace calls pass `--workspace` and
`--workspace-member` together. `--daemon-url` selects the daemon transport.
Capture, draft and unit CLI requests attach an automatic `OD_TOOL_TOKEN` only
when the destination HTTP(S) origin matches `OD_TOOL_TOKEN_ISSUER_ORIGIN`.
A missing or mismatched issuer sends no token. These requests fail on HTTP
redirects. Choosing a daemon URL grants no additional authorization.

A draft request contains `projectId`, `captureId` and `prompt`. Iteration also
supplies `parent: { draftId, revision }` for the latest ready revision of that
capture. The daemon rejects a stale, pending or wrong-capture parent.
`--prompt-file` reads plain-text instructions and overrides `prompt` in the
JSON request; the request may omit `prompt` when that option is present.
Only one of `--input-file` and `--prompt-file` may consume stdin. Each input
is bounded to 128 KiB; the merged request still obeys the shared prompt limits.
`--wait` polls the accepted revision for at most two minutes; a timeout leaves
the persisted request available through `show`. Draft CLI exit codes are
0 for acceptance/ready, 2 for invalid input, 3 for a daemon refusal, failed
waited draft or wait timeout, and 1 for transport/server failure. Without
`--wait`, read the returned `status` and follow the revision to completion.

| Endpoint | Contract |
| --- | --- |
| `POST /api/workbench/captures` | Raw image body; base64url JSON metadata in `x-od-capture-metadata`; idempotency key |
| `GET /api/workbench/captures` | Project-scoped saved captures |
| `GET /api/workbench/captures/:captureId` | Capture metadata and byte availability |
| `POST /api/workbench/capture-drafts` | Draft request; idempotency key; 202 for new pending revision, 200 for replay |
| `GET /api/workbench/capture-drafts` | All listed revisions for the authorized project and principal |
| `GET /api/workbench/capture-drafts/:draftId/revisions/:revision` | Exact project-scoped revision |
| `POST /api/workbench/units/plan` | Files, root, exclusions, dependencies, rights and blockers |
| `POST /api/workbench/units` | Immutable unit manifest; idempotency key |
| `POST /api/workbench/units/:unitId/insert` | `{projectId, mode?: 'standalone-artifact' \| 'inline-primary-content'}`; idempotency key; 201 new receipt or 200 replay |
| `GET /api/workbench/units/:unitId/inserts` | Principal-owned receipts filtered by authorized destination reads |
| `GET /api/workbench/unit-inserts/:insertId` | Principal-owned receipt; authorized destination read |
| `POST /api/workbench/unit-inserts/:insertId/undo` | `{discardEdits?: boolean}`; authorized destination write; 409 for edited files, or 200 receipt with `status: undone` and optional `recoveryPath` |

Capture/draft reads carry `projectId` in the query or `x-od-project-id` header;
every supplied project scope must match. The daemon authorizes project reads
and writes and isolates draft/unit ownership by local daemon user or workspace
member. A draft-source unit request must also pass its authorized project
scope. An ID or parsed DTO alone grants no access.

## Draft generation and recovery

The dedicated generator uses the existing Claude Code Max subscription
subprocess boundary. It records the model and billing lane on each revision.
The dialog shows a localized notice before submission: generation sends the
screenshot pixels and instructions to Claude Max. Redact sensitive pixels
before saving/uploading a capture and remove credentials from the instructions.
The app does not run OCR or automatically redact pixels.
The capture panel and submission notice disclose EXIF/GPS removal. PNG, JPEG
and WebP imports discard embedded metadata before saving; draft generation
also strips at the service and model-staging boundaries so older captures
cannot send that metadata to a model. Animated WebP frame subchunks receive
the same metadata removal. Compressed pixels remain unchanged; metadata-based
orientation and color-profile overrides are removed. Invalid
containers fail with recovery text before image storage or model staging.

Before persistence or generator invocation, the daemon rejects recognized
credential patterns in a draft prompt with HTTP 422 and
`draft-prompt-secret`. This rejection creates no draft revision. The pattern
check does not establish that the screenshot or prompt contains no private
data.

The generator limits tools to `Read` in an isolated scratch turn and requires
an observed read of the staged screenshot before accepting structured output.
It removes the scratch turn afterward. Tests inject the runner; they do not
call a live provider.

The shared capture-draft prompt lives in
`packages/contracts/src/prompts/capture-draft.ts`. This separate turn leaves
the legacy, OD Next and API/BYOK general prompt composers unchanged. It treats
the screenshot, current HTML and prompt payload as untrusted reference data.

An active job is registered before its request becomes visible to polling.
An accepted request persists before generation starts. Its pending request and
terminal result are separate write-once records. Ready output includes a
source hash; failed output includes a reason and recovery action. Generation
after an app restart can still complete if the daemon stays running. After a
daemon interruption, reading an orphaned pending request records
`draft-interrupted`; it does not silently rerun a provider call.
Each principal can have at most three active drafts. Another principal's work
does not consume that allowance; completion or failed registration frees it.

Output must be a self-contained editable HTML document with inline CSS and
JavaScript. The validator rejects local imports, remote dependencies, encoded
data URLs, embedded frames and network-loading constructs.
`sendBeacon`, window-opening calls through `window`, `top`, `self`, `parent`
or `globalThis`, and `location.href`/`assign`/`replace` navigation are refused
in exported source too, including bracket access and direct `location`
assignment. Protocol-relative `//host` URLs, CSS `@import` and external CSS
`url(...)` loads are refused, including CSS escapes. `javascript:` URLs are
refused. The URL
scheme check uses a word boundary, so ordinary text such as `metadata:` is
allowed. Authored inline
SVG may use its namespace declaration; encoded SVG images are refused because
they can hide raster bytes. Original CSS/SVG shapes and visible placeholders
replace captured assets. The comparison preview sanitizes active/navigation
markup, disables scripts and uses an opaque-origin sandbox with a restrictive
content policy. It shows the layout; generated actions remain in the saved
editable source for later verification. These checks do not prove visual
fidelity or an unseen interaction.

Unavailable subscription tooling, generation failure, timeout and invalid
output leave failed revisions with recovery text. Retry from the saved capture
or iterate on its latest ready revision; prior revisions remain intact.

## Saving a ready region

A draft source is `{ kind: 'draft', draftId, revision, rootSelector }`. The
daemon resolves that immutable ready output directly, so later project-file
edits cannot change the selected source. A region selector must identify one
content root; `body` or `html` selects the full document. A narrower region
must contain every script in the draft. Scripts outside that root, including
head/global scripts, cause `region-script-dependency`. Save the full body or
iterate to make the chosen region self-contained before saving.

The existing unit plan/save service records editable files and assets,
declared dependencies, excluded files, rights, capabilities and source hashes.
Lineage includes the originating project, capture and exact draft revision.
Saving never installs packages or modifies the source project. The thumbnail
renderer attempts an isolated render of the stored output; its manifest
explicitly records a rendered PNG, capture fallback or unavailable result.
A fallback capture is not evidence that the generated output rendered.

The user must declare rights for every included file. Model-authored output
requires an explicit private-use attestation; the daemon otherwise leaves its
rights unknown and blocks saving. That attestation grants no redistribution
rights. Captured bytes remain excluded unless an explicit path-scoped
user-owned/licensed declaration permits them. Linking a capture as provenance
does not import its image into editable source.
Unit planning checks both original file hashes and metadata-stripped raster
hashes, so keeping EXIF on a project asset cannot hide its captured origin.
Requests carrying an
Authorization credential cannot record rights declarations; the user records
them through the web app or an owner-run `od` command.

## Remaining R14 work

- **AC-R14.4:** use a documented user-owned/licensed release fixture; validate
  native capture and browser upload; insert the unit into a second project,
  edit and run its action, then undo while preserving the first project.
  The standalone implementation is available; native capture and browser upload
  release proofs remain separate. Inline adapter gaps remain in the
  [target-format matrix](plans/2026-10-02-design-workbench/technical-spec.md#rights-use-and-target-formats). A saved reference alone does not prove insertion.
- **AC-R14.5:** explicit conversion must create an immutable revision, retain
  original lineage and declare lost/unsupported behavior. Prove action and
  undo for each target adapter. Failed conversion must preserve the original
  and offer retry/revise. Unsupported formats cannot report converted/applied.

## Verification scope

Scoped contract, generator, service, HTTP, CLI and web component tests exercise
fixtures and injected runners. Their receipts must name the tested source
revision. They do not establish live subscription generation, native desktop
capture, browser permission behavior, rendered fidelity or conversion criteria.
Second-project action/undo browser proofs must be recorded separately from
service or DOM fixtures before declaring R14 complete.

Daemon-owned capture, draft, unit and scratch storage derives from the resolved
`RUNTIME_DATA_DIR`. The root
[Daemon data directory contract](../AGENTS.md#daemon-data-directory-contract)
owns storage-path rules.
