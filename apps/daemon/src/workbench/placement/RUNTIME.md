# Placement runtime bootstrap, recovery and run lifetime (F5-Q1)

This is the internal integration boundary that later consumers use. Adoption
is open only through the F5 executor described in [ADOPTION.md](ADOPTION.md):
coordinated-open mode with an explicitly provisioned movement helper. Every
other configuration keeps adoption **closed**. This boundary is not a writer
migration. Daemon data paths follow the root
[data directory contract](../../../../../AGENTS.md#daemon-data-directory-contract);
this module never chooses or guesses a data root.

## Modes

One server-owned mode (`PlacementMode`, `runtime-status.ts`):

- `ordinary-uncoordinated` — no binding input (`not-activated`, the default
  live behavior), or a supplied input on a host positively outside the measured
  cohort (`host-outside-cohort:<fact>`). No coordinator exists. Existing
  initialization and features are unchanged, subject only to C2a transition
  fences: a global fence refuses startup (503) before the server import; scoped
  project fences close only those projects.
- `coordinated-open` — native owner held and qualified, owned migrations
  registered, prior-incarnation recovery clear.
- `coordinated-closed` — owner lost, owned migration refused, or recovery
  unresolved. Reads stay available; mutating `/api/*` requests, the internal-run
  choke point and coordinator admission refuse.

Busy owner is 409; unavailable qualification/recovery is 503; adoption into
imported roots (and all adoption without a wired executor) is 422
`unsupported-capability` (`mapPlacementFailure`, `placementAdoptionUnavailable`).
Reasons travel in `details`; legacy DTOs are not widened.

## Bootstrap (`owner-bootstrap.ts`, `owner-provenance.ts`)

Constructor input is three keys, consumed and removed from the environment
before any child can inherit them: `OD_PLACEMENT_OWNER_BINDING` (absolute
`.node`), `OD_PLACEMENT_OWNER_SHA256`, `OD_PLACEMENT_OWNER_PROVENANCE`. Any
supplied key is activation input; a partial/invalid selection is never "no
input". `tools-dev start|run|restart --placement-owner-binding --placement-owner-sha256
--placement-owner-provenance` is the only development selector (ambient shell
values are stripped); the e2e harness forwards the same flags. No scan, newest
binary, build at start or descriptor forwarding exists.

`buildPlacementOwnerWithProvenance` is the explicit outside-startup build. The
provenance record binds binary path/SHA, the pinned source digest
(`PLACEMENT_OWNER_SOURCE_SHA256`, re-checked by a sibling test), header digests,
compiler/SDK/command, Node, arch, platform, OS release and a build receipt.

`preparePlacementBootstrap` order on the measured host (darwin, arm64, Node
24.16.0, OS 25.5.0, main thread): verify provenance → idempotent mkdir of the
data-root directory itself (mode 0700) → realpath and identity check → native
ownership → root identity recheck. Every failure throws `PlacementBootstrapError`
before the server module is imported. Host facts are classified independently of
native result tags; native `unsupported` (load/digest/protocol/capability),
filesystem-unclassified, conflict and worker-thread results never fall back.

**Entrypoint qualification.** `startDaemonRuntime` (`daemon-startup.ts`) is the
only native/transition-qualified entrypoint: it runs the bootstrap, stages it
(`stagePlacementBootstrapForServerEvaluation`) and then imports `server.js`. The
server module calls `assertStagedPlacementOwnerBeforeEagerInitialization` before
its first eager filesystem effect (data-root resolution, sandbox, legacy
migration, directories): a staged coordinated owner must still be held and
qualified and the data root must still be the owned canonical root with the same
identity, otherwise evaluation throws `owner-root-changed-before-eager-initialization`
before anything is created at a replacement. Side effects inside modules that
`server.ts` imports are outside this check. A direct importer stages nothing and
is not pre-eager-mutation qualified: `startServer` defaults to `not-activated`,
runs the C2a pre-check only before opening the database, and refuses any
coordinated bootstrap acquired after the module evaluated
(`assertPlacementOwnedBeforeEagerInitialization`).

## Owned database and recovery (`runtime.ts`, `owned-migrations.ts`)

`attachPlacementRuntime(bootstrap, deps)` after the database opens: sets FULL
synchronization, registers versioned migrations (`placement-journal`,
`source-records`, `placement-runtime`, `placement-adoption`, `placement-root-seal`,
recorded in `workbench_owned_migrations`;
unversioned draft tables or unknown versions refuse), constructs one fresh
journal incarnation and one coordinator, and binds the existing
`PlacementOwnerBinding`: live native `inspect()` plus root identity, and a
synchronous `readPreviousIncarnationRecovery()` that calls the journal reader on
**every** check, mapped through the registry. The validated object-readback
snapshot (`observePriorOperations`, one-descriptor `observeNamedRegularFile`)
only supplies observations; fences are recomputed from the journal each time, so
an older snapshot never drops one. Readback is evidence, never movement or
compensation authority. `refreshRecovery()` collects fresh exact facts and reopens
admission only when the trusted predicate clears.

### C2a ordinary transition (`ordinary-transition.ts`)

Before ordinary initialization, an ordinary daemon takes the B4-1b root lock
shared (`root-seal.ts`; waits up to 30 s for a coordinated boot that is
confirming its predecessor's seal, then refuses `transition-closed:root-seal-locked`),
and `inspectOrdinaryTransition` opens the existing database strictly read-only. Missing database or tables invent no history.
Every launch without drainage, a partial schema, corrupt records or an unusable
read path is a global fence: `preparePlacementBootstrap` throws
`PlacementBootstrapError('transition-closed:<reason>')` (503), so the supported
entrypoint refuses before the server import, eager directories or any mutating
database open. A retained `placement-journal` version record with all journal tables
missing is lost history, never legacy absence, and is global as well.
Unfinished operations (and failed/interrupted ones with intent or a linked
launch) fence their physical roots; the daemon starts. The fences are physical:
each check resolves the project's CURRENT authorized location, so a later import
or rebind onto an overlapping root refuses, and an unresolvable root refuses
while fences exist. The fence runs at three boundaries:
- the mutating `/api/*` middleware (path, body `projectId`, new-project `id` and
  `baseDir` candidates, which can only refuse);
- write-mode `authorizeProjectRequest` after authorization succeeds, which covers
  query-scoped routes and verified tool grants (`authorizeProjectToolRequest`);
- the internal-run choke point.
Missing/stale live-artifact preview regeneration (including `rendered-source`)
is fenced immediately before its write; fresh caches and template reads stay
available. Other unmigrated effectful paths remain Q2. There is no mutating-open
workaround.
Captured SQLite behavior: database bytes and existing WAL content stay unchanged;
a reader can create an empty `-wal`/`-shm` and update SHM reader marks. These
reader artifacts are filesystem effects. Ordinary mode cannot clear any fence.

### Legacy and mixed-mode roots

Only a data root created by this coordinated boot, or one whose previous
coordinated daemon sealed it at a clean stop, omits the
`legacy-predecessor-unproven` gate. An empty journal cannot prove the absence of
an unrecorded ordinary predecessor's children; existing-root activation stays
closed, and the adoption executor enforces it at its own boundary. One
existing root counts as created by this boot: a root tools-dev created and
recorded that still holds nothing but that record and the adoption helper
tree (`root-freshness.ts`, ADOPTION.md "Provisioning"). A restarted root
counts as proven when its predecessor, itself on a proven root, sealed it
(`root-seal.ts`, ADOPTION.md "Undo across a restart"): the root directory and
every root-level entry are exactly as sealed after the database closed, and
the owned database confirms the seal's generation, incarnation and nonce.
Otherwise the gate list adds a typed `predecessor-seal-*` reason. A
coordinated daemon started later on a root an ordinary daemon is using is
outside the exclusion claim.

## Project registry (`project-registry.ts`)

`PlacementProjectRegistry` derives managed roots under the managed-project root
and imported roots from authorized `metadata.baseDir`, canonicalizes them, keeps
kind and physical identity separate from the coalesced gate key, deduplicates
symlink/case/identity aliases and coalesces overlaps on the outermost root. Its
`resolveProjectRoot` is the coordinator injection. `load()` is initial-only.
Overlapping, retargeted, replaced (same name, new inode) or removed roots install
a new epoch only after `closeAdmission()` drains every live permit; a stale
registration refuses rather than writing to an unverified root. A not-yet-created
managed root records its actual identity on first observation without changing
gates. `createProjectUnderAdmission` admits at the root store, persists,
registers, then performs project I/O under the project gate and returns the
fresh registration. `resolveAdoptionTarget` refuses imported roots (422). No claim
covers another data root or external/native editors.

## Run lifetime and supervisor (`run-lifetime.ts`, `supervisor.ts`)

`createInternalRunCreationService` (`services/internal-run-service.ts`) keeps
`InternalRunCreationService` unchanged and additionally returns
`AdmittedInternalRunCreation`: `admitAndPrepare` (admit before allocation),
`admitDeferred`, `startAdmitted` (frozen-scope start before the starter;
`finish()` when it settles). `assertMutationAdmissible` fences both paths. In
ordinary mode the lifetime is null and behavior is unchanged.

`PlacementRunLifetime.admit` returns `AdmittedPlacementRun`: `allocate`, `start`,
`launch`, `reserveFinal('publication'|'cleanup')`, `projectWrite`, `dataRootWrite`,
`cancel`, `finish`. A run reuses its permit and must not request a nested
overlapping admission. Lock order stays owner → short admission registration →
sorted project gates → domain locks → short SQL.

`launch` registers the coordinator child ticket, then the durable launch intent
(standalone launches omit `operationId`), before the caller spawns a process-group
leader. `observeSpawn` records the full `pid/bootId/startToken/handshakeId`
identity; `sample` retains exact owned descendants (by parent or root group);
`recordExit` needs the exact root identity gone; `observeDrain` is separate and
needs root exit, every known member settled by exact identity, **and** a
`PlacementTreeCompleteness` proof before the journal drain fact and ticket
confirmation. PID absence alone never clears; there is no no-spawn resolution.

**Named Darwin limit `darwin-owned-tree-completeness-unproven`.** The process
table is only sampled. An owned intermediate that forks, leaves its
group/session and exits between samples is unattributable; `NOTE_TRACK` is
unsupported since macOS 10.5 and no descendant-tracking EndpointSecurity client
is available. The only shipped provider therefore never certifies same-boot
drainage: such launches keep their ticket, the run unfinished and the next boot
closed (`drain-unproven`). A changed boot session proves a prior tree gone. Tests
that inject a complete provider are synthetic and are not Darwin product proof.

## Final-I/O guard and standalone project writes (`project-writes.ts`)

Every accepted coordinator write callback receives a `PlacementWriteGuard`. This covers `withProjectWrite`, `withDataRootWrite`, the drain variants, and so a run's `projectWrite`/`dataRootWrite` and its reserved final work. Helpers call `assertCurrent()` synchronously immediately before each actual mutation, because awaited work inside a callback can outlive the checks made when it was accepted. The guard rechecks:

- owner, recovery and project fences;
- for project writes, the CURRENT authorized root through the registry's synchronous `observeProjectRoot`: the same gate key, physical root and epoch, and the same fresh identity. The pin belongs to the permit, not the callback. It holds across repeated lease writes, a run's own writes and its reserved final and cleanup tickets. A managed root absent at admission pins the first identity any of those callbacks observes.

Owner or recovery loss throws the existing 503 codes. Authority drift throws `RUN_SCOPE_CHANGED`, which maps to 409. The guard ignores admission close and caller cancellation, so accepted work still completes. It is invalid once its callback settles. Any admission requested inside an accepted callback throws `COORDINATOR_BUSY`, because it would deadlock or break sorted gate order; such work must use the guard it was given.

`PlacementRuntime.projectWrites` is the standalone manual admission for project-file routes: `admit(projectId, { signal })` returns a lease with `write(work)` and an idempotent `settle()`, and `run()` composes the three steps. Admission takes only the route-authorized project id; request fields never select a mode or permit.

- **Coordinated mode:** admission first registers the project's current authorized location. An overlapping or retargeted root waits for the drained epoch replacement; registration never happens while the caller holds a permit. It then holds the coalesced gate until `settle()`. `signal` cancels only a pending admission. An already-aborted signal refuses before registration. Aborting while registration is queued skips it. Aborting during a begun replacement drain stops only the caller's wait; the drain, install and reopen still settle. A wait aborted by a drained close becomes retryable `ADMISSION_CLOSED`. A run's `allocate` callback counts as an admitted context, so fresh admission there is refused. An admitted project that stops resolving before a write's callback starts maps to `RUN_SCOPE_CHANGED` (409) with no callback.
- **Ordinary mode, or no owned database:** a fence-only adapter applies `assertMutationAdmissible` over current metadata at admission, on each write and in `assertCurrent()`. No gates are added.

The first Q2 cohort consumes it. The covered routes are manual save (`POST /api/projects/:id/files`) and multi-file upload. Upload is admitted before Multer, and its storage engine holds the lease through directory creation, every streamed chunk and removal. The history routes are covered too: the GET baseline only when it creates history, explicit create, restore, rename, and file/raw delete. Admission happens once, before `ensureProject`, and the common helpers (`projects.ts`, `project-file-versions.ts`, agency image staging) receive only the trusted guard. Placement refusals keep the shared 503/409 mapping. In coordinated mode, a project with no authorized row is a 404, and an authorized but unresolvable root is a 409. Other callers of these helpers pass no guard and remain unmigrated.

## Current behavior summary

- No input: ordinary `not-activated`, no coordinator, shipping features unchanged.
- A valid explicit binding on the measured host: trusted internal owner,
  recovery and producer admissions (run lifetime, launch supervisor, registry).
  This is not writer, process-tree or adopter coverage.
- `activation.adoption` is `executor` only in coordinated-open mode with a wired
  executor (see [ADOPTION.md](ADOPTION.md)); otherwise `closed`, with the
  `adoption-executor-unprovisioned` gate plus the named provisioning reason.
  The daemon provisions the helper only behind the B4-1 process opt-in (off
  by default), on a root created by this boot, and the Labs switch can only
  close it (ADOPTION.md "Provisioning"), so the default routes still answer 422.
- Existing synchronous and background writers remain unmigrated.
- Darwin sampled completeness refuses same-boot full-tree drainage with the named
  limit, retaining tickets and fences. Synthetic complete-tree and changed-boot
  fixtures are contract proof only.

## Status and evidence

`PlacementRuntime.status()` is internal-only and logged once at startup as
`[od] placement-runtime {...}`; no public status API, UI or compiled `od` surface
exists, because no user-facing capability is added. Tests live in the
[placement tests](../../../tests/workbench/placement/) and
`e2e/tests/tools-dev/placement-bootstrap.test.ts`.

Still pending: all controlled writers and project-writing subprocesses (Q2),
source/executor/preparer (Q3), preview/edit wire and the HTTP/UI/compiled-`od`
adopter with hero proof (Q4), Darwin tree-completeness custody, signed packaged
loading, Intel and other hosts, and predecessor qualification for an existing
root that no proven coordinated daemon sealed.
