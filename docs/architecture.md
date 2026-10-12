# Architecture

**Parent:** [`spec.md`](spec.md) · **Siblings:** [`skills-protocol.md`](skills-protocol.md) · [`agent-adapters.md`](agent-adapters.md) · [`modes.md`](modes.md)

This document describes the code-backed runtime topology and the boundaries
between the web app, daemon, desktop/packaged shells, agent runtimes, and
content registries. For repository ownership rules, the root and layer
`AGENTS.md` files remain authoritative. For embedding Mishh Mashh behind
another control plane, see [`orchestrator-workspaces.md`](orchestrator-workspaces.md).

> Historical note: the first architecture draft sketched a Vercel tunnel
> mode, a browser-only direct-API mode, WebSocket `session.generate` messages,
> an in-memory session bus, `history.jsonl`, and a three-root watched skill
> registry. Those sketches were overtaken by the implemented HTTP/SSE,
> SQLite-backed daemon, request-time registries, packaged sidecars, and BYOK
> proxy. They are not current deployment modes or compatibility promises.

## 1. Runtime shapes

### Source development

`pnpm tools-dev` is the only repository lifecycle entry point. It manages the
daemon and web sidecars and, for the default target set, the Electron desktop
shell. `pnpm tools-dev run web` keeps daemon and web in the foreground without
starting desktop.

When ports are not supplied, `tools-dev` chooses available daemon and web
ports. `--daemon-port` and `--web-port` make them explicit. The web sidecar
receives the selected daemon port and rewrites `/api/*`, `/artifacts/*`, and
`/frames/*` to the sibling Express process. Ports are transport details; they
do not define process identity, namespaces, or daemon data roots.

### Packaged desktop and packaged headless

`apps/packaged` starts the packaged daemon and web sidecars. The Electron entry
also starts the desktop shell; the headless entry omits desktop. Packaged code
resolves channel/namespace-scoped runtime and data identities before spawning
the daemon, and the desktop discovers the web URL through sidecar IPC rather
than assuming a port.

Read `tools/pack/AGENTS.md` before changing packaged launch, update, installer,
or channel identity behavior.

### Container and daemon-served production

The production daemon can serve the static Next.js export from `apps/web/out`
and the `/api/*` surface from one origin. The repository Docker Compose file
uses that shape as one service. Its published host port is configurable; the
container's documented default remains `7456`.

Public or shared deployments must configure API authentication, allowed
origins, and reverse-proxy SSE behavior. See [`deployment/docker.md`](deployment/docker.md)
and [`../deploy/README.md`](../deploy/README.md).

## 2. Component topology

```text
browser or Electron renderer
          │
          │ same-origin HTTP + SSE
          ▼
Next.js web app ────────────────┐
          │                     │ static UI / preview state
          │ /api/* rewrites     │
          ▼                     │
Express daemon ◄────────────────┘
   │       │        │
   │       │        ├─ SQLite state and daemon-owned project files
   │       ├─ skills / design templates / design systems / plugins
   └─ runtime registry → spawned CLI or ACP process
                            │
                            └─ structured events, file writes, or text output
```

The web UI and the `od` CLI call the same daemon HTTP APIs. The CLI is not a
second business-logic implementation; it is the machine-readable surface for
the same capabilities.

## 3. Main components

### 3.1 Web app (`apps/web`)

The web app is a Next.js 16 App Router application using React 18. It owns:

- project, chat, file-workspace, preview, Settings, marketplace, and creation
  workflows;
- daemon and BYOK transport providers;
- rendering of streamed runtime events and inline artifacts such as
  `<question-form>`;
- preview/export bridges and the srcDoc-versus-URL render decision.

Projects, conversations, messages, and project files are hydrated through the
daemon APIs. Browser state is used for UI state and selected local preferences,
not as an alternate browser-only project database.

Home collection preferences are partitioned by workspace, member and collection.
A successful empty workspace directory enables a separate local collection
partition. Failed or unresolved identity reads do not enable the local partition;
an announced identity change suspends preference persistence. A retained
authenticated context keeps its own preferences during a transient read failure.
These browser preferences grant no workspace authority.

#### Composer workspace context

Workspace mentions bind context to a chat turn. The project PATCH response
includes a `linkedDirResolutions` receipt mapping each input path to its stored
path. The composer adopts the returned metadata and uses that receipt to track
canonical folder identities, including aliases of the same folder. Removing an
inline folder mention revokes only access owned by that attachment; another
attachment, an existing working directory or a separately granted link retains
its access. Sending waits for the metadata update. A refused removal restores
the context, and Undo does not silently restore revoked folder access.

Editing a queued turn synchronously restores its text, attachments and context.
The queue entry is removed only after the composer accepts that complete
editable payload. Folder grants settle separately while sending stays blocked;
a failed restoration gives explicit feedback without losing the editable turn.

Folder metadata mutations are serialized. Each PATCH aborts after 15 seconds;
an aborted request triggers a GET with a 5-second deadline to reconcile current
server state. An abort does not roll back a committed write, and that GET is
not a barrier against a delayed request. Missing or ambiguous identity evidence
latches the folder state as unknown and blocks sending and further folder
writes. The draft remains editable. A fresh host project read, including a
reload, clears that latch; an ordinary composer render does not.

Improve prompt keeps the original draft when its preview is cancelled. A retry
can receive `transformer-busy` while the previous server-side generation unwinds.
After one automatic retry, the dialog offers an explicit Retry action. Only one
preview request is active at a time; closing the dialog aborts it and clears its
pending retry timer. A busy response does not attach or accept a brief.

### 3.2 Daemon (`apps/daemon`)

The Express daemon is the product authority for `/api/*`. It owns:

- project and conversation persistence;
- file listing, upload, version, preview, import, and export routes;
- agent detection, launch, run bookkeeping, cancellation, and SSE output;
- prompt composition from the active design system, primary skill/template,
  craft rules, project metadata, and per-turn additions;
- plugin, MCP, media, automation, memory, library, and design-system services;
- static production serving and loopback/security policy.

`apps/daemon/src/server.ts` still composes the application, while route modules
under `apps/daemon/src/routes/` own increasingly focused HTTP boundaries.
Shared request/response shapes live in `packages/contracts`.

Skill asset responses resolve paths relative to the authorized skill asset root.
Hidden installation ancestors do not hide public assets; relative private
dotfiles, dot-directories and paths outside the asset root remain refused.

Website Clone's direct system-browser adapter uses a fresh temporary profile.
On macOS, its headless launch uses Chromium's basic password store and mock
keychain flags so it does not wait for the user's Keychain. Navigation observes
the prearmed page-event wait immediately and removes its own waiter on failure;
the navigation command's error remains authoritative.

External MCP configuration, reconnect requirements and private project-file
access are owned by [Agent Adapters](agent-adapters.md#external-mcp-credentials).
Composed agency builds use the [block composition repair policy](agency-site.md#block-composition).

#### Media gallery actions

The canvas Media workbench and `od media gallery|place|reuse|unlink --json`
use the project-scoped routes in `apps/daemon/src/routes/media-workbench.ts`.
The gallery selects a project and filters type, provider and job status. SQLite
lineage retains saved versions across daemon restarts; cancel and retry use the
existing shared task routes.

Download reads the output. Place in project copies verified bytes into the
current canvas project under an asset filename, even when the gallery is browsing
another project. The Place button and result name the destination. The Place API
accepts `targetProjectId`; omitting it retains the source-project default.
`od media place --project <source> --target <destination>` selects that destination;
`--target` is optional. Reuse in project offers another project in the UI; the API
also retains same-project copying for existing callers. Both copy actions preserve
source bytes, choose a free filename on collision, and support an idempotency key.
Placement uses the existing `reuse` lineage relation and records no new generation
or edit; `parentInProject` reflects whether source and destination match.
Gallery and copy actions honor an imported project's registered workspace root.
Legacy generation still writes managed outputs; an imported gallery cannot show
those outputs until their bytes move into the registered workspace. Generation
waits retain their existing output witness. The daemon data-root rules remain in
[AGENTS.md](../AGENTS.md#daemon-data-directory-contract).
Unlink hides an entry and keeps its bytes. Placeholder outputs stay labeled and
the daemon refuses placement and reuse of those bytes. These actions do not
establish real-provider acceptance under AC-R10.3.

### 3.3 Runtime registry and detection

`apps/daemon/src/runtimes/registry.ts` collects one `RuntimeAgentDef` per
shipped runtime plus user-defined local profiles. Definitions declare launch,
prompt delivery, model discovery, auth probing, stream format, and optional
capabilities; the shared engine performs the lifecycle.

`apps/daemon/src/runtimes/env.ts` owns child environment composition;
`inherited-env.ts` defines the allowed ambient names. The CLI transport in
`apps/daemon/src/daemon-url.ts` owns automatic run-token origin checks.
Their authorization contracts are documented in
[Agent Adapters](agent-adapters.md#10-authorization-boundaries).

On each detection pass, definitions are probed concurrently. Detection first
uses `resolveAgentLaunch()` so the probed executable is the same configured,
fallback, or packaged path a run will spawn. A successful version launch gates
availability; help/capability, model, and declared auth probes then run in
parallel. There is no config-directory confidence heuristic or persisted
24-hour availability cache. See [`agent-adapters.md`](agent-adapters.md).

### 3.4 Content registries

Functional skills and rendering templates are separate listing surfaces:

| Surface | Bundled source | API | Purpose |
|---|---|---|---|
| Functional skills | `skills/` | `/api/skills` | Capabilities an agent invokes while working |
| Design templates | `design-templates/` | `/api/design-templates` | Renderable starting points for creation workflows |
| Design systems | `design-systems/` | `/api/design-systems` | Brand tokens, rules, and fixtures |
| Plugins | `plugins/_official/` plus configured registries | `/api/plugins` | Installable bundles and marketplace metadata |
| Craft | `craft/` | composed by the daemon | Universal rules requested by a skill/template |

The skill and template endpoints scan their user-writable root first and their
bundled root second on each listing request; a user entry can shadow a bundled
entry with the same id. Chat resolution spans both roots because a persisted
project's primary `skillId` may identify either a functional skill or a design
template. Listing separation does not imply automatic composition: selecting
a Start from template replaces the creation tab's default primary skill.

The design-system and plugin services have their own import, validation, and
storage rules; they are not additional skill roots.

Design-kit generation follows the [revision approval contract](../design-systems/README.md#revision-approval).
An authenticated Team publication carries the publisher's approved revision, which the receiver
checks against the downloaded bytes before recording a seed. Receiver runtime
markers do not change the content revision, and local revocation overrides
survive later pulls. Shared kits without a matching approval stay Unreviewed.

### 3.5 Persistence and project files

On startup, `apps/daemon/src/server.ts` resolves `OD_DATA_DIR` once into
`RUNTIME_DATA_DIR`. SQLite, managed project workspaces, artifacts, user-owned
registry entries, credentials, automation state, plugin state, and other
daemon-owned data derive from that resolved root.

The one project-workspace exception is folder import: an imported project uses
the user-selected external `metadata.baseDir`. The daemon validates and bounds
file operations against that selected workspace instead of copying it into the
managed-project root.

This document intentionally gives no concrete daemon data path. The root
`AGENTS.md` section **Daemon data directory contract** is the only path
authority.

### 3.6 Preview renderer

The file workspace previews project files in sandboxed iframes. HTML can load
from a daemon URL or through srcDoc; bridges for inspection, comment selection,
palette/edit/tweak behavior, and other host integration require the srcDoc
path. `apps/web/src/components/file-viewer-render-mode.ts` owns that decision.

The host keeps URL and srcDoc frames mounted when switching render mode to
avoid reload flashes. Message handlers validate the sending iframe, and
signals that must come from the active frame re-check the active window.

A slide deck opened in a new tab has a trusted outer wrapper that closes the
tab on Escape. It accepts the child Escape message only from its own iframe's
window. The child retains its opaque `allow-scripts` sandbox. Ordinary HTML
previews and print wrappers do not enable this handler.

### 3.7 Workbench review history

Mechanical checks persist as immutable review bundles. The Review panel lists
them under Previous runs beside full model reviews, reloads that history on
opening, and opens saved check results with links to their evidence details.
It uses the existing project-scoped `review/bundles` list and
`review/bundles/:id` read endpoints. Full model reviews retain their own history
and outdated state.

## 4. Generation data flow

### Filesystem execution profile

1. The web UI or `od` CLI creates/selects a project through `/api/projects`.
2. A chat/run request reaches the daemon over `/api/*`.
3. The daemon resolves the project, design system, primary skill or design
   template, per-turn skills, runtime definition, and execution metadata.
4. The daemon spawns the runtime with the project workspace as its working
   directory and streams normalized events over SSE.
5. Structured/tool-capable runtimes write canonical project files. File events
   update the file workspace, and a previewable file becomes the rendered
   deliverable.
6. The assistant ends with an ordinary summary of the files it wrote; it does
   not duplicate source in a code `<artifact>` block.

### Text-artifact execution profile

Plain-stream runtimes and BYOK/API execution have no filesystem tools in the
model loop. Their canonical deliverable is one complete source-code
`<artifact>` block. The host parses and materializes that output so it reaches
the same file workspace and preview surfaces.

`packages/contracts/src/execution-profile.ts` maps a runtime's stream format to
the handoff profile. The prompt composers enforce the corresponding contract.

## 5. HTTP and streaming boundary

The shipped web/daemon protocol is HTTP plus Server-Sent Events, not the
WebSocket RPC sketched in the original architecture draft. Representative
surfaces include:

```text
GET  /api/health
GET  /api/agents
GET  /api/skills
GET  /api/design-templates
GET  /api/design-systems
GET  /api/projects
POST /api/projects
POST /api/import/folder
GET  /api/projects/:id/files
POST /api/projects/:id/upload
POST /api/chat                         -> text/event-stream
```

The exact API list and DTOs evolve in route modules and `packages/contracts`;
the table above is an orientation aid, not an exhaustive protocol schema.

SSE responses disable proxy buffering/transform and emit keepalives. A reverse
proxy must keep `/api/*` streaming routes unbuffered and uncompressed and use
timeouts long enough for model runs.

The `od` CLI's explicit group help exits successfully without requiring a
running daemon. This includes `od tools --help`, `od library --help`,
`od artifacts --help`, and help for the `tools connectors`,
`tools deliverable-syntax`, `tools design-systems` and `tools live-artifacts`
groups. Invoking a group without a command or an explicit help flag still
returns a usage error.

The public agency build stream may report `repair-discarded` with its block
label and fixed `malformed` or `invalid` reason. The daemon repair-discarded
and strict-verification diagnostics, and the CLI repair-discarded output, carry
fixed reasons or remaining-slot counts without validator detail or generated
remaining text. Detailed model-call evidence remains in
existing explicitly requested debug artifacts; see the [composition guide](agency-site.md#block-composition).

User-requested local diagnostics downloads follow the
[local download policy](testing/diagnostics-environment.md#local-download-policy),
including default contents, redaction limits and omitted binary dumps.

## 6. Folder import and desktop trust

`POST /api/import/folder` creates a project rooted at a user-selected folder.
The daemon canonicalizes and validates the path, rejects imports inside its own
managed storage, and applies safe path resolution to every later file access.

When paired with desktop, folder import is guarded by a short-lived,
single-use HMAC token minted by the trusted main process after the native
folder picker succeeds. Packaged/headless and web-only launches explicitly
select whether that desktop-auth gate applies. Imported projects that may use
the desktop open-path bridge carry a server-controlled trusted-picker marker;
ordinary project create/update requests cannot forge it.

The implementation source of truth is `apps/daemon/src/desktop-auth.ts`,
`apps/daemon/src/import-export-routes.ts`, and the desktop/packaged launchers.
Shared DTOs live in `packages/contracts`.

## 7. Security boundaries

- The daemon binds to loopback by default. Non-loopback/public deployment
  requires explicit bind, origin, and authentication configuration.
- External fetch/proxy routes enforce URL and SSRF policy at their daemon
  boundary.
- Artifact and plugin previews run in sandboxed iframes without host
  same-origin access; individual surfaces opt into only the sandbox features
  they require, such as downloads or popups.
- File routes resolve and validate paths against the active project root.
  Imported-folder projects use their validated external root; managed projects
  use the daemon-managed project root.
- Runtime spawn policy is declared per adapter and augmented by daemon sandbox
  settings. Do not assume every upstream CLI has the same permission flags.
- Credentials and tokens are daemon-owned data unless a narrowly documented
  integration says otherwise. They must follow the data-root and redaction
  rules rather than being copied into project files.

## 8. Agency fast lane (generative UI)

The agency fast lane builds a site, app screen or dashboard from one client brief in seconds,
without an agent runtime in the loop. The daemon runs it as a build job; the web Design index
view (Route and Build panels) and the `od agency` CLI start and follow the same job. The Home
spine chips group the family plugins by spine. The user
workflow is in [`agency-site.md`](agency-site.md#fast-lane-brief-to-published-page); the domain
terms are in [`../CONTEXT.md`](../CONTEXT.md).

```text
brief
  │
  ▼
route ── one Jev request: spine, archetype, skin, page kind and family
  │      (16 families over 9 atlas spines; unrouted when no family is likely enough)
  ▼
family package ── recipe schema, slots, renderer, optional sections, x-mock marks
  │
  ▼
optional sections ── one Jev keep/drop request; hints from the caller win
  │
  ▼
fill ── one structured call per page or per section
  │     DeepSeek deepseek-v4-flash or Cerebras gpt-oss-120b, with failover
  ▼
render ── trusted family renderer, inlined CSS and catalog components
  │
  ▼
page structure ── unique ids, visible heading, form labels and valid destinations
  │               (all publish modes; app prototypes receive the scoped id check)
  ▼
faithfulness gate ── Jev checks fact slots against the brief; x-mock slots skipped
  │     (default `strict`; `after` publishes first, `off` skips the gate)
  │
  ▼
publish ── project + artifact through the daemon project API
  │
  ▼
deploy ── Vercel or Cloudflare Pages; access reported as public, protected or unknown
```

### 8.1 Packages and ownership

| Concern | Source |
|---|---|
| Build job (route, project, lock, run) | `packages/agency-fast-lane/src/build.ts` |
| Router and route policy | `packages/agency-fast-lane/src/route.ts` |
| Shape atlas and family registry | `packages/agency-fast-lane/src/atlas/shape-atlas.json`, `family-registry.json` |
| Fill, sections and repair loop | `packages/agency-fast-lane/src/run.ts`, `spine.ts`, `sections.ts` |
| Model callers and keys | `packages/agency-fast-lane/src/deepseek.ts` |
| Provider failover | `packages/agency-fast-lane/src/failover.ts` |
| Page structure checker | `packages/agency-fast-lane/src/render-quality.ts` |
| Faithfulness checker | `packages/agency-fast-lane/src/jev.ts`, `verify-policy.ts` |
| Project publish | `packages/agency-fast-lane/src/publish.ts` |
| Family modules | `plugins/_official/examples/agency-<family>/compiler/scripts/families/<family>/` |
| Shared compiler code | `plugins/_official/shared/agency-compiler/`, copied into every family package by `scripts/sync-agency-compiler.ts` |
| HyperUI blocks and page-kind CSS | `plugins/_official/shared/ui-kits/hyperui/` |
| GenUI component catalog | `packages/genui-catalog/` |
| Section catalog | `packages/section-catalog/` |
| AG-UI encoders | `packages/agui-adapter/` |
| Build and route HTTP | `apps/daemon/src/routes/agency-build.ts`, `apps/daemon/src/routes/design-index.ts` |
| Catalog HTTP | `apps/daemon/src/routes/genui-catalog.ts` |
| Section catalog HTTP | `apps/daemon/src/routes/sections.ts` |
| Shared DTOs | `packages/contracts/src/api/agency-build.ts`, `design-index.ts`, `genui-catalog.ts`, `section-catalog.ts` |
| Web surfaces | `apps/web/src/components/DesignIndexView.tsx`, `CatalogView.tsx`, `SettingsDialog.tsx` |

A family package is self-contained: it cannot import a workspace package, because the plugin
packer ships only the plugin directory. Edit shared compiler code only under
`plugins/_official/shared/agency-compiler` and run
`node --experimental-strip-types scripts/sync-agency-compiler.ts`; CI runs it with `--check`.

The structure gate runs before each progressive publish and the final publish. A failure rolls
back a new project and reports `RENDER_QUALITY_FAILED`; it does not reuse a factual verification
label. HTTP snapshots, CLI output, AG-UI state and the web progress panel carry the same closed
check codes and issue counts. Raw targets and diagnostic reasons stay in local debug evidence.
This gate checks page structure, not visual taste or production readiness. Variable-length lists
keep the supported distinct records instead of duplicating content to fill a template minimum.

### 8.2 Families

Sixteen families cover all nine spines. Each has a JSON Schema recipe, named text slots with
`data-od-id` targets, a contract and a renderer.

| Family | Spine | Archetype | Page kind |
|---|---|---|---|
| watson | TL trust to lead | TL.05 | site |
| fervor | TL trust to lead | TL.05 | site |
| wrenfield | TL trust to lead | TL.04 | site |
| maben | TL trust to lead | TL.04 | site |
| halcyon | BA booking attendance | BA.03 | site |
| restaurant | BA booking attendance | BA.02 | site |
| maren | CO commerce | CO.01 | site |
| emmpo | LM learning membership | LM.01 | site |
| community | LM learning membership | LM.03 | site |
| marketing-site | PA product adoption | PA.01 | site |
| app-shell | TU task utility | TU.01 | app |
| crm-dashboard | TU task utility | TU.01 | dashboard |
| listings | SM search and match | SM.02 | site |
| publication | CS content subscription | CS.01 | site |
| nonprofit | MI mission impact | MI.01 | site |
| docs-hub | CS content subscription | CS.02 | site |

app-shell and crm-dashboard (page kinds `app` and `dashboard`) are static prototypes: the page and
`od agency families` label them "Static prototype: navigation and controls are not wired."
marketing-site, app-shell, crm-dashboard, listings, publication, nonprofit, restaurant, docs-hub
and community render HyperUI blocks with committed page-kind CSS. The registry test in
`packages/agency-fast-lane/tests/atlas.test.ts` fails if a spine has no family.

### 8.3 Routing

`createJevRouter` routes with one Jev request (`calls: 1`). `buildRouteQuestions` asks every
question at once: the spine, an archetype per spine, the family, the skin and the page kind. Each
family's criterion names the spines it is legal from, so the family probabilities come back in
the same answer as the spine probabilities. `resolveRoute` then applies a fixed policy:

- **No spine.** A `none` spine answer leaves the brief unrouted (`no spine`). A malformed spine,
  skin or family answer also leaves it unrouted, with the reason.
- **Spines considered.** The top spine plus every runner-up spine with at least 25 % of the spine
  answer's probability mass (`spineShare`, default 0.25).
- **Candidates and basis.** A family is a candidate through one of the considered spines:
  `exact` when its archetype is the chosen archetype, `same-spine` when it sits on that spine,
  `compatible` when the atlas transfer score from that spine is 2 or more (`minTransfer`).
- **Ranking.** Candidates sort by Jev's family probability. Two probabilities within 0.02 are a
  tie, broken by basis (exact, then same-spine, then compatible) and then by a skin match.
- **Threshold.** A winner below 0.5 (`threshold`) leaves the brief unrouted with a reason.
- **Page-kind check.** When Jev answers the page kind (site, app, dashboard) with confidence
  0.5 or more and it disagrees with the winner's page kind, the route moves to the best
  candidate of that page kind at or above the threshold, or becomes unrouted. The 0.5
  page-kind confidence bar is fixed: `--threshold` changes the family threshold only.

`POST /api/agency/route` and `od agency route` return the whole decision, with every candidate.
`--threshold`, `--min-transfer` and `--spine-share` override the policy for one call. Evidence
for the defaults is in [`evals/2026-09-19-route-live-proof.md`](evals/2026-09-19-route-live-proof.md);
the 25-item route corpus is profiled in
[`evals/2026-09-19-catalog-25-profiles.md`](evals/2026-09-19-catalog-25-profiles.md).

### 8.4 Fill, keys and failover

The fill runs on DeepSeek `deepseek-v4-flash` or Cerebras `gpt-oss-120b`. A request can name a
provider; otherwise marketing-site, app-shell, crm-dashboard and four of the six HyperUI site
page kinds added since (listings, publication, nonprofit, docs-hub) default to Cerebras
`gpt-oss-120b` (lowest preview p50 in
[`evals/2026-09-22-genui-bakeoff.md`](evals/2026-09-22-genui-bakeoff.md); the HyperUI kinds beyond
the three actually measured take the same site-kind winner by category, not individual
benchmarking). The other two, restaurant and community, were deliberate exceptions and default
to DeepSeek explicitly (`DEFAULT_MODEL_BY_FAMILY` names them with no model and with
`deepseek-v4-flash` respectively), same destination as the seven hand-crafted site families that
fall back to `DEFAULT_PROVIDER` because the table does not mention them at all — nine families on
DeepSeek `deepseek-v4-flash` in total. `mode: 'sections'` (the default) makes one call per section; `mode: 'single'` fills
the page in one call. One build runs at a time on a daemon; a second `POST /api/agency/build` answers 409
`BUILD_BUSY`.

Keys resolve at call time in the daemon process, in this order:

| Key | Environment | Stored daemon config | Vault |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `models.deepseek` | `deepseek_api_key` |
| Cerebras | `CEREBRAS_API_KEY` | `models.cerebras` | `cerebras_api_key` |
| Jev (TypeSafe) | `TYPESAFE_API_KEY` | Jev section | `typesafe_api_key` |

`GET` and `PUT /api/agency/config` read and write the stored keys. Responses carry only
`{configured, source}` per key, never a value. Settings shows one card per key, and
`od agency config status`, `od agency config set [--provider deepseek|cerebras] --key-stdin` and
`od agency config clear [--provider deepseek|cerebras]` drive the same endpoint (`set` reads the
key from stdin). `od agency config repair --confirm` sets an unreadable key file aside.

Failover moves a build to the other provider after bounded retries when the primary answers 429,
a 5xx, a timeout, a network error or has no key, and only before any output byte. It never fails
over after streamed output, on cancellation, on 401/403 or another 4xx, or on a schema error
(those are repaired on the same provider). The switch is sticky for the rest of the build. The
build result and snapshot record every provider that answered, and a failed build names both
outcomes, for example "deepseek answered 429, then cerebras timed out".

### 8.5 Optional sections and faithfulness

A family schema marks a section `x-optional`. Before the fill, one Jev request judges keep or
drop for each optional section; a section is dropped when Jev's drop probability is 0.75 or
more, and every section is kept when Jev is unavailable or verify is off. `POST /api/agency/build` accepts
`sections: {<id>: 'keep' | 'drop'}` (CLI `--keep` / `--drop`, Build panel section controls), and
those hints win. A dropped section stays `null` in the recipe, so the fill, the fact collection
and the renderer skip it, and a repair never re-judges it.

The faithfulness gate asks Jev whether each fact slot is supported by the brief. Verify modes
are `strict` (publish only a page that passes), `advisory` (publish as it goes), `after` (publish
first, verify after the preview, then `POST /api/agency/builds/:id/repair`) and `off`.
`od agency build --verify` takes all four; the Build panel offers `strict`, `advisory` and
`after`. Slots a
schema marks `"x-mock": true` hold labelled sample data ("Sample data", "Illustrative pricing").
The gate leaves them out of `checked`, reports them as `illustrative`, and a repair keeps them
locked.

### 8.6 Publish and deploy

A build creates or reuses a project through the daemon project API and registers the page as a
normal artifact. A cancelled build deletes a project it created. Deploys use
`POST /api/projects/:id/deploy` (`od deploy <projectId> --file <name>`). The result carries
`access`: `public` only when the provider confirms protection is off and an anonymous request
reaches the page, `protected` when a probe hits a protection wall, and `unknown` otherwise. The
"Public link is ready" sentence appears only for `public`; `od deploy --public` turns Vercel
deployment protection off and exits 1 unless access is `public`.

Vercel and Cloudflare Pages share a publication allowlist: the selected HTML entry and its
transitively referenced local files. Linked HTML pages, stylesheets and CSS imports, scripts,
srcset images, fonts and media join that set. Preflight reports the same files and count that
the provider receives. Files merely stored beside the page, or listed in generated artifact
metadata, stay private unless the page references them. Parent-path traversal, including
encoded forms, and symlinks escaping the project block deployment. Agency manifests further
restrict the allowed files. Deploy has no public explicit-include option.

Missing anchor targets are optional: preflight and deploy return a warning and skip the
missing file. A parse error in a referenced JavaScript or CSS file triggers a regex scan
for static references; deploy keeps the file and reports a warning. Malformed URL encoding
also produces a warning and skips that reference. An invalid encoded base is removed from
the relocated entry, and references use the document directory. Required missing assets,
traversal and scope violations still block upload. Deploy responses expose an optional
`warnings` array using the preflight warning shape; the UI result and `od deploy --json`
surface it. Runtime-only paths such as `fetch('data.json')`, `data-src`, and `og:image`
remain outside the publication allowlist.

### 8.7 Build progress and the AG-UI stream

| Surface | Shape |
|---|---|
| `GET /api/agency/builds/:id/events` | SSE `build-event` frames, then one `status` frame with the final snapshot |
| `GET /api/agency/builds/:id/agui` | SSE AG-UI events: `RUN_STARTED`, `STEP_STARTED`/`STEP_FINISHED` (route, fill, verify, publish), `STATE_SNAPSHOT`, `STATE_DELTA` (RFC 6902), `CUSTOM`, then one `RUN_FINISHED` or `RUN_ERROR` |
| `od agency build --agui` | The AG-UI events as NDJSON; cannot be combined with `--json` or `--no-wait` |

The AG-UI route is local-origin only. It replays the build so far and then streams live events;
`Last-Event-ID` resumes after the last event the client saw. The state never includes the brief
(only `briefChars`). The web Build panel reads this stream for its step timeline. It is a
watch-only GET endpoint, not an AG-UI agent endpoint. Other build routes:
`POST /api/agency/build`, `GET /api/agency/builds`, `GET /api/agency/builds/:id`,
`POST /api/agency/builds/:id/fork`, `.../repair` and `.../cancel`.

### 8.8 GenUI component catalog

`packages/genui-catalog` owns `catalog.json`, validated by `packages/genui-catalog/schema/catalog.schema.json`. Each of
its 63 entries records its source (`react-bits`, `21st.dev`, `kokonut-ui`, `cult-ui-pro` or
`original`) and URL, licence decision (`clean-room`, `port-with-attribution`, `licensed` or
`cut`), verdict (`keep`, `maybe` or `cut`), tier, port difficulty and status. `licensed` marks the
six Cult UI Pro primitive ports, covered by the purchased licence in
`docs/legal/cult-ui-pro-rights.md` rather than a clean-room rewrite. The `keep` entries are ported as framework-free ESM plus CSS with
`mount(el, opts) => { destroy() }`, a demo fragment and a jsdom test; no React, GSAP or three.js.
Family pages ship `default-src 'none'`, so catalog JS and CSS are inlined; the HyperUI page kinds
keep `script-src 'none'` unless a reviewed family interaction or `js` effect is applied, and then
allow only the exact inlined scripts by their SHA-256 hashes. `pnpm --filter @open-design/genui-catalog sync-assets` copies the
components each family declares into that family package under `compiler/scripts/catalog/`.

| Surface | Shape |
|---|---|
| `GET /api/genui/catalog` | The validated manifest |
| Web `/catalog` → **Effects** | Category filter, fitted demos and full interactive previews at 390, 768 and 1280 px with reduced motion |
| `od catalog list` / `od catalog get <id>` | The same manifest, as a table or `--json` |
| `GET /api/genui/catalog/:id/preview` / `od catalog preview <id>` | The same offline demo document, or its embeddable URL (`--json`, `--reduced-motion`) |

The same `/catalog` view carries two more segments over the Cult UI Pro inventory
(`packages/cult-ui-catalog/catalog.json`, §8.9): **Blocks** (section and page rows, grouped by
taxonomy section kind) and **Components** (primitive and app rows, grouped by source category).
Both read `GET /api/cult/catalog` (`?kind=section|page|primitive|app|blocks|components`,
`?state=`) and `GET /api/cult/catalog/:id` (`apps/daemon/src/routes/cult-catalog.ts`, DTO
`packages/contracts/src/api/cult-catalog.ts`), which project every inventory row — including
section rows the section catalog skips as `unclassified` — to a brand-free display row
(`apps/daemon/src/cult-catalog-projection.ts`). The projection scrubs every displayed string
(title, summary, reason, tags, source category) against one explicit deny list of other
companies' names, in bare, possessive and plural forms and inside "-style", "-inspired",
"-powered" and "inspired by" clauses: style providers become a series letter, vendors and
libraries a neutral noun, and a branded tag or category is dropped (`other`). It fails closed — a
name that survives the scrub throws rather than reaching the DTO — and the raw text stays
server-side. Each row carries one honest state, one per `conversion.status` with no two statuses
sharing a state: `insertable`, `needs-adaptation` (`adapter-needed`), `not-converted`
(`unconverted`), `app-only`, or `pending` (`pending-fetch`); an unknown status, section kind or
port queue throws instead of being shown as a guessed state. Preview readiness is independent of insertion readiness: converted rows use their reviewed
section previews, and other rows use committed thumbnails rendered from the local demo harness.
The Preview action opens the actual local component, with a visible explanation if that harness
is unavailable. No preview changes a row's adaptation status. Image metadata carries the actual file SHA-256;
card URLs include that revision so a changed preview bypasses a previously cached image. `od cult list
[--kind <k>] [--state <s>] [--json]` / `od cult get <slug> [--json]` print the same rows.

**Saved 21st.dev components.** The fourth Catalog segment reads `GET /api/21st`
(`apps/daemon/src/routes/twenty1st.ts`, data in `packages/21st-catalog`).
When `TWENTY1ST_PREVIEW_DIR` points to a built private source kit, cards show the saved upstream
thumbnail and open the actual downloaded React demo at phone, tablet, or desktop width. The
private manifest proves component/demo provenance against the saved registry and records any
small compatibility patches. Source files and compiled assets are checksum-verified when the
routes mount; unsafe paths, unknown IDs, modified files, and symlink escapes fail closed.
`/api/21st/:id/preview` serves the sandbox HTML and catalogued assets; the sibling `source`
route returns the actual TSX, demo, dependencies, and source ZIP. `od 21st list`, `get`,
`preview`, `source`, and `export` use the same routes and report `upstream-private` provenance.

Private source material remains in the external source kit and does not enter packaged
resources or this repository. Source export preserves its upstream author and rights; a local
preview does not grant redistribution rights. Without a configured kit, the independently
authored alternatives in `packages/21st-catalog/originals/` remain available. The separate
`/api/21st/:id/reference-preview` route always serves the saved upstream preview image.

**Public slugs.** A row's id in the DTO is `cult:<slug>`, never the internal inventory name
(which can name the provider a style came from: `marketing-pricing-vercel`). The slug is the
slugified brand-free display title (`pricing-series-v`), generated with the catalog into
`packages/cult-ui-catalog/generated/slugs.json` by `packages/cult-ui-catalog/scripts/slugs.ts` (`import` runs it; `check`
fails when it is stale) through `assignCultSlugs` in `packages/contracts/src/api/cult-brand.ts`,
where the brand scrub itself now lives. Slugs are unique, never another row's internal name, and
sticky (a row keeps its committed slug while it is still valid for its title). Every route and
`od cult` command takes the slug, `cult:<slug>`, or an old internal name or id as an alias; a
response only ever carries the slug.

**Remix into project.** Every Blocks and Components card also lets the owner remix the item into
one of his own React apps: "Copy install command" (`npx shadcn@latest add <url>`), "Copy code" (the
item's main file, imports on the default aliases; `od cult show <slug> [--file <target>]` prints the
same) and "Copy CLI" (`od cult add <slug> --into .`). `GET /api/cult/r/<slug>.json` serves the licensed
registry item from the private source kit (`CULT_KIT_DIR`) in the public registry-item format;
catalogued registry dependencies point back at the same endpoint, and the rest stay bare names for
the default registry. The served item is brand-free outside the source text itself: it is named by
its slug, with a scrubbed title and description and no vendor metadata; every branded file or
folder name becomes brand-free (`cultBrandFreePath`: an item folder takes that item's slug,
`pricing-vite.tsx` → `pricing-series-vt.tsx`, the `lib/` file `stripe.ts` → `card-payment.ts`) with the
item's relative and `@/` import paths following; and each branded export is renamed
(`cultBrandFreeIdentifier`: `VercelPricing` → `PricingSeriesV`) in every file of the item and of
the items that install it, decided once on the defining item so all agree. Brand detection reads
names word by word and as joined runs of adjacent words, because a hump splitter cuts `IPhone` and
`OpenAI` apart (`cultBrandRun`). A new name that is already taken gets the first free number
(`AnalyticsHeroIcon2`). An export keeps its name only when the same word is also a module name,
a string key or a property in the item, which must stay (today exactly `stripe` and `redis` in
`card-payment-subscription`, next to `"stripe"` and `stripe:user:…`); `CultRegistry.exportRenames`
reports why. npm package names and the rest of the source text stay as the kit ships them. In script files only, a relative import that holds only in the vendor's repo
layout is repointed at the one installed file its vendor path (or an unambiguous tail with a
directory segment) names, never at the file itself. `GET /api/cult/copy/:id[?file=]` (DTO
`packages/contracts/src/api/cult-registry.ts`) answers the web buttons and `od cult show`. Both
(`apps/daemon/src/routes/cult-registry.ts`) open only catalogued names and serve only bytes whose
sha256 matches the catalog pin. They answer this machine only, by one pure rule both apps share
(`cultLocalOnlyRefusal`, `packages/contracts/src/api/cult-local-only.ts`): loopback peer, Host and
Origin; every client named in `X-Forwarded-For` or `Forwarded: for=` loopback; and no forwarded
host, scheme or port at all (`X-Forwarded-Host`/`-Proto`/`-Port`, `Forwarded: host=/proto=`),
whatever the daemon's bind or token settings. The web sidecar proxy (`apps/web/sidecar/server.ts`)
matches daemon paths in any case (`/API/…` too) and appends the client it accepted to
`X-Forwarded-For`, so a LAN browser reaching the web port is refused. Next's own dev rewrite of
`/api/:path*` (plain `next dev`, or any path that reaches Next) sets `X-Forwarded-Host` from the
client-chosen Host and passes a client-sent `X-Forwarded-For` through, so the route refuses
anything carrying a forwarded host: licensed source is never served through that rewrite, even to
this machine. A TCP-level forwarder (`ssh -R`, `socat`, `ngrok tcp`) that terminates on this machine
sends no forwarding header and cannot be told apart from a local caller; do not run one in front of
the daemon. `od cult add <slug...> --into <dir> [--dry-run] [--force] [--install] [--json]` reads the
same endpoint and writes each file to its target on the project's `components.json` aliases.
Every vendor `app/**` file (pages, layouts, the `app/` files `demo.tsx`, `actions.tsx`, and API `route.ts` files)
lands under `app/(cult)/<slug>/`, and a root-level Markdown file under `docs/cult/<slug>/`, with the
item's imports following its own moved files, so two items never share an app file and the
project's own `app/` is never touched. A differing file stops the copy; `--force` replaces only
files inside the item's own folder, never one of the project's files elsewhere, and a directory in
the way stops it always. Writes are staged and all-or-nothing: an I/O error puts every file back.
`--install` uses the package manager of the nearest directory with a `packageManager` field or a
lockfile, searching from the project up to its workspace or git root and never into the home
directory.

**Live preview** (the Preview action on every Blocks and Components card) reads
`GET /api/cult/preview/:id` (whether the row previews live, in which mode, and why not) and frames
`GET /api/cult/preview/:id/frame?theme=light|dark` (`apps/daemon/src/routes/cult-live-preview.ts`,
DTO in `packages/contracts/src/api/cult-live-preview.ts`); `od cult preview <slug> [--html]` reads the
same routes. Both pass `cultLocalOnlyRefusal` first, like the copy routes, because both render
licensed source. A section or page row (`mode: 'converted'`) gets the kit converter's static output
(`<kit>/converted/<name>/template.html` + `styles.css`, filled from `slots.json` with the item's own
text, light or dark `--role-*` values), served with `COMPOSED_PAGE_CSP` from
`@open-design/agency-fast-lane/block-compose` in a meta tag and in the header, where a bare `sandbox`
directive is added (a meta-tag CSP cannot sandbox); the modal frames it with `sandbox=""`. A primitive or app row (`mode: 'harness'`) is proxied from the local preview harness
(its own git repo next to the private source kit, never in this repository): `CultPreviewHarness` (`apps/daemon/src/cult-live-preview.ts`) starts it on demand on a free
loopback port as a child that exits with the daemon (the web sidecar's standalone-backend pattern),
reuses a running one through the harness's `.run/harness.json`, and sends a per-start token the
harness requires on every item request. The harness bundles the item's own demo with esbuild
against real npm packages and shadcn/ui + AI Elements components, stubs server-only modules, and
caches each build on disk by input hash. Its frame CSP allows inline script and nothing else (no
network) and carries `sandbox allow-scripts`; the modal frames it with `sandbox="allow-scripts"`.
Because both frame responses carry the sandbox in their CSP header, the browser gives the page an
opaque origin however it is opened (the modal, the URL `od cult preview` prints, a bookmark), so
item script never runs as the daemon or web origin. The demo posts `ready`, `error`, or `escape`
(Esc pressed inside the frame) to the modal. A harness child that fails to start or to answer its
health check is killed at once, and it runs with a minimal environment (no daemon API keys). A row that needs server keys (it reads secret env vars or imports a
key-bound server SDK), fails to bundle, or throws shows "Can't preview live: <reason>" with its
thumbnail. The modal (`apps/web/src/components/CultLivePreview.tsx`) loads nothing until it opens.

Clean-room entries are written from an effect description only; attribution for ported
entries is in `packages/genui-catalog/NOTICE`.

**Effect placements.** A build puts catalog components on a page only at the placements its
family declares under `effects` in its `catalog.json` in `families/<family>/`: `scriptPolicy`
(`none` / `hash` / `inline`), `maxEffects`, and per placement id (`hero-background`,
`hero-title`, `eyebrow`, `section-title`, `card-surface`, `nav`, `section-reveal`,
`testimonials`, `gallery`, `cta`) one exact `host` (`{id}` or `{odId}`) and a reviewed `allow`
list. The fast lane chooses ids; the shared family compiler (`renderFamily`, `effects.ts` in
`plugins/_official/shared/agency-compiler/scripts/`) writes every byte: host class and
`data-genui`, one inlined style and script per component, the CSP script hash on a `hash` page,
and the 200 KiB final-page budget.

`packages/agency-fast-lane/src/effects.ts` decides the plan before the fill, beside the
optional-section decision and after routing (so the routed skin is known). Explicit ids
(`AgencyBuildRequest.effects`, `--effect`) win and are never asked. Every other placement is
`auto` for site families: one Jev request with one `choice` question per placement, criteria =
each allowed id (catalog name, description and kind) plus `none`; a pick counts only as a valid
choice at confidence 0.75 or more. Any Jev failure gives zero automatic effects and a fixed
`jevSkipped` code, and never changes the faithfulness result; `auto` does not depend on
`verify`. Guards: at most two effects per page, at most one `js` or background effect, the
family's `maxEffects`; quiet and institutional skins at most one text or surface effect,
cinematic and experimental skins two, any other or low-confidence skin one. Families that
declare no placements (app-shell, crm-dashboard) default to `off`.

`runFastLane` passes the plan to every render (progressive paints and the strict publish). With a
section selection, the plan reaches the compiler through the overlay's wrapper and the budget is
checked on the composed page (`renderWithEffects`), dropping the lowest-priority effect first.
`RunReport.effects` (`AgencyEffectsResult`) merges the decision with the compiler's
`EffectRenderReport`; events carry counts only (`effects` build event). Catalog metadata comes
from `@open-design/genui-catalog/data` in the daemon (`BuildInput.effectCatalog`) and from the
source `catalog.json` in the fast-lane CLI. `GET /api/agency/families/:family/effects` serves
`familyEffectsResponse`.

### 8.9 Section catalog

`packages/section-catalog` owns `catalog.json` (`packages/section-catalog/schema/section-catalog.schema.json`, built by
`packages/section-catalog/scripts/build-catalog.ts`), a sibling of the GenUI component catalog for a different unit: a
*section* (placement, content, a family renderer) rather than a mountable effect. Two build-time
sources feed it — all 80 pinned HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/manifest.json`)
and every section of the 13 agency families, read from each family's own
`reference.fixture.json` (111 family sections) — 191 entries in total — plus a third, federated
source that is never baked into `catalog.json`: MotionSites prompt metadata, normalized by
`packages/section-catalog/src/motionsites.ts` from a signed-in user's MCP `list_prompts`/`search_prompts` result and merged
into a catalog response at request time.

Every entry carries `sourceKind`, a taxonomy `sectionKind` (from
`packages/agency-fast-lane/src/taxonomy/design-taxonomy.json`), `spineAffinities`, and a `rights`
label (`license`, `decision`, `evidence`) that governs `availability`:

| sourceKind | rights.decision | availability (v1) |
|---|---|---|
| `hyperui` | `bundle` (MIT) | `insertable` for the three reviewed marketing blocks (`INSERTABLE_V1`); `adapter-needed` otherwise |
| `family-section` | `same-family-only` | always `reference-only` — selectable only through that family's own keep/drop controls, never cross-family |
| `motionsites-prompt` | `metadata-only` (proprietary) | `reference-only`, `preview` always `external-link` to the source; never a locally hosted copy of its preview image, and never the prompt body |
| `cult-pro` | `bundle` (`licensed`, evidence `docs/legal/cult-ui-pro-rights.md` only) | `insertable` exactly when the section row has a checked adapter (`content.adapterId`, equal to the entry id); `adapter-needed` otherwise; `content` is a `cult-item` (Cult description, raw source title, `cult:<name>` + snapshot provenance), never source code |

The `cult-pro` rows are a projection of `packages/cult-ui-catalog/catalog.json`, the canonical
Cult UI Pro inventory (metadata and hashes only): one entry per `section` row (its taxonomy
`sectionKind`) and per `page` row (`page-composition`). A section row the inventory left
`unclassified` is skipped and reported by the build, not guessed into a kind. Display titles drop
other companies' names in favour of a series letter ("Marketing Pricing Vercel" → "Pricing (series
V)"), and fail closed: every other word of a title must be on the reviewed `CULT_TITLE_WORDS` list
(`packages/section-catalog/scripts/build-catalog.ts`), so an unknown brand stops the build instead
of reaching the picker. The projection also refuses a row whose rights differ from the recorded
Cult triple or whose `insertable` status disagrees with its adapter reference. The web picker
(`apps/web/src/components/DesignIndexView.tsx`, which offers only `availability === 'insertable'`
entries as a section) offers an insertable Cult entry like a HyperUI one, lists the rest as
"Adapter needed", and never offers a Cult entry as a design-reference starting point.

The inventory also carries *derived* rows: each section the kit converter cuts out of a whole-page
item (`<page>--<section>`, from the page's `components/sections/<section>.tsx` files) is a
`section` row with id `cult:<page>--<section>`, `derivedFrom: 'cult:<page>'`, the page's snapshot,
source hashes and rights, and a section kind read from the section name
(`packages/cult-ui-catalog/src/derived.ts`). They project and insert like any other section
("Hero (page: SaaS Colorful)"). The snapshot counts them apart (`derivedRows`), so
`expectedItems` stays the registry index's item count. The id uses `--`, not `/`, because the fast
lane's `CULT_ADAPTER_ID`, the section-catalog contract and schema, and the overlay's section id all
accept only `cult:[a-z0-9-]+`.

Cult adapters are generated, checked derivatives kept in `packages/cult-ui-catalog/generated/`
(never in the shared agency compiler, so `scripts/sync-agency-compiler.ts` does not copy them into
the family packages). The private kit's converter writes `adapter.ts` under the kit's `converted/<name>/` directory; the
package's `import` script reads the converter's verdicts into `catalog.json` (`insertable` with an
adapter reference and measured bytes, or `adapter-needed` with the refusal codes) and its
`adapters` script copies each insertable adapter (only the import path and the id change: the id
becomes the catalog id `cult:<name>`), a WebP preview of at most 40 KB, and `packages/cult-ui-catalog/generated/index.ts`,
a lazy registry keyed by id. Adapter-name projection lives in
`packages/agency-fast-lane/src/cult-adapter-names.ts`; catalogue generators use
that pure helper without importing the generated registry they are rebuilding.
The runtime overlay consumes the catalogue package export, so its generated
registry remains reachable from a relocated daemon bundle.
`pnpm --filter @open-design/cult-ui-catalog check` gates them: with
or without the kit it checks ids, versions, hashes, the root `build-section-adapters.ts`
`FORBIDDEN`/`assertClean` rules, `--role-*`-only custom properties (a converter `--k-*` variable
the CSS reads but never sets fails too), `.cult-<name>` scoping, a
worst-case fill, and 48 KB of minified HTML plus CSS per adapter; with the kit it also compares
each file to the kit output and recomputes the source hash from the pinned registry items.
`pnpm --filter @open-design/cult-ui-catalog render-check` (no kit needed; CI runs it in the agency
tests job) splices every insertable adapter, filled to its slot maxima, into real family pages
through the overlay (marketing-site, the strictest family CSP, and watson), composes a page of the
HyperUI lead section plus the largest Cult `features`, `cta-band` and `footer` blocks against the
200 KiB page limit, confirms no synchronized compiler copy carries a Cult file (the frozen-package
budget), and loads every page in Chromium with reduced motion off and on. It fails on a CSP
violation, a non-loopback request, a failed request, a page error, an in-section `#id` link with no
target (`#top` and `#contact`, the page contract, excepted), a class with no rule or an unapplied
section style, and text still transparent, hidden or off-screen 1 s after the section scrolls into
view; a planted self-test section proves each detector on every run. The kit converter turns an
in-block link to a missing id into `#contact` and shows hover-revealed text at rest. The
fast lane (`section-overlay.ts`, `resolveSectionAdapter`) resolves the three HyperUI ids and every
id in that registry, and refuses anything else. Every `tools/pack` lane installs
`@open-design/cult-ui-catalog` from its `pnpm pack` tarball, whose `files` carry `generated/`
(adapters, index, shim and previews; `tools/pack/tests/cult-ui-catalog-packaged.test.ts`). Loading
them from an installed tarball is still open: Node does not strip types under `node_modules`, the
fast lane finds the registry through `import.meta.dirname` (which a prebundled daemon rewrites),
and the shim imports the shared compiler by a workspace-relative path.

The public DTO is `packages/contracts/src/api/section-catalog.ts` (`SectionCatalogEntry`,
`parseSectionCatalogResponse`), mirroring `packages/section-catalog/src/types.ts` structurally so
`contracts` stays free of a workspace dependency on it — the same pattern `genui-catalog.ts` uses.
`content.adapterId` is assigned to the three `INSERTABLE_V1` blocks (`marketing/sections/1`,
`marketing/feature-grids/1`, `marketing/ctas/1`); `missingInsertableAdapters`
(`packages/section-catalog/src/validate.ts`) is the gate that would refuse an `insertable` entry that still lacks one.
`packages/section-catalog`'s own `local-corpus.ts` adds a fourth source, `local-corpus`: owner-
authored prompts bundled with the daemon (never fetched over the network), imported with the same
rights discipline as the federated half — see §8.10.

### 8.10 Section selection and design references

V04 adds read-only per-section reference discovery alongside section composition (updated
2026-10-09). The daemon route `apps/daemon/src/routes/workbench-references.ts` calls
`apps/daemon/src/workbench/references/fanout.ts`, which derives or accepts sections, searches the existing Refero
and Mobbin proxies, deduplicates candidates and uses typed Jev metadata judgments. The pure
request/response contract belongs to `packages/contracts/src/api/workbench-reference-fanout.ts`;
`apps/daemon/src/workbench/references/cli.ts` serves `od references fanout`, and the web's
`apps/web/src/components/workbench/WorkbenchReferences.tsx` presents the same report in the first-draft and
improved-brief flows. See the [V04 interface contract](plans/2026-10-02-design-workbench/technical-spec.md#v04-section-reference-fan-out)
for limits, ranking, degraded reports and unchanged connector permission boundaries. Discovery
does not initiate a build or apply a reference.

One reviewed section can be composed on top of a build's fixed family recipe — a *composition
overlay*, not a change to the family's own recipe schema
(`packages/agency-fast-lane/src/section-overlay.ts`). `POST /api/agency/build`'s optional
`sectionSelection` names a catalog `entryId` (must resolve to one of the three reviewed, insertable
adapters), a `placement` (`append` after an existing section id, or `replace-optional` for one of
the family's own optional sections), and a `directionId` (one of the five built-in design
directions, `packages/contracts/src/prompts/directions.ts`). The daemon validates the entry and
direction exist before queuing the build (`400 BAD_REQUEST` otherwise); the placement's anchor is
checked once the family is known, inside the run itself
(`section-overlay.ts`'s `resolveAnchorOffset`), and a bad anchor fails the build rather than the
request.

`designReferenceId` (a `motionsites-prompt:…` or bundled `zerosum-kit:…` catalog id) supplies
untrusted layout/typography/motion guidance for that one section's own fill prompt — never a
source of factual claims, and never threaded into the faithfulness gate, which checks the
selected section against the client brief only. The daemon fetches the reference's text
(`apps/daemon/src/motionsites/design-reference.ts`) synchronously before the build starts, maps a
signed-in-but-refused prompt to `403 MOTIONSITES_PAID_ACCESS_REQUIRED` and no usable connection to
`401 MOTIONSITES_LOGIN_REQUIRED`, and holds the fetched text **in memory for that one build only**:
it is never written to a build record, a debug dir, an SSE frame, or a log line — only the id
survives, in fork history, so a fork re-fetches the text rather than reusing what was fetched
before (`RunOptions.designReference`, `run.ts`; `packages/agency-fast-lane/tests/section-overlay-design-reference.test.ts` is
the standing proof). A caller may instead supply `designReferenceText` directly (the `od agency
build --reference-file` surface) — same in-memory-only rule, mutually exclusive with
`designReferenceId`.

All three surfaces read the same `GET /api/sections` (`?spine=`/`?kind=` filters, plus the five
design directions in the response so a picker needs no second fetch) and `GET /api/sections/:id`:

| Daemon | `od` CLI | Web |
|---|---|---|
| `GET /api/sections`, `GET /api/sections/:id` (`apps/daemon/src/routes/sections.ts`) | `od sections list\|get [--json]` | The section picker in `DesignIndexView.tsx`'s Build panel |
| `POST /api/agency/build` / `.../builds/:id/fork` with `sectionSelection`/`designReferenceId`/`designReferenceText` | `od agency build --section <id> (--after <id>\|--replace <id>) --direction <id> [--reference <id>\|--reference-file <path\|->]` | Placement + direction controls, a reference id field, "starting point" cards for `page-composition` entries |

A catalog entry's `access` (`local` / `free-account` / `paid-account`) renders as "Free account",
"Paid access" or "Sign in" (never "licensed for bundling" — a free MotionSites prompt open is not
a redistribution grant); `availability` renders as "insertable", "adapter needed" or "reference
only". `od sections`' `sectionsAccessLabel`/`sectionsAvailabilityLabel` and the web's
`sectionAccessLabel`/`sectionAvailabilityLabel` keep the same wording.

A `cult-pro` entry is served brand-free (`publicCultEntry`, `apps/daemon/src/routes/sections.ts`).
Its `id`, `provenance.cultId` and `adapterId` are the public id `cult:<slug>`
(`apps/daemon/src/cult-public-ids.ts`), its summary is scrubbed, and its source title is its
display title. `GET /api/sections/:id` also accepts the bare slug or the old internal id. A build's
`sectionSelection.entryId` and a fork's saved block plan are mapped back to the internal id,
which the section-catalog package, the adapter registry and a running build key on.

What a build puts out names Cult entries by public id too. The fast lane
(`packages/agency-fast-lane/src/cult-public-ids.ts`, reading the same `slugs.json`) writes it into
the published page (`data-od-selected-section="cult:<slug>"`, the `od-selected-cult-<slug>`
section id, the adapter's `cult-<slug>` CSS scope and `sym-<slug>-N` symbol ids, and element ids
it names after itself in `id`, `for`, `aria-*` and in-page `href`), the artifact manifest, a
composed page's saved `recipe.json` and its state note, its unit event labels, and the fast-lane
CLI's `--out-dir` recipe and `--report` file. Any other identifier an adapter publishes that names
a vendor (an id such as `footer-vite-email` with its `for`, an SVG gradient id with its `url(#…)`,
a `@keyframes` name) and any branded label (`aria-label="Discord"`) is renamed from
`packages/cult-ui-catalog/generated/public-names.json`, generated with the adapters
(`packages/cult-ui-catalog/scripts/public-names.ts`; `check` fails when it is stale) and applied as whole tokens so every
reference stays paired. The Cult render gate
(`packages/cult-ui-catalog/scripts/render-check.ts`) checks the page as published: public section
ids and scopes, with its reviewed contrast exemptions still keyed on the internal row name. The
daemon maps `sectionOverlay.entryId` and `composition.blocks`/`budgetDropped` on every snapshot it
serves (`publicSnapshotIds`), including builds saved before public ids, which it rewrites on load.
Resolution accepts either id, so a plan or recipe from an older project still replays.

## 9. Source map

| Concern | Primary source |
|---|---|
| Web product UI | `apps/web/src/` |
| Daemon composition and data-root resolution | `apps/daemon/src/server.ts` |
| Focused daemon HTTP boundaries | `apps/daemon/src/routes/` |
| Shared web/daemon DTOs and prompt contracts | `packages/contracts/src/` |
| Runtime definitions and engine | `apps/daemon/src/runtimes/` |
| Functional-skill loader | `apps/daemon/src/skills.ts` |
| Packaged launch | `apps/packaged/`, `tools/pack/` |
| Development lifecycle | `tools/dev/` |
| Agency fast lane | `packages/agency-fast-lane/` |
| Workbench capture, draft generation and reusable-unit save | [Capture and draft guide](workbench-capture.md) |
| Agency families | `plugins/_official/examples/agency-*/` |
| GenUI component catalog | `packages/genui-catalog/` |
| Section catalog | `packages/section-catalog/` |
| AG-UI encoders | `packages/agui-adapter/` |
| GenUI eval scripts and reports | `evals/genui/`, `docs/evals/` |
| User-level validation | `e2e/` |

When a user-facing capability changes, keep its daemon endpoint, shared
contract, web surface, and `od` CLI surface aligned as required by the root
`AGENTS.md` dual-track rule.
