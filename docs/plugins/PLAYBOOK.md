# Mishh Mashh plugin playbook

This playbook distills how upstream builds, validates, tests, and publishes plugins. Use
it to build ZeroSum's own plugins the same way. It is derived only from files in this
repo; every command and path below was checked against the source. Anything not checked
against a running command is marked "(not verified)".

Primary sources:

- `docs/plugins-spec.md` (the full product spec — manifest schema in section 5, folder
  shape in section 4, publishing in section 14)
- `docs/publishing-a-plugin.md`, `docs/self-hosting-a-registry.md`
- `plugins/spec/README.md`, `plugins/spec/SPEC.md`, `plugins/spec/AGENT-DEVELOPMENT.md`,
  `plugins/spec/CONTRIBUTING.md`, `plugins/spec/PUBLISHING-REGISTRIES.md`
- `plugins/_official/examples/agency-practice/` and sibling agency packages
- `plugins/_official/scenarios/od-plugin-authoring/`
- `apps/daemon/src/cli.ts`, `apps/daemon/src/plugins/`
- `.github/workflows/ci.yml` (the only workflow in this repository)
- `scripts/sync-agency-compiler.ts`
- root `AGENTS.md` (capability exposure, prompt-composition sections)

## 1. What a plugin is here

A plugin is a folder. The only required file is `SKILL.md`, which is the portable
Agent Skills contract — the same shape that Claude Code, Codex, Cursor, and other Agent
Skills-compatible tools already read. An optional sidecar file, `mish.json`,
adds the product-specific layer: marketplace card, pipeline, inputs, capabilities. A
folder with only `SKILL.md` still works as a plain skill anywhere; adding the sidecar
never makes it less portable (`plugins/spec/README.md`, "Compatibility Promise").

### Real kinds

The manifest field `od.kind` is the registry classification. It has exactly four
values, per `docs/plugins-spec.md` section 5.1:

| `od.kind` | Meaning |
| --- | --- |
| `skill` | A single reusable workflow, e.g. `plugins/spec/examples/extend-plugin-author/` |
| `scenario` | A guided, multi-stage in-app flow, e.g. `plugins/_official/scenarios/od-plugin-authoring/` |
| `atom` | A first-party pipeline building block, e.g. `plugins/_official/atoms/critique-theater/` |
| `bundle` | Multiple skills, design systems, or craft rules shipped in one repo |

Two more repo-level groupings are not `od.kind` values but are real folder categories
under `plugins/_official/`:

- **Design systems** — `plugins/_official/design-systems/neutral-product/`, a nested
  `DESIGN.md` package, not a skill.
- **Shared compiler/asset libraries** — `plugins/_official/shared/agency-compiler/` and
  `plugins/_official/shared/ui-kits/`, code that family packages import, not a
  standalone plugin.

The best worked examples in this repo are the **agency family packages** under
`plugins/_official/examples/agency-*/` (`agency-practice`, `agency-restaurant`,
`agency-storefront`, `agency-community`, `agency-marketing-site`, and seven others). Each one is `od.kind: "scenario"` and pairs a `SKILL.md`
with a **typed, trusted compiler** instead of freeform generation — see section 2.

### Anatomy of a plugin folder

From `docs/plugins-spec.md` section 4 and `plugins/spec/SPEC.md` sections 1–2:

```text
my-plugin/
  SKILL.md              # required — portable agent contract, YAML frontmatter + body
  mish.json       # optional — Mishh Mashh sidecar (marketplace card, pipeline, inputs)
  README.md              # standard readme
  preview/                # index.html / poster.png / demo.mp4 — real output, not a splash screen
  examples/               # sample outputs, one per case
  assets/                 # files staged into the project working directory at run time
  references/             # long API/visual-rule notes SKILL.md links to instead of inlining
  evals/                  # evals.json, trigger-queries.json — regression checks
```

`SKILL.md` frontmatter minimum (`plugins/spec/SPEC.md` section 1):

```yaml
---
name: my-plugin
description: Use this plugin when the user wants...
---
```

The folder name, the frontmatter `name`, and the manifest `name` must match: lowercase
letters, numbers, and hyphens only.

`mish.json` required fields (`plugins/spec/SPEC.md` section 6): `name`,
`specVersion` (the plugin spec version this manifest follows, currently `1.0.0`),
`version` (the plugin's own semver, bumped on any behavior change),
`compat.agentSkills[0].path` pointing at `./SKILL.md`, and — for a scenario/skill that
generates — `od.taskKind`, one of `new-generation`, `figma-migration`, `code-migration`,
or `tune-collab`.

A minimal real example that shows the smallest enriched shape is
`plugins/_official/scenarios/od-plugin-authoring/`: two files, `SKILL.md` and
`mish.json`, no assets. Read it before building anything more complex.

## 2. Building a plugin, step by step

### 2.1 Create the folder

Two paths, both real:

1. **Scaffold command** (verified in `apps/daemon/src/cli.ts`, function
   `runPluginScaffold`):

   ```bash
   od plugin scaffold --id my-plugin \
     --title "My Plugin" \
     --description "One sentence marketplace description." \
     --task-kind new-generation \
     --out ./plugins/community
   ```

   This writes `<out>/<id>/{SKILL.md,mish.json,README.md}`. `--with-claude-plugin`
   also adds `.claude-plugin/plugin.json` compatibility scaffolding.

2. **Copy from template**, for a fully manual start:

   ```bash
   cp -r plugins/spec/templates/ ./plugins/community/my-plugin/
   ```

   `plugins/spec/templates/` holds `SKILL.template.md`, `mish.template.json`,
   `README.template.md`, and `evals.template.json`.

Either way, rename the folder and the frontmatter `name` to the same lowercase id.

### 2.2 Author it

- Write the `SKILL.md` description for activation: "Use this plugin when..." — this is
  literally what triggers it.
- Keep `SKILL.md` under 500 lines. Move long API notes, visual rules, or exporter
  details into `references/`.
- Never put marketplace-only data (tags, preview config) in `SKILL.md`; that belongs in
  `mish.json` only. Keep the skill body portable.
- Pick one workflow lane (`import`, `create`, `export`, `share`, `deploy`, `refine`,
  `extend`) from `plugins/spec/SPEC.md` section 3, and record it in `tags` and
  `od.scenario`/`od.mode`.
- If the plugin generates, add `od.pipeline.stages[]` — an ordered list of atom ids.
  Use known first-party atoms from `plugins/_official/atoms/` (`critique-theater`,
  `discovery-question-form`, `todo-write`, `file-write`, `direction-picker`,
  `figma-extract`, `code-import`, `design-extract`, `token-map`, `rewrite-plan`,
  `patch-edit`, `diff-review`, `handoff`, `build-test`) unless you are clearly targeting
  future work. A repeated stage needs an `until` condition, e.g.
  `"critique.score>=4 || iterations>=3"`.
- Start capabilities minimal. `prompt:inject` is always allowed; add `fs:write`,
  `fs:read`, `network`, `mcp`, `subprocess`/`bash`, or `connector`/`connector:<id>` only
  when the plugin genuinely needs them (`docs/plugins-spec.md` section 5.3). `bash` and
  `subprocess` are elevated — do not pre-select them in a "grant all" path.

### 2.3 Validate it

Exact commands, verified against `apps/daemon/src/cli.ts`:

```bash
od plugin validate ./plugins/community/my-plugin          # manifest shape, atom ids, until exprs
od plugin validate ./plugins/community/my-plugin --no-daemon   # skip live-registry ref checks
od plugin pack ./plugins/community/my-plugin               # builds the install-ready .tgz
```

`od plugin validate` exits `0` when the doctor passes, `4` when it finds errors, `2` on
a CLI usage error. It checks the manifest against the daemon's live skill/design-system/
atom registry unless `--no-daemon` is set, in which case unresolved refs become warnings
instead of errors.

Repo-wide checks, from `plugins/spec/SPEC.md` section 10 and root `package.json`:

```bash
pnpm guard
pnpm --filter @mish/daemon typecheck
pnpm --filter @mish/plugin-runtime typecheck
```

`@mish/plugin-runtime` (`packages/plugin-runtime`), cited in `plugins/spec/SPEC.md`
and `plugins/spec/AGENT-DEVELOPMENT.md`, is a workspace package with its own
`typecheck` script.

### 2.4 Test it locally in the running app

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 17573   # start the local daemon+web
od plugin install ./plugins/community/my-plugin               # installs from a local folder
```

`od plugin install` (verified, `runPluginInstall` in `apps/daemon/src/cli.ts`) accepts a
local folder path, a `github:owner/repo[@ref][/subpath]` reference, a tarball URL, or a
marketplace name. Installing a local folder streams progress over SSE and puts the
plugin where the running app's marketplace/composer surfaces can pick it up — open the
web UI to click it, or drive it headlessly through `od project create` /
`od run start` (both are real subcommands in `SUBCOMMAND_MAP`, but exact flags were not
re-verified here — **(not verified)** for the precise flag list).

For a visual plugin, `apps/daemon/src/plugins/plugin-preview-bakes.ts` plus
`.github/actions/bake-previews/` render the declared `od.preview.entry` and check it
loads as `200 text/html`; `plugins/spec/AGENT-DEVELOPMENT.md` calls a preview-baker
`404` a failure for that plugin even when the overall bake job stays green. No workflow
in this repository calls that action today, so the bake does not run on pull requests.

### 2.5 The quality bar the best official plugins meet

Observed directly in `plugins/_official/examples/agency-practice/` and its siblings:

| Pattern | What it looks like | Where |
| --- | --- | --- |
| Typed slots, not freeform markup | A JSON `recipe.json` with fixed `schemaVersion`, fixed section IDs, plain-text/color/asset-id slots only — no HTML/CSS/JS | `families/practice/recipe.json` |
| A trusted compiler | A dedicated `compose.ts` that renders the validated recipe into HTML; the model fills slots and never writes markup | `compiler/scripts/compose.ts`, `SKILL.md` |
| `approved-assets.json` | An integrity-checked asset roster, not a loose folder (empty for packages that ship no media) | `families/practice/approved-assets.json` |
| `publishedAt` stamps | ISO 8601 timestamp of first publish, required for bundled first-party plugins and enforced by a test | `mish.json`, `e2e/tests/plugin-published-at.test.ts` (per `docs/plugins-spec.md` §5.1) |
| i18n in `en` and other locales | `title_i18n` / `description_i18n` maps, e.g. 17 locales on `od-plugin-authoring` | `plugins/_official/scenarios/od-plugin-authoring/mish.json` |
| Rights and provenance recorded | A README "Rights and provenance" section | `plugins/_official/examples/agency-practice/README.md` |
| Reproducible test command | The exact command that runs the family's render tests, checked into the README | `plugins/_official/examples/agency-practice/README.md` ("Test") |

Product note: the product's only locale is English (owner decision 2026-10-10) — see the
`apps/web/AGENTS.md` i18n-keys rule — so `title_i18n`/`description_i18n` only strictly need
`en` for anything ZeroSum ships; upstream examples carry more locales because
they target a wider install base.

The **compiler-per-family duplication is deliberate but centrally synced**: thirteen
copies of one compiler exist (twelve family packages plus the template) because a packed/installed plugin cannot import a shared
workspace package. `scripts/sync-agency-compiler.ts` fans the canonical copy at
`plugins/_official/shared/agency-compiler/scripts/` out to every family package and to
`design-templates/agency-site/scripts/`, and its `--check` mode is the CI gate. If
ZeroSum builds a compiler-backed family plugin, copy this pattern rather than hand-diverging.

## 3. Publishing

### 3.1 How upstream publishes

Upstream's registry model, from `docs/publishing-a-plugin.md` and
`docs/self-hosting-a-registry.md`:

1. **Scaffold** with `od plugin scaffold`.
2. **Validate and pack**: `od plugin validate <folder> --no-daemon`, then
   `od plugin pack <folder>`.
3. **Authenticate**: `od plugin login` / `od plugin whoami --json` (both wrap the `gh`
   CLI; tokens stay in `gh`, never in the product).
4. **Publish**: `od plugin publish <pluginId> --to <catalog> --repo <github-url>`. The
   catalogs a real `--to` value accepts, verified in `runPluginPublish`, are
   `mish`, `anthropics-skills`, `awesome-agent-skills`, `clawhub`, `skills-sh`, or
   `marketplace-json` (with `--catalog <path>`). This opens a GitHub PR review flow; CI
   regenerates `mish-marketplace.json` after merge.
5. **Install from the registry**: `od marketplace refresh official`, then
   `od plugin install <pluginId>`.
6. **Yank a bad version**: `od plugin yank <pluginId>@<version> --reason "..."` — this
   never deletes bytes, it only blocks new installs of that version.

A self-hosted registry is just a static JSON file plus review process
(`plugins/registry/official/mish-marketplace.json` is the shipped example) served
over HTTPS; the daemon rejects an HTML tree page and requires the raw JSON URL.

Two more real CLI paths matter for the "publish to our own repo" question:

- `od plugin publish-repo <folder>` creates or updates a public GitHub repo named by the
  plugin's manifest — a standalone-repo publish, independent of any registry.
- `od plugin mish-pr <folder>` copies the plugin into
  `plugins/community/<name>/` on a new branch and opens a PR against the public catalog
  repository, `ZeroSum-Solutions/mish`. Unless the resolved owner is that organization, it
  forks the catalog under the owner (the author's login, or the `--owner` org) with
  `gh repo fork` and pushes the branch there; passing `--owner ZeroSum-Solutions`
  pushes to the catalog repository directly.
  `od plugin publish --to mish` and `od plugin yank` open issues on the same
  repository. All three read `MISHH_MASHH_PLUGIN_REPO` in
  `apps/daemon/src/plugins/catalog-repo.ts`.

### 3.2 What this means for ZeroSum

We publish to one place only: our own public repo,
`ZeroSum-Solutions/mish`. There is no external registry, no `skills.sh`
listing, no ClawHub submission, unless a future decision changes that.

**Recommended ZeroSum flow**, built from verified primitives above:

1. Scaffold or copy-from-template into `plugins/_official/<plugin-id>/` directly (or
   `plugins/community/<plugin-id>/` for anything not yet production-grade — note this
   folder does not exist in the checkout yet; create it on first use).
2. Author, then validate locally: `od plugin validate <folder>`, `pnpm guard`.
3. Open a normal PR against our own default branch. `.github/workflows/ci.yml` is the
   only workflow in this repository; among its jobs, `agency_tests` runs the agency
   family compiler render tests directly:
   `node --experimental-strip-types --test
   plugins/_official/examples/agency-*/compiler/scripts/families/*/render.test.ts`.
   No workflow here exports or schema-checks the catalog or bakes plugin previews on a
   PR; run `od plugin validate` locally for those.
4. Merge only with CI green — this is the "PR with green CI" gate the goal asked for.
5. No workflow in this repository publishes the merged catalog anywhere, so merging a
   plugin PR does **not** auto-publish anything — it only lands the plugin in-repo.
   That is fine for local/desktop use through `od plugin install ./plugins/_official/<id>`;
   a published catalog snapshot would need a ZeroSum-owned publish job.
6. The in-app registry (`od marketplace`) and the bundled plugin sources point at our
   repository. `marketplaceRegistryRepo()` in `apps/daemon/src/plugins/marketplaces.ts`
   defaults to `MISHH_MASHH_PLUGIN_REPO`, and `OD_MARKETPLACE_REPO`,
   `OD_MARKETPLACE_REPO_REF` and `OD_MARKETPLACE_REGISTRY_PATH` still override it.
   `OFFICIAL_PLUGIN_SOURCE_REPO` in `marketplace-seed.ts` and the `source` fields in
   `plugins/registry/official/mish-marketplace.json` use
   `github:ZeroSum-Solutions/mish@main`. The official registry is read from the
   local `plugins/registry/` folder.

## 4. Checklist for a new Mishh Mashh plugin

1. Choose the lane (`import`/`create`/`export`/`share`/`deploy`/`refine`/`extend`) and
   the `od.kind` (`skill` for a single workflow, `scenario` for a guided multi-stage
   flow).
2. Scaffold: `od plugin scaffold --id <id> --title "<title>" --task-kind <kind> --out
   plugins/_official`, or copy `plugins/spec/templates/`.
3. Write `SKILL.md` with an activation-style description, under 500 lines, portable
   (no marketplace-only data in the body).
4. Fill `mish.json`: `name`, `specVersion`, `version`, `compat.agentSkills`,
   `od.taskKind`, `od.mode`, `od.pipeline` or `od.context.atoms`, minimal
   `od.capabilities`, `title_i18n`/`description_i18n` for `en`, and a
   `publishedAt` stamp.
5. Add `preview/` or `examples/` showing the real output shape if the plugin is visual.
6. Add `evals/evals.json` once the plugin has enough behavior to regress.
7. Validate: `od plugin validate <folder>`, `pnpm guard`.
8. Install locally and click through it: `od plugin install ./<folder>` against a
   running `pnpm tools-dev` daemon.
9. Open a PR into our own repo and confirm `ci.yml` passes before merge.
10. After merge, remember: nothing auto-publishes from this repository today (see 3.2, point 5).
    If the plugin needs to be discoverable outside this repo, that is a separate,
    explicit decision.

## 5. Gotchas

- **The full publish story spans two docs that disagree slightly on maturity.**
  `docs/plugins-spec.md` section 14 and its phased plan (section 16) describe some
  commands — `od daemon start --headless`, `od project create --inputs ...`,
  `od run start --agent claude --follow` — as part of a "Phase 4" / concrete headless
  pipeline. `daemon`, `project`, and `run` are real top-level subcommands in
  `apps/daemon/src/cli.ts`'s `SUBCOMMAND_MAP`, but their exact flags were not
  individually re-verified for this playbook — treat that specific pipeline as
  **(not verified)** and re-check flags with `od <subcommand> --help` before scripting
  against it.
- **One constant owns the publish target.** `MISHH_MASHH_PLUGIN_REPO` in
  `apps/daemon/src/plugins/catalog-repo.ts` feeds the PR flow, the publish and yank issue
  links, and the default marketplace. Change the repository name there, then update the
  `source` fields in `plugins/registry/official/mish-marketplace.json` and the
  URL prefix in `tools/release/src/catalog/{export,validate}.ts`.
- **Nothing publishes the catalog.** This repository has no catalog publish workflow,
  so our merges never populate any catalog snapshot until we add our own publish job.
- **`plugins/community/` does not exist in this checkout.** Several docs
  (`docs/publishing-a-plugin.md`, `plugins/spec/PUBLISHING-REGISTRIES.md`) assume it as
  the default scaffold/PR target. `plugins/_official/` is the only populated plugin root
  today; create `plugins/community/` deliberately if we want that separation, don't
  assume it is already there.
- **The compiler-per-family pattern is intentional duplication, not drift.** Thirteen
  identical copies of the agency compiler exist because a packed, installed plugin
  cannot `import` a shared workspace package at runtime. Don't try to deduplicate them
  by hand; `scripts/sync-agency-compiler.ts` is the only supported way to keep them
  synced, and its `--check` mode is what CI runs.
- **`docs/FORK-PIN.md` records the remotes.** `origin` is the public
  `ZeroSum-Solutions/mish`, the same repository `MISHH_MASHH_PLUGIN_REPO` names. Confirm
  the live remote before wiring publish automation.
- **A preview 404 fails the plugin even when the overall bake job is green.**
  `plugins/spec/AGENT-DEVELOPMENT.md`'s quality bar states this explicitly; it is easy
  to miss in a bake log that otherwise reports success.
