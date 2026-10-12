# Mishh Mashh

Mishh Mashh is a local-first design workspace where projects contain generated design files and agent conversations. This glossary records domain language only, not implementation details.

## Language

**Project**:
A top-level design workspace that contains conversations and design files.
_Avoid_: repo, folder, session

**Normal Artifact**:
A project design output represented by an artifact entry file and its artifact manifest.
_Avoid_: live artifact, generic file upload

**Live Artifact**:
A refreshable project design output stored as a live-artifact record with source data and preview state.
_Avoid_: normal artifact, static artifact

**Artifact Entry File**:
The primary project file that opens or renders a normal artifact.
_Avoid_: support file, asset, sidecar

**Artifact Manifest**:
The sidecar metadata that identifies a project file as a normal artifact and records its kind, renderer, exports, and entry file.
_Avoid_: live-artifact document, project metadata

**Active Project**:
The project the user most recently interacted with in the Mishh Mashh UI and that MCP tools may use when no project is specified.
_Avoid_: latest project, default project

**Home Composer Media Surface**:
A Home-only composer intent that lets the prompt card expose media-specific defaults before project creation. The current media surfaces are `image`, `video`, and `audio`; they map onto the existing project kinds at submit time instead of extending the backend `ProjectKind` union.
_Avoid_: project kind, backend kind

**Chip Rail**:
The row of intent chips below the Home prompt card. A chip chooses the composer surface, default scenario plugin, default option state, and project kind stamp before the user presses Run.
_Avoid_: plugin list, template list

**Essential Audio Generation**:
A Home Audio entry workflow for the audio capabilities that the product can attempt directly in v1. It includes speech and sound effects, and excludes music until there is an integrated music generation path.
_Avoid_: audio studio, full music workflow

**Audio Source Field**:
The inline Home Audio option that provides the source content for generation. Speech uses a Text source because the content is spoken; sound effects use a Prompt source because the content describes a sound to synthesize.
_Avoid_: generic subject field, hidden prompt text

**ElevenLabs Fallback Voice**:
The default voice option shown when the Home Audio composer cannot load configured ElevenLabs voices. It keeps ElevenLabs speech runnable by selecting the same default voice id the daemon uses when no explicit voice is supplied.
_Avoid_: required credential setup, empty voice selector

**AMR Cloud**:
The user-facing cloud runtime option for the AMR cloud service's model router, shown in onboarding and login-oriented product surfaces.
_Avoid_: Vela, local CLI label

**AMR CLI**:
The local command-line runtime adapter used to run AMR from an installed or packaged native CLI.
_Avoid_: AMR Cloud, cloud account

**AMR CLI Distribution Contract**:
The separately owned release contract that provides the native AMR CLI builds Mishh Mashh can package.
_Avoid_: Mishh Mashh release channel, package build step, source checkout

**AMR CLI Distribution Slice**:
The set of native AMR CLI platforms currently available through the distribution contract; platforms outside the slice do not bundle the AMR CLI.
_Avoid_: Mishh Mashh supported platforms, release channel, future platform promise

**AMR Account Status**:
Whether the user has authenticated the account needed to use AMR Cloud.
_Avoid_: profile badge, environment, CLI version

**AMR Environment Profile**:
The target AMR service environment a packaged runtime is configured to use.
_Avoid_: release channel, account status, app identity

**Onboarding Skip**:
The explicit path that lets a user leave onboarding without completing the currently selected setup option.
_Avoid_: continue, finish setup, passive close

**Agency Fast Lane**:
The generative-UI path that turns one client brief into a published site, app screen or dashboard in seconds: route the brief, pick a family, drop optional sections, fill the family's slots with structured model calls, check faithfulness (by default before publishing; `after` checks after, `off` skips the check and keeps every optional section), publish the project, then deploy with an honest access status.
_Avoid_: agent run, chat generation, code generation

**Build with Jev**:
The Home mode that sends the composer's text to the **Agency Fast Lane** as a **Brief** instead of starting an agent run. It has two entry points that select the same mode: Home's `jev-site` chip and the pinned "Build with Jev" row at the top of the Home model picker. While it is on, Send always starts a fast-lane build; the family is `auto`, composition is `auto`, effects are `auto`, and the daemon's default verify mode (strict) applies. The result shows the composed page's block ids, or the fallback code when the family route ran.
_Avoid_: Jev model, Jev agent

**Brief**:
The client's plain-prose description of a business or product that a fast-lane build starts from. It is the only source of facts a build may state.
_Avoid_: prompt, spec

**Shape Atlas**:
The fixed map of nine spines and their archetypes that the router classifies a brief against, with a transfer score between each pair of spines.
_Avoid_: taxonomy, category list

**Spine**:
One of the nine visitor journeys in the shape atlas: TL trust to lead, PA product adoption, CO commerce, SM search and match, CS content subscription, LM learning membership, BA booking attendance, TU task utility and MI mission impact.
_Avoid_: industry, vertical, template type

**Archetype**:
A named business pattern inside one spine, such as SM.02 directory or listings, with its own steps, sections and call to action.
_Avoid_: persona, template

**Family**:
A reviewed page design with a typed recipe schema, named slots, a trusted renderer and fixed section order. A family has one spine, one archetype and one page kind. The families are watson, fervor, wrenfield, maben, halcyon, restaurant, maren, emmpo, community, marketing-site, app-shell, crm-dashboard, listings, publication, nonprofit and docs-hub.
_Avoid_: theme, template, layout

**Page Kind**:
What a family renders: `site` (a public page that presents and sells), `app` (the main screen of a signed-in tool) or `dashboard` (a screen of numbers and status for one team). `app` and `dashboard` pages are static prototypes: navigation and controls are not wired, and the page says so.
_Avoid_: project kind, format

**Route**:
Jev's decision that assigns a brief to one family, or leaves it unrouted when no family is likely enough. The route records the spine, archetype, skin, family, probability and basis (exact, same-spine or compatible).
_Avoid_: classification, recommendation

**Fill**:
The structured model calls that write a family's text slots from the brief: one call per section by default (`sections` mode), or one call for the whole page (`single` mode). It runs on DeepSeek `deepseek-v4-flash` or Cerebras `gpt-oss-120b`, and fails over to the other provider on a rate limit, server error or timeout that comes before any output.
_Avoid_: generation, completion

**Fill-Model Key**:
The DeepSeek or Cerebras API key a daemon fills with. It resolves from the environment first, then the key stored in the daemon's agency config, then the machine's vault.
_Avoid_: Jev key, BYOK key

**Optional Section**:
A family section that a build may leave out when the brief gives it nothing true to say, such as testimonials. Jev decides keep or drop before the fill; explicit keep and drop hints win.
_Avoid_: hidden section, empty section

**Faithfulness Gate**:
Jev's check that every fact slot on a built page is supported by the brief. In strict mode nothing is published until the gate passes; a flagged slot can be repaired from the brief.
_Avoid_: lint, QA, review

**Illustrative Slot**:
A slot marked `x-mock` that holds visibly labelled sample data, such as dashboard numbers or pricing marked "Sample data" or "Illustrative pricing". The faithfulness gate skips it and a repair never rewrites it.
_Avoid_: fake data, placeholder

**Deploy Access**:
Whether a deployed link is `public`, `protected` or `unknown`. A deploy says the link is public only after the provider confirms protection is off and an anonymous request reaches the page.
_Avoid_: deploy status, ready

**GenUI Catalog**:
The owned, validated list of generative-UI effect components, each with its source, licence decision, verdict and port status. Ported components are framework-free and inlined into family pages.
_Avoid_: component library, UI kit, HyperUI

**Blocks view**:
The Catalog tab's segment for the licensed Cult UI Pro section and page rows, grouped by section
kind, each with a brand-free title and one state: Insertable, Needs adaptation, Not converted
yet, App only or Pending. `od cult list --kind section|page` prints the same rows from `GET /api/cult/catalog`.
_Avoid_: templates, block library

**Components view**:
The Catalog tab's segment for the licensed Cult UI Pro primitive and app rows, grouped by source
category, with the same states as the Blocks view. App-only rows need a live server and never
enter a static site. `od cult list --kind primitive|app` prints the same rows.
_Avoid_: component library, UI kit

**Remix into project**:
Taking one Blocks or Components row's licensed source into one of the owner's own React apps, on
this machine only, to change as he likes: an install command for `npx shadcn@latest add`, the
row's main file (`od cult show <slug>`), or `od cult add <slug...> --into <dir>`. It works for
every row, including primitives and app-only rows that never enter a static site build, and it
never publishes the source anywhere. The row is named by its **public slug** (`pricing-series-v`),
brand-free like its title; file names, the `app/(cult)/<slug>/` folder and route, and branded
export names are brand-free too. Old internal names still resolve and are never shown.
_Avoid_: copy into project, export, publish, download

**Effect Placement**:
A named spot on a family's page (`hero-title`, `hero-background`, `card-surface` and seven more)
that the family declares in its `catalog.json`, with one exact host element and a reviewed list of
**GenUI Catalog** components it allows. A build fills a placement with an explicit component id,
with Jev's choice (`auto`, the default for site families: one question per placement, `none`
always offered, confidence at least 0.75), or with nothing (`off`). At most two effects per page
and one script or background effect; the family compiler writes all the markup.
_Avoid_: effect slot, decoration, animation

**Live preview**:
The Preview action on every Blocks and Components card: a modal that renders the row live in a
sandboxed frame, on this machine only, at phone, tablet or desktop width, in light or dark when the
row has a dark theme, with the row's state and copy buttons, and the arrow keys moving through the
view. A section or page shows the converter's static page for it under the build CSP; a primitive
or app shows its own demo from the local preview harness outside the repository. A row that needs
server keys, or throws, says why it can't preview live and shows its thumbnail instead.
`od cult preview <slug>` answers the same question from `GET /api/cult/preview/:id`.
_Avoid_: demo page, sandbox, playground

**Section Catalog**:
The selectable list a build's `sectionSelection` chooses from: HyperUI blocks, the 13 families'
own sections, catalogued Cult UI Pro sections and pages, owner-authored
local-corpus prompts, and federated MotionSites prompts, each
labelled with a rights decision, an access tier and an availability (`insertable`,
`adapter-needed` or `reference-only`). The insertable rows are the three reviewed HyperUI adapters
and the reviewed Cult adapters loaded from `@mish/cult-ui-catalog`.
_Avoid_: component library, template gallery

**Block Composition**:
A build's `composition` choice. `family` (the default) fills one family's fixed recipe. `blocks`
asks Jev, in one request, for a spine, one design direction and 3 to 7 reviewed insertable blocks
from a deterministic shortlist (one hero first, one footer last when the spine has one, no section
kind twice except features), then fills and publishes them as one composed page; any Jev failure
falls back to the family route with a fixed code. `auto` composes only when the routed spine's
reviewed blocks cover a hero, a body section and a cta or footer. A composed build's family is
`composed`, it publishes only after a passing strict Jev check, and a fork replays its saved
published plan.
_Avoid_: page builder, template mix

**Section Selection**:
One reviewed section composed on top of a build's fixed family recipe — a placement (add after an
existing section, or replace an optional one) and a design direction. It never changes the
family's own recipe schema.
_Avoid_: section override, custom section

**Design Reference**:
Untrusted layout, typography and motion guidance for a section selection's own fill prompt,
fetched from a MotionSites or local-corpus catalog id (or supplied directly as text). Never a
source of factual claims, never checked by the faithfulness gate, and held in memory for one
build only — never written to a build record, a log, or an event stream.
_Avoid_: design brief, inspiration link

**AG-UI Build Stream**:
A fast-lane build's progress expressed as AG-UI protocol events: run started, steps, state snapshot and deltas, run finished or run error. It never carries the brief.
_Avoid_: build log, event feed

## Relationships

- A **Project** contains zero or more **Normal Artifacts**.
- A **Normal Artifact** has exactly one **Artifact Entry File**.
- A **Normal Artifact** has exactly one **Artifact Manifest**.
- A **Live Artifact** belongs to a **Project** but is distinct from a **Normal Artifact**.
- An **Active Project** can be used as the target for MCP operations when the caller omits an explicit **Project**.
- A **Home Composer Media Surface** maps user intent to an existing project kind and project metadata at submit time.
- The **Chip Rail** is the visible Home entry point for choosing a **Home Composer Media Surface**.
- **Essential Audio Generation** uses an **Audio Source Field** plus model options before creating an audio **Project**.
- **AMR Cloud** is the user-facing product choice; **AMR CLI** is the local execution adapter behind that capability.
- The **AMR CLI Distribution Contract** is owned separately from Mishh Mashh; Mishh Mashh release packaging consumes it instead of defining the native CLI release itself.
- The first **AMR CLI Distribution Slice** is mac arm64 only.
- **AMR Account Status** describes account readiness for **AMR Cloud**, not the environment profile or CLI installation state.
- An **AMR Environment Profile** is independent from release channel identity; a beta, preview, prerelease, or stable package can target different AMR service environments when explicitly configured.
- **Onboarding Skip** bypasses setup completion requirements that belong to the normal onboarding continue path.
- An **Agency Fast Lane** build starts from one **Brief**, takes one **Route** over the **Shape Atlas**, and uses one **Family**.
- Every **Spine** has at least one **Family**; a **Family** belongs to one **Spine**, one **Archetype** and one **Page Kind**.
- A **Route** is either routed to a **Family** or unrouted; an unrouted **Brief** builds nothing unless the caller names a **Family**.
- The **Fill** writes only the slots of the chosen **Family**, minus any dropped **Optional Section**, with a **Fill-Model Key**.
- The **Faithfulness Gate** checks fact slots only; an **Illustrative Slot** is never a fact slot.
- A published fast-lane page becomes a **Project** with a **Normal Artifact**; its deploy reports **Deploy Access**.
- A **Family** inlines **GenUI Catalog** components only at its own **Effect Placements**, and only ids that placement allows. The request or Jev picks among those ids; the fill never does, and the family compiler writes the markup.
- An **Effect Placement** decision never changes the **Faithfulness Gate** result; when Jev cannot answer, a build gets no automatic effect.
- An **AG-UI Build Stream** describes one fast-lane build and ends with exactly one terminal event.

## Example dialogue

> **Dev:** "When a coding agent creates a Codex deck through MCP, should it create a live artifact?"
> **Domain expert:** "No. Unless the user asked for refreshable data, create a **Normal Artifact**: write the **Artifact Entry File** and persist its **Artifact Manifest** in the **Active Project**."

> **Dev:** "The brief has no customer quotes. Should the fast lane write testimonials anyway?"
> **Domain expert:** "No. Testimonials are an **Optional Section**, so Jev drops them before the **Fill**. Invented quotes would also fail the **Faithfulness Gate**. Only an **Illustrative Slot** may hold sample content, and it is labelled on the page."

## Flagged ambiguities

- "artifact creation" was used to mean both **Normal Artifact** creation and **Live Artifact** creation; resolved: this capability creates **Normal Artifacts** only.
