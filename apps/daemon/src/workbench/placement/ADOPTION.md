# Adoption executor (F5: prepare, apply, undo)

`adoption-executor.ts` places a prepared regular-file plan into a managed
project and can undo it exactly. It composes the native exclusive movement
driver, the placement journal and the coordinator's project admission. Daemon
data paths follow the root
[data directory contract](../../../../../AGENTS.md#daemon-data-directory-contract).

## When it exists

`attachPlacementRuntime` builds the executor only in coordinated mode with an
owned journal and an explicit `adoption: { helper, workRoot }` dependency.
The work root holds `blobs/`, `staging/` and `retention/`. It must derive from
the resolved daemon data root and sit on the same volume as managed projects.
Without the executor, every route answers the typed 422
`unsupported-capability` refusal, and the request is preserved unchanged.
The refusal's `details.gates` lists every named gate that keeps it closed.

## Provisioning (B4-1, phase A)

`adoption-provisioning.ts` decides whether `server.ts` passes that
dependency. Everything is off by default; the executor opens only when all of
these hold:

1. **Process opt-in (the owner's authority).** The daemon starts with
   `OD_PLACEMENT_ADOPTION_EXECUTOR=1` (exact value). Whoever starts the daemon
   process decides; this is the only input that can open the executor. The
   daemon removes the variable from its environment before anything can spawn,
   so agent children never inherit it. Otherwise: `adoption-opt-in-env-off`.
2. **Coordinated mode, on a root created by this boot or sealed by its
   predecessor.** In ordinary mode
   nothing is read or created and the existing `ordinary-mode` gate stands. In
   coordinated mode the executor boundary enforces the predecessor exclusion
   (RUNTIME.md "Legacy and mixed-mode roots"): unless this boot created the
   data root, or the previous coordinated daemon sealed it at a clean stop and
   the root is exactly as sealed ("Undo across a restart" below), the executor
   stays closed with `legacy-predecessor-unproven` plus a typed
   `predecessor-seal-*` reason, in the gate list and at every route. The
   tools-dev path creates the root itself to build the helper into it, so it
   records that creation (`WORKBENCH_ADOPTION_ROOT_RECORD`, bound to the
   root's device and inode). The bootstrap counts such a root as created by
   this boot only if, before taking ownership, the root holds nothing but that
   record and the helper tree (no database, projects or owner lock from an
   earlier boot) and still does right after it, with only its own new owner
   lock added. It then consumes the record (`root-freshness.ts`).
3. **Host.** Phase A uses the driver's own runtime qualification
   (`placementRuntimeQualified`: darwin, arm64 and the measured OS release),
   because the mover is `renameatx_np(RENAME_EXCL)` with `O_NOFOLLOW_ANY`.
   Every other host reports `adoption-host-unsupported:<platform>-<arch>` (a
   darwin-arm64 host on another OS release reports
   `adoption-host-unsupported:darwin-arm64-<release>`) and reads nothing. Linux
   stays behind this gate: `renameat2(RENAME_NOREPLACE)` could give the
   exclusive rename, but the driver's whole-path no-symlink opens (Node exposes
   no `openat2(RESOLVE_NO_SYMLINKS)`) and the helper's identity protocol
   (volume UUID, `statfs`, `libproc`) are Darwin-specific. A Linux mover needs
   its own design and red specs. There is no fallback mover.
4. **Verified helper.** The tool directory and the work root derive from the
   resolved daemon data root (`PLACEMENT_ADOPTION_LAYOUT`). The daemon never
   builds or searches for the helper. It reads the build-time record
   (`mishmash.placement-adoption-helper/v1`, strict closed shape) and requires
   the record's `sourceSHA256` to equal the pinned digest of the tracked
   `native.c` (`PLACEMENT_HELPER_SOURCE_SHA256`, re-checked by a sibling test).
   The binary's digest must equal the recorded one; the digest is never taken
   from the binary. Before every invocation the driver re-hashes the binary
   from a descriptor opened with `O_NOFOLLOW_ANY`, and immediately before
   spawning it re-checks that the named binary is still that object (device,
   inode, size, mtime, ctime); a swap in between is refused with no spawn
   (`helper-changed`, or `helper-changed-before-spawn` for a move, which
   records no mutation). Gates: `adoption-helper-missing`,
   `adoption-helper-record-invalid`, `adoption-helper-source-unpinned`,
   `adoption-helper-digest-mismatch`.

   **Trust root.** These are integrity and staleness checks. Their trust root
   is "anything running as the daemon user": that user can write the tool
   directory, so it can rebuild a binary and a matching record. The pinned
   source digest proves the record claims a build of the current source, not
   who built it. Real provenance (a code-signing team-ID pin, or a
   reproducible rebuild inside the daemon) is phase B.
5. **Private tool directory.** No symlink anywhere: directories are checked
   with `lstat`, files are opened with `O_NOFOLLOW_ANY` and re-checked by name.
   Every directory and file must be owned by the daemon user and not writable
   by group or others. Files must be single-link. Every ancestor from the
   filesystem root down must be owned by root or the daemon user and not
   writable by group or others unless sticky, so nobody else can swap the tool
   directory (`adoption-tool-dir-ancestor-unsafe`). The tool directory must not
   overlap the managed projects root or any imported project root, so project
   content cannot reach it. Gates: `adoption-tool-dir-unsafe`,
   `adoption-tool-dir-overlaps-project`. The overlap is checked again on every
   access against the current project roots; a project imported or
   registered later over the tool directory or work root closes the executor
   until restart (`adoption-tool-dir-inside-project`). The folder import route
   also refuses any folder that contains the data root
   (`import-contains-data-root`).
6. **Labs switch: it can only close.** Decision (2026-10-08, after review):
   the daemon has no trusted per-request owner identity on its loopback API.
   Workspace identity is a header the caller chooses. The desktop session
   secret exists only in desktop builds and gates only folder import.
   `OD_API_TOKEN` is shared by every authorized caller. So a request without
   workspace headers may be the owner, a workspace member's client or a local
   agent, and the switch cannot be an authority to open anything. Settings →
   Labs "Adoption executor" writes `placementAdoptionExecutor` in app-config:
   - absent or `true` leaves the decision to the process opt-in;
   - `false` closes the executor at once (`adoption-opt-in-labs-off`), and the
     closure latches for the life of the process: no later write from any
     caller, with or without headers, reopens it. Reopening takes the owner
     restarting the daemon with the opt-in while the switch is not off (and,
     by item 2, on a fresh root).
   Only `true`, `false` or `null` are accepted (`INVALID_APP_CONFIG_VALUE`
   otherwise). A request that declares a workspace member identity is refused
   (403 `FORBIDDEN`, reason `local-owner-required`) as defense in depth only;
   the missing headers prove nothing. An unreadable switch reads as off.
7. **Work root containment and volume.** Readiness (status, `GET …/status`,
   the Labs row) is computed without filesystem effects. It checks that the
   work root is reached from the canonical data root through real directories
   only (a symlinked `placement` or `adoption-work` is refused without being
   followed: `adoption-work-root-outside-data-root`) and runs a volume check
   against the nearest existing ancestor of the work root. After creating the
   work root the executor checks again that its real path lies strictly inside
   the canonical data root. The executor itself is built
   lazily on the first adoption request, once 1–6 hold. Its work root is
   created with mode 0700 and must share a device with the managed projects
   root. Otherwise: `adoption-work-root-cross-volume` or
   `adoption-work-root-unavailable`. A construction refusal stays for the life
   of the process.

Every closed state keeps `adoption-executor-unprovisioned` in the gate list,
next to the specific reason, in every mode (ordinary and the no-journal case
included), with `adoption-opt-in-labs-off` whenever the switch is off.
`PLACEMENT_ACTIVATION_GATES` is unchanged. The 422 refusal's details shape
(`kind`, `reason`, `gates`) is `WorkbenchAdoptionRefusalDetails` in
`packages/contracts`, as is the helper layout
(`WORKBENCH_ADOPTION_HELPER_LAYOUT`) that tools-dev copies and an e2e test
pins equal.

Surfaces: `GET /api/workbench/adoption/status`,
`od workbench adoption status --json` (DTO `WorkbenchAdoptionStatusResponse`
in `packages/contracts`), and the Labs row, which always shows the daemon's
answer and its gates, not the switch position alone.

Development build: `tools-dev start|run|restart --placement-adoption-executor`
needs an explicit `OD_DATA_DIR` (no cwd fallback). On darwin-arm64 it compiles
`native.c` into the tool directory under that data root (temporary file,
then rename; binary 0500, record 0400, directories 0700, refusing a symlinked
directory). It writes the record and passes `OD_PLACEMENT_ADOPTION_EXECUTOR=1`. When
its own `mkdir` creates the data root, it first writes the root creation
record (item 2); it never records a root that already existed.
On other hosts it builds nothing and still passes the opt-in, so the daemon
reports the host gate. Ambient `OD_PLACEMENT_ADOPTION_EXECUTOR` values are
stripped, as the placement-owner keys are. Coordinated mode still needs the
explicit `--placement-owner-*` selection.

## Steps

- **Prepare** (`POST /api/workbench/adoption/prepare`, `od workbench adoption prepare`).
  This step runs under the project's admission and does not change the
  project. It reads each write path from one descriptor and requires an
  existing, qualified parent directory. It stores every output and every
  replaced file's bytes as digest-named blobs. Then it saves a strict
  version-1 `PreparedAdoptionPlan`. A draft from the HTTP/`od` prepare step
  must be owner-declared (`implementationOrigin: owned`); any other origin
  gets 422 `source-authority-executor-preparer`. A non-owned draft is
  prepared only with a trusted catalogue admission from the catalogue
  manager (see "Catalogue apply" below), never from request JSON. The owner-declared admission and
  assessment fields are provenance declarations, not catalogue rights
  evidence. Imported roots get 422. Before it reads anything, prepare
  refuses a write under a `node_modules` or `.git` segment with 422
  `restricted-path` (the draft parser refuses it with 400 first). It also
  refuses a draft whose entry is not an existing file with 422
  `entry-must-exist`. A managed target whose physical root is not strictly
  inside the canonical managed projects root (for example a managed project
  directory that is a symlink elsewhere) gets 422 `root-outside-managed`;
  prepare, apply and undo all check it. Outputs over 32 MiB in total get 422
  `output-budget` before any read, and existing targets over 32 MiB in total
  get 422 `preimage-budget` as soon as the running sum passes the budget.
  It stores no blob until every gate has passed. The
  plan's `dependencyDigest` binds the exact observations of `package.json`,
  `package-lock.json`, `pnpm-lock.yaml` and `yarn.lock`.
- **Apply** (`POST …/apply`, `od … apply --plan --digest`). Apply takes the
  stored plan ID and digest only. It recomputes the digest and checks the
  principal, the expiry, and the root identity and volume. Then it re-reads
  every declared path under the project admission. Any difference returns
  409 `read-set-changed` with no mutation, so an external edit stays intact.
  It then re-observes the package manifest and lockfiles. If their digest
  differs from `dependencyDigest`, apply returns 409 `dependency-set-changed`
  with no mutation.
  Apply stages verified blobs as fresh files. For each write it retires the
  replaced file into retention, then publishes the staged file, in contract
  order. Each movement follows this sequence:
  1. A final-I/O check.
  2. A committed journal intent.
  3. One native exclusive move.
  4. Exact device, inode and byte verification of the destination, and a
     check that the source is absent.
  5. A committed receipt.
- **Undo** (`POST …/operations/:id/undo`, `od … undo --operation`). Undo
  needs a `done` apply. Every location must still hold exactly what the apply
  left; otherwise undo returns 409 `changed-since-apply` and changes nothing.
  The inverse manifest retires each published file into retention and
  restores each retained original, so the original inode and bytes return.
- **Readback** (`GET …/operations/:id`, `od … show`) and
  `GET …/plans/:id` (`od … plan`), which is the preview.

Operation IDs come from the plan digest (apply) or the apply ID (undo). A
repeated request replays the recorded operation in any state. A repeat never
repeats a movement. A refused or lost movement records `failed` or
`interrupted` with `recovery-required` once any intent exists. There is no
automatic retry, cleanup or compensation. After a restart, the journal's
prior-incarnation recovery fences that project root. Nothing is deleted:
retained originals, published files that undo retired, and blobs stay under
the work root. A retention policy is a later gate.

## Undo across a restart (B4-1b, AC-R04.3, AC-R04.4)

A restarted coordinated daemon reopens the executor, so readback and undo of
an apply from before the restart work, only when it can prove that nothing
touched the data root between the two runs (`root-seal.ts`):

1. **Seal at a clean stop.** `PlacementRuntime.sealAndClose` closes
   admission and checks that this incarnation may seal: its root is proven
   (created by this boot, or itself accepted a seal), it is coordinated-open
   with nothing admitted, each of its operations is `done` (or stopped before
   any movement intent), and each of its launches is drained. It then records
   the next generation in the owned table `placement_root_seals` (migration
   `placement-root-seal`, version 1: generation, sealing incarnation, SHA-256
   of a random nonce), truncates the WAL and closes the database, so SQLite
   removes its WAL and shared-memory files. It writes
   `placement/root-seal.json` (0600, temporary file then rename, synced): the
   generation, the incarnation, the nonce, the exact state of the root
   directory and of every root-level entry (kind, device, inode, mode, owner,
   link count, size, modification and change time; the `placement` directory
   by identity only), and an HMAC over all of it keyed by the nonce. Only then
   does it release the native owner. A failure after the seal file was
   published removes it again (the database generation without its file is
   inert: confirmation needs the nonce only the file carries). `server.ts`
   seals only after the HTTP server stopped and every connection ended,
   background passes stopped and the terminal-report delivery pass joined;
   every caller of the shutdown awaits that same drain and seal. Any other
   stop seals nothing. An unproven boot never seals, so it cannot launder a
   root for the next boot.
2. **Verify at the next boot, under the root lock.** The root-level
   `.placement-root.lock` is an advisory lock both modes honour (Darwin
   `O_EXLOCK`/`O_SHLOCK`). The coordinated bootstrap holds it exclusively
   from its first seal reading through confirmation. An ordinary daemon takes
   it shared before its first database touch and keeps it while it runs (it
   releases it when it stops or its startup fails); while
   a coordinated boot holds it, the ordinary daemon waits up to 30 s and then
   refuses to start (503 `transition-closed:root-seal-locked`). An ordinary
   daemon never creates the file. Under the lock, before ownership and again
   right after it, the bootstrap reads the seal without following a symlink
   (a private, single-link regular file of the closed shape), verifies the MAC
   and compares the root with the sealed state. It then confirms the seal
   against the database bytes, read through a no-follow descriptor in 1 MiB
   chunks into a bounded, sparse snapshot in a private temporary directory
   inside `placement/` (excluded from the seal, removed afterwards; SQLite is
   never opened on the root and the database is never copied whole into
   memory): the latest, unconsumed
   generation, sealed by the incarnation that is still the journal's current
   one, with the nonce's hash. A final reading compares the root once more,
   and only then is the seal accepted. A busy lock (an ordinary daemon is
   using the root) refuses. A database over 1 GiB, or a snapshot that cannot
   be made, refuses as `predecessor-seal-unverifiable` and leaves the seal in
   place (a resource limit is not evidence against it). The kept seal
   preserves the evidence, not undo across that restart: the refusing boot
   then opens the database itself, so the next boot finds the root changed
   and refuses with `predecessor-seal-root-changed`. Phase B makes the size
   cap configurable so a large database can still be confirmed. Otherwise the seal
   file is removed whatever the outcome,
   through a seal directory checked without following symlinks and pinned by
   identity, and only the file that was verified; anything unsafe leaves
   every file untouched. The runtime confirms the seal again on the opened
   database, before its own journal incarnation exists, and marks the
   generation consumed by the new incarnation. Status reports
   `dataRoot.predecessor` (`created`, `sealed` with its generation, or
   `unproven` with the reason).
3. **Refusals.** Otherwise the executor stays closed with
   `legacy-predecessor-unproven` and one typed reason
   (`WORKBENCH_ADOPTION_PREDECESSOR_GATES` in `packages/contracts`):
   `predecessor-seal-absent` (a crash or any stop that did not seal),
   `predecessor-seal-invalid` (wrong shape, permissions or MAC),
   `predecessor-seal-root-changed` (another daemon opened the database —
   even a read-only SQLite open recreates the WAL and shared-memory files —
   or holds the root lock, or anything at the root was added, removed or
   written, including inside the confirmation window),
   `predecessor-seal-unrecognized` (the database does not confirm it: a
   fabricated nonce, a replayed or already used seal, or a later boot that
   never sealed) and `predecessor-seal-unverifiable` (the bounds above).
   Nothing is moved or deleted: the user's files stay as they
   are, and retained originals stay under the work root.

Recorded project files are proven at undo time, not by the seal: undo still
requires every location of the apply (project files and retained originals)
to hold exactly what the apply left, so a hand edit to an applied file
returns 409 `changed-since-apply` after a proven restart too. A file edited
elsewhere in a project is not an undo location and does not matter to it.

Trust root: the same as the helper's (item 4 of "Provisioning"), anything
running as the daemon user. The seal detects ordinary daemons, hand edits,
crashes, and edited, fabricated or replayed seals. A process with the daemon
user's authority that reads the genuine seal before the next boot can rewrite
it consistently; that is not in scope. An ordinary daemon started after the
coordinated boot confirmed its seal runs alongside it and is outside the
exclusion claim, as before; so is any opener that honours no lock outside the
confirmation window. Ordinary daemons from builds before B4-1b do not take
the lock; one that opens the database inside the window is still caught by
the final comparison.

## Catalogue apply (AC-R04.3, AC-R04.4)

`../adoption/catalogue-adoption.ts` prepares a plan from one catalogue
reference (`POST …/catalogue/prepare`, `od workbench adoption
catalogue-prepare`). Its gates run in order and refuse before anything is
stored: an admitted material source for the reference's source (otherwise
422 `reference-only`), permitted rights (otherwise 422 `reference-only`), the
current revision (409 `resource-ref-stale` with `currentRefKey`), a licence
notice (422 `notice-missing`), the declared npm packages against the
project's `package.json` (422 `dependencies-unsatisfied` with `missing` and
`incompatible`), and a reviewed replacement: project files that differ from
the incoming bytes return 409 `replacement-review-required` with a line diff
and a digest, and only a request carrying that digest proceeds. The
generated notice is in that review too, so a user-edited notice (or an
older revision's) is never overwritten unseen. The catalogue's reads go
through `observe()`, which qualifies every parent the same way `prepare()`
does: a directory symlink anywhere below the project root refuses 422
`parent-unqualified` before a file is opened. The plan
writes the item's files and its local registry dependencies under the target
directory (default: the entry's directory, whose subdirectories must exist),
a `NOTICE.<source>-<item>.md` file, and a one-line marker in the entry.
`noticesDigest` and the plan's `terms` bind the notice. Apply, readback and
undo are the operations above. Reuse in a second project is a second
prepare with its own plan, preimages and undo. The route builds this
manager over `placement.adoption` when the caller passes no `catalogue`
dependency, so catalogue apply is available wherever the executor is wired;
`catalogue: null` disables it (422 `catalogue-unprovisioned`). The request
and report wire lives in `packages/contracts/src/api/workbench-adoption-request.ts`.

The dependency refusal lists every missing and incompatible package with
the range the item requires and what the project has; the web refusal panel
shows each one as its own row. Upstream note (2026-10-07): the live
`new-york-v4/button` item now declares `cn` and `radix-ui` and no longer
pulls the `utils` registry item. `cn` is a real npm package published by
shadcn-ui (a clsx + tailwind-merge replacement), so it is reported like any
other missing package and never dropped. The item still imports
`class-variance-authority`, which the style's base `index` item declares
rather than the item itself; the report covers only the item's own closure,
so that package is not listed (an open gap).

The only admitted external source is the selected shadcn cohort
(`../adoption/shadcn-material.ts`), resolved through the existing shadcn
importer's resolver. Its material is the item plus the full transitive
closure of its registry dependencies; a closure of more than ten items
refuses 422 `registry-closure-too-large` instead of applying with files
missing. React Bits and every other external cohort except GSAP and the
React95 kit templates have no material source and stay reference-only.

## React95 Windows95 kit (AC-R17)

`../kits/react95/` admits two template units from the exact requested
source `react95-io/React95@871d5335` (vendored once from its archive; the
`arturbien/React95` link in the upstream manifest is recorded, never used).
Each unit is flat — the template, the `React95Theme.d.ts` typing adapter,
the vendored upstream closure as `react95.<path>` files and
`react95.LICENSE` (an asset, so an edited licence is never saved for reuse) —
because the executor writes only into existing directories. Upstream bytes
stay recorded in `kit.generated.ts`; the unit's declared edits (flat-layout
import specifiers, type-only modifiers, `Buffer` from globalThis) are listed
with their reasons in the notice. React95 has its own G02 receipt
(`targets/react/react95-receipt.ts`): `react-source/v1` admits it only on the
installed React major that receipt covers (18), and the material declares
`styled-components ^5.3.11` and `@types/styled-components ^5.1.36` with the
receipt's versions as minimums. The installed styled-components (read from
`node_modules` like React) must be a major the receipt covers (5); v6 or no
resolvable install refuses 422 `dependency-major-uncovered`. No font file is ever part of a unit. Every
upstream component is listed in search on its own (never `usable`; `window`,
`menu-list` and `text-input` are `needs-repair`). The isolated preview is the
document the receipt hashed (`GET /api/workbench/kits/react95/:itemId/preview`).
The receipt also records a real-browser layer: the daemon's CDP review
worker renders both preview documents headless at 320/375/768/1440 and the
receipt fails unless there is no horizontal overflow, every pointer target
(an input inside a label measures its label) is at least 44px, Tab stops
follow document order with a visible focus, and nothing logs to the console.

## GSAP recipes and the React target adapter (AC-R08.5, G02)

`../recipes/gsap/` is the second admitted material source: four representative
recipes (section entrance, ScrollTrigger story, Flip filter, SVG feedback), each
in two target formats. The material declares its target adapter and the
catalogue manager checks it before the dependency gate:

- `html-artifact/v1`: a standalone editable unit (page, stylesheet, recipe
  script) plus only the runtime files it registers (`gsap.min.js`, and
  `ScrollTrigger.min.js` or `Flip.min.js` when used), copied byte for byte from
  the daemon's pinned `gsap` 3.15.0 package. Files are flat in the target
  directory and prefixed with the unit name, so undoing one recipe never removes
  another recipe's runtime. No CDN reference, no `gsap/all`. Fits any project.
- `react-source/v1` (`../targets/react/detect.ts`): an editable TSX unit
  (`'use client'`, `useGSAP` with a component-local scope, `contextSafe` for
  later handlers, scoped `gsap.matchMedia` for reduced motion). The nearest
  `package.json` from the target directory, bounded by the project root,
  decides. It must declare React 17+, react-dom of the same major, TypeScript
  (a `typescript` package or a `tsconfig.json` next to it) and no second UI
  runtime (vue, svelte, solid-js, preact, @angular/core). Anything else is 422
  `target-incompatible` with `adapter`, `targetReason` (`package-manifest-missing`,
  `target-not-react`, `target-ambiguous`, `react-version-unsupported`,
  `react-version-unreadable`, `react-version-unresolved`, `react-dom-missing`,
  `react-dom-mismatch`, `typescript-missing`) and the detected framework; nothing is converted, and
  no `.jsx` variant is written. Compound ranges such as `>=17 <19` or
  `17 || 18` are not read as one release line and stay refused
  (`react-version-unreadable`, fail closed). The declared range only says
  what may be installed: the majors the adapter reports and the receipt gate
  checks are the react and react-dom versions resolved from that manifest's
  directory through `node_modules` (nearest first, never above the project
  root; a symlink whose real path leaves the root is not followed). When
  either cannot be resolved the target is refused `react-version-unresolved`;
  a resolved major no receipt covers is 422 `target-receipt-pending`. The
  installed `node_modules` manifests are read, not bound into the plan
  digest (the lockfiles are). `gsap ^3.15.0` and
  `@gsap/react ^2.1.2` are declared dependencies (the installed versions and
  the declared ranges' lower bounds must reach 3.15.0 and 2.1.2, else 422
  `dependency-below-minimum`): the existing 422
  `dependencies-unsatisfied` lists them; the daemon never installs them.
  The plan's `dependencyDigest` binds, beside the root manifest and
  lockfiles, every file the gate read: the absence of each nearer
  package.json between the target directory and the gate's manifest, that
  manifest, its lockfiles and its `tsconfig.json` (the paths are kept
  server-side beside the plan). Any change there between prepare and apply
  is 409 `dependency-set-changed` with no mutation.
- G02 receipt gate: a React unit is applied only while the committed
  production receipt validates (`../targets/react/receipt.ts`; generated by
  `tests/workbench/g02-react-receipt-build.ts`, evidence copy
  `docs/plans/2026-10-02-design-workbench/evidence/implementation-start/g02-react-receipt.json`).
  The receipt pins esbuild 0.28.0, React 18.3.1, gsap 3.15.0 and @gsap/react
  2.1.2, records the production bundle and static preview hashes, and the
  SHA-256 of every recipe unit. Any unit or pin change makes it stale; apply
  then refuses 422 `target-receipt-pending` (with `receiptReason`) until the
  receipt is regenerated and committed. Only React majors a validating receipt
  covers are admitted (today React 18): a React 17 or 19 project gets the same
  422 with `receiptReason: react-major-uncovered`, its `reactMajor` and
  `coveredReactMajors`, until a receipt for that major exists. The gate is
  generic over `react-source/v1` sources: the receipt names the sources whose
  units it covers (today `gsap`), and any other source gets
  `receiptReason: receipt-source-uncovered`. The receipt also states how its
  toolchain was resolved (the daemon's `node_modules` from the workspace
  lockfile, no network install). The receipt covers the recipe units as
  shipped: a reused saved unit whose TSX was edited passes the same gate (the
  adapter is proven), but its edited source itself is not receipt-covered. A non-React project still gets
  `target-incompatible` first.

Apply writes the unit next to the entry and adds only the one-line `od:adopted`
marker comment to the entry. It does not add an import or render the unit: the
user (or the agent) wires it in by editing the entry. Inline wiring into the
entry is B9-2's inline adapter, not this catalogue path. Two consequences:

- Undo is last-in, first-out per entry. Each apply rewrites the entry with its
  marker, so undoing an earlier apply while a later one still holds the entry
  returns 409 `changed-since-apply`; undo the later apply first.
- Hand-wiring the unit into the entry (an import, a render) changes the bytes
  the apply left, so undo then returns 409 `changed-since-apply` and changes
  nothing. Remove the wiring first, or keep the unit.

**Save and reuse (W4).** `POST …/catalogue/save` (`od workbench adoption
catalogue-save --project --operation`) saves the unit files a done, not undone
apply wrote (source, style, asset), as they are now in that project, edits
included. Runtime assets must still equal the source's pinned bytes; an edited
runtime file is 409 `runtime-asset-modified` and is never saved. The record is
private to the principal and stored under the adoption work root
(`saved-units/`, daemon data). Its ID is the digest of the whole record
(principal, reference, source project, every byte), recomputed and checked on
every read together with each path and role, so swapped bytes or a relabelled
principal are refused as `saved-unit-corrupt`. Records and the per-principal
metadata index are written to a temporary and renamed into place, so readers
never see a partial file. A record's encoded size (base64 inside JSON, about
24 MiB of unit files) must fit the 32 MiB the reader accepts, or save refuses
`saved-unit-budget` before writing. Each principal keeps at most 200 saved
units (422 `saved-unit-limit`, below the 500-item listing limit); the owner
removes one with `DELETE …/catalogue/saved/:id` (`od … catalogue-saved delete
<id>`, or Remove saved unit in the canvas Apply panel), which republishes the
index without it and then deletes the record; any other ID is 404. `GET
…/catalogue/saved?refKey=` (`od … catalogue-saved --ref`) lists from the
caller's own index only, without reading record bytes or other principals'
records. `catalogue-prepare` with `savedUnitId` (`--saved-unit`) first
re-checks read access to the project the unit was saved from, then prepares the
saved bytes in another project through every gate above (rights, current
revision, target, receipt, dependencies, replacement review). Runtime assets are
written from the source's pinned bytes whatever the record holds, and the notice
is built from the bytes the plan writes and records the saved unit and the
revision it came from. Each reuse has its own plan and undo.

HTML units handle the back/forward cache: a persisted `pagehide` keeps motion
and listeners, a real `pagehide` stops motion, and a persisted `pageshow`
starts it again. Page lifecycle never removes an action listener; only the
host's `odGsapRecipes[id].revert()` does. Without the runtime files the static
unit still works (filters filter, save confirms).

The notice records the GSAP Standard "no charge" licence terms (commercial use
permitted, AI-generated code accepted by the FAQ; the code-free visual animation
builder restriction; reusable-source redistribution not granted) and lists only
the runtime files that unit ships, with their SHA-256 (none for a React unit). A missing or different `gsap` package fails closed (422/503
`gsap-runtime-missing`, `gsap-runtime-version-mismatch`; the listing reports the
source `unavailable`). `GET /api/workbench/recipes/gsap/:itemId/preview` serves
the HTML item as one self-contained document (runtime inline, no-network CSP);
`od workbench recipe preview --ref <refKey> --out <path> [--force] --json` writes
the same bytes; it creates the file exclusively unless `--force` and never writes
through a symlink. The preview policy includes `sandbox allow-scripts`. React items show no substitute preview (`react-preview-adapter-pending`).
Evidence: `tests/workbench/react-target.test.ts`, `gsap-recipes.test.ts`
(discover, inspect, preview, apply, second-project reuse, undo over HTTP and
`od`) and `gsap-recipes-runtime.test.ts` (pinned React build with esbuild, Strict
Mode, unmount cleanup, reduced motion at mount and live, SSR, the exported HTML
unit running from its local files in jsdom).

## Evidence and limits

- `tests/workbench/placement-adoption.test.ts` runs on the measured host. It
  uses the actual native owner, the helper, the owned migrations, the journal,
  the registry and the coordinator, behind the real route module and the `od`
  handler. It covers edit → reprepare → apply → exact-byte and same-inode
  undo in the applying incarnation, then a restart without a seal that keeps
  adoption closed with `legacy-predecessor-unproven` (readback refuses, bytes
  untouched), plus the external-edit 409 cases.
  The test boots the route module directly, not the full `server.ts` process.
- `tests/workbench/placement-adoption-restart.test.ts` (measured host, actual
  owner and helper in the tools-dev layout) covers undo across a restart: a
  clean stop seals, the next boot reopens the executor, and readback and
  exact-byte, same-inode undo of the pre-restart apply pass through `od` and
  HTTP; a second clean restart continues the chain and replays the undo. A
  crash (no seal, journal intact and clear), a boot that accepted a seal and
  then crashed, an ordinary daemon between the runs, a hand edit at the root,
  a fabricated seal and a replayed one each refuse undo with 422 and the typed
  reason, with the files unchanged; a hand edit to an applied file refuses the
  proven undo with 409 `changed-since-apply`. A raw SQLite opener inside the
  confirmation window refuses undo; an ordinary daemon started inside it
  cannot enter and refuses to start. `tests/workbench/placement/root-seal.test.ts`
  is the portable unit proof of the seal file, the root state and the
  database confirmation, the no-follow consumption, the post-publish cleanup
  and the root lock. Neither boots the full `server.ts` process;
  `e2e/tests/tools-dev/placement-bootstrap.test.ts` does (measured host,
  `OD_E2E_PLACEMENT_OWNER_*`): a tools-dev clean stop seals, the restart is
  `sealed`, the chain continues, an ordinary daemon in between makes the next
  boot unproven, and a SIGKILL of the whole daemon process group is a crash
  (`predecessor-seal-absent`).
- `tests/workbench/placement-adoption-units.test.ts` is portable and uses a
  test-double mover. It covers the blob store, the source gate, a lost result
  that stops in recovery-required and replays without moving again, the
  principal and digest binding, and the 422 refusal through HTTP and `od`.
  It also covers the dependency-set 409, the `entry-must-exist` 422 and the
  `restricted-path` 422, the `root-outside-managed` 422 for a symlinked
  managed directory (executor and registry) and the `preimage-budget` and
  `output-budget` 422s, each with no stored plan, blob or movement.
- `tests/workbench/catalogue-adoption.test.ts` (portable mover) covers the
  catalogue gates, on-disk bytes after apply and undo, the stale-source diff,
  and inspect → prepare → apply → readback → second-project reuse → undo
  through the route module and `od`.
- `tests/workbench/placement-adoption-provisioning.test.ts` is portable. It
  covers the opt-in input, the source pin, every provisioning gate (including
  symlinks, shared permissions and project overlap), the work-root volume
  check, and the wiring from provisioning through the Labs switch to the routes
  and `od` with the test-double mover. `…-native.test.ts` runs on the measured
  host: a helper built from `native.c` into the data-root tool directory with
  its record, the actual owner and the coordinated runtime. It covers prepare →
  apply → undo through `od` and HTTP, and a tampered binary that stays closed.
- `e2e/ui/workbench-catalogue-apply-chain.test.ts` is the browser witness for
  inspect → enlarge → apply → save readback → second-project reuse → undo
  with the real web app and daemon. It needs registry egress and, in phase A,
  a darwin-arm64 run with the run-level opt-in: `OD_E2E_PLACEMENT_OWNER_*`
  and `OD_E2E_PLACEMENT_ADOPTION_EXECUTOR=1`. The Playwright suite then passes
  `--placement-owner-*` and `--placement-adoption-executor` to tools-dev, and
  the spec turns the Labs switch on. It skips only for
  `adoption-opt-in-env-off` or a host outside phase A; any other closed gate
  fails. Nothing about the live item is hardcoded: projects start with an
  empty manifest, Apply shows the dependency refusal with every declared
  package, the manifest is seeded from the daemon's report, and the written
  files come from the daemon's prepared plan. It also needs the selected shadcn source in the daemon's resource
  sources (`createSelectedShadcnResourceSource`, wired in `server.ts`). Until
  it runs green, AC-R04.4's UI chain is unproven; the component test mocks the
  provider boundary.
- Open gate, AC-R04.4 isolated preview: shadcn items publish
  `previewCapability` `none`, so inspect → enlarge shows the
  preview-unavailable panel. The browser chain asserts that state explicitly
  at the enlarge step; it is not preview coverage, and the R04.4
  isolated-preview clause stays open until a preview adapter exists.
- Readiness stays `unverified` until a per-item acceptance receipt exists.
  Apply is still offered; the web states it as "Unverified, apply allowed ·
  acceptance receipt pending" next to the button and in the detail list.
- Still open: helper signing and packaged provisioning (phase A is a
  development build only), Linux and Intel movers, the
  compiled `od` + tools-dev process journey (including a sealed `tools-dev
  restart`), a seal that resists a forger with the daemon user's authority,
  source acquisition and rights for
  non-owned sources, build, style and action verification from the final
  location, dependency-tree writes, a retention policy, and every other gate
  in `PLACEMENT_ACTIVATION_GATES`.
