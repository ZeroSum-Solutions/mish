# Packs

Two kinds of pack exist. Pick by what you need to hand over.

| | Mish pack (team packet) | Licensed pack |
|---|---|---|
| Use it for | Restoring everything the public repository does not carry: catalogues, kits, design systems, skills, studies, assets, service settings and MCP connections | Component kits you hold a licence for, with a per-file digest list |
| Shape | A folder or `.zip` with `mish-pack.json` | A folder, `.tgz` or GitHub repository with `pack.json` |
| Install | Settings → Packs, `od packs install`, or `MISH_PACKS_DIR` | Settings → Licensed packs or `od pack install` |
| Checked by | Size and path limits, safe-path rules, a strict manifest | A sha256 for the archive or folder, and a sha256 for every file |

Nothing in either kind lives in this repository. The public build runs without
a pack and shows the features that need one as unavailable.

## Mish packs: a team packet

A Mish pack is a private `.zip` you give your team. They install it once and
the app behaves like the private build. Remove it and the app goes back to the
public build. While no pack is installed, nothing changes.

A team packet can be one pack, or several smaller packs built with `--split`
(catalogues, design systems, studies, skills, saved projects, design index).
Each installs and removes on its own.

### What a pack looks like

```text
team-packet/
  mish-pack.json
  catalogs/
    cult-kit/                 the licensed component kit
    cult-catalog/             catalog.json and generated/ (slugs, names, thumbnails, previews)
    cult-adapters/index.mjs   prebuilt section adapters
    genui/                    overlay.json and demos/<id>.html
    sections.json             extra section catalogue rows
    twenty-first/             21st thumbnails
  design-systems/<id>/        design system packages
  studies/<id>/               study packages
  skills/<id>/SKILL.md        skills
  projects/projects.json      saved project rows
  projects/<id>/              saved project folders
  design-index/index.json     stored design-index profiles
  assets/pets/<id>/           pets
  assets/prompt-templates/    image/ and video/ prompt templates
  assets/style-catalog/       style picker preview images
```

`mish-pack.json` lists only what the pack provides. Every path is relative to
the pack root:

```json
{
  "schemaVersion": 1,
  "id": "team-packet",
  "name": "Team packet",
  "version": "2026.10.12",
  "provides": {
    "catalogs": {
      "cultKit": "catalogs/cult-kit",
      "cultCatalog": "catalogs/cult-catalog",
      "cultAdapters": "catalogs/cult-adapters/index.mjs",
      "genui": "catalogs/genui",
      "sections": "catalogs/sections.json",
      "twentyFirst": "catalogs/twenty-first"
    },
    "designSystems": "design-systems",
    "skills": "skills",
    "studies": "studies",
    "projects": "projects",
    "designIndex": "design-index",
    "assets": { "pets": "assets/pets", "promptTemplates": "assets/prompt-templates", "styleCatalog": "assets/style-catalog" },
    "env": { "MISH_AMR_CONSOLE_URL": "https://console.example.test" },
    "mcpServers": [
      { "id": "refero", "transport": "http", "url": "https://api.example.test/mcp", "authMode": "oauth" },
      { "id": "shadcn", "transport": "stdio", "command": "npx", "args": ["-y", "shadcn@latest", "mcp"],
        "env": { "REGISTRY_TOKEN": "${REGISTRY_TOKEN}" }, "enabled": false }
    ]
  }
}
```

The manifest is strict. An unknown key, a path that is absolute or contains
`..`, `.` or a backslash, or a server that carries a credential is refused, and
nothing is installed. The schema is `mishPackManifestSchema` in
`packages/contracts/src/api/mish-packs.ts`.

### What each key does

| Key | Effect |
|---|---|
| `catalogs.cultKit` | Folder with `manifest.json`. The Cult routes, previews and section previews read the kit from the pack. `CULT_KIT_DIR` still wins when it is set. |
| `catalogs.cultCatalog` | Folder shaped like the catalogue package (`catalog.json`, `catalog-curation.json`, `catalog-copy-refinements.json`, `generated/…`). Replaces the empty bundled catalogue, public names and thumbnails. |
| `catalogs.cultAdapters` | A prebuilt ES module that exports `CULT_ADAPTERS`. Its adapters are added to the agency fast lane. |
| `catalogs.genui` | `overlay.json` with `entries` (or `components`) and `demos/<id>.html`. Rows are added after the bundled ones. |
| `catalogs.sections` | A file with `entries`. Rows are added to the section catalogue; a bundled row is never replaced. |
| `catalogs.twentyFirst` | `21st-thumbnails.json` and `21st-thumbnails/`. Fills thumbnails the bundle lacks. |
| `designSystems`, `studies`, `skills` | Each child folder is copied into the user design-systems or skills folder of the data directory. A folder you already have is left as it is and reported. |
| `projects` | `projects.json` lists project rows (`mish-pack-projects/1`: id, name, skill, design system, prompt, metadata, instructions, times) and `<id>/` holds each project's files. Each is copied into the projects folder under its own id and added to the project list. A project id you already have is left as it is and reported. A row may have no folder: it is a project with no files. A row that points at a folder outside the pack (`baseDir`) is not added; links to folders on another computer (`linkedDirs`) are dropped. |
| `designIndex` | A folder with `index.json` (`design-index/1`). Its profiles are listed in the Design index and on Home next to your own, read from the pack; your own profile wins when both have the same digest. They are never written into your index and cannot be deleted from it. |
| `assets.pets`, `assets.promptTemplates` | Scanned next to the bundled pets and prompt templates. |
| `assets.styleCatalog` | Images served for the style picker at `/api/mish-packs/assets/style-catalog/v1/`. |
| `env` | Sets allow-listed service settings (below). |
| `mcpServers` | Merged into the MCP server list (below). |

Everything except the copied folders and projects is read from the pack in
place, per request. An install or removal takes effect without a restart.

### Saved projects

The design-system previews on the Design systems page are projects too: a
design system names its preview project (`ds-<slug>`), so a pack keeps every
project's original id. On remove, or when a new version replaces it, a project
the pack added is:

- deleted when it is exactly as the pack placed it;
- moved to `.mish-pack-backups/<pack>-<time>/<id>` in the projects folder when
  only its files changed;
- kept, as your own project, when you renamed it, chatted in it or moved it
  into a workspace. The result says which projects were kept.

### Install

```bash
od packs install ~/Downloads/team-packet.zip
od packs list
od packs remove team-packet
```

In the app: Settings → Packs → Choose a .zip…, or enter the path of a pack
`.zip` or folder on this computer. The list shows what each pack provides, and
which environment variables its MCP servers still need.

Installing a pack with the same id replaces it. The install is staged and
checked first; a pack that fails a check installs nothing.

A replacement can be undone. The installed version's pack folder, its copied
folders and projects, and the MCP entries and project rows it added are set
aside, not deleted, until the new version is active. If the new version fails
to activate, it is taken out again and the old version is put back as it was.
If the app stops during an install, the next start finishes that rollback.

#### Large packets

A `.zip` is read as a stream, one file at a time, so a packet of several
gigabytes never sits in memory. To skip the extra copy, unzip the packet and
install the folder instead: `od packs install ~/Downloads/team-projects-1`, or
enter that folder's path in Settings -> Packs. For a packet of several
gigabytes, enter the path; do not upload it through the file picker.

To load packs without installing them, set `MISH_PACKS_DIR` to a folder that
holds pack folders (or one pack folder) before the app starts. They load at
start, are read only, and cannot be removed from the app.

### MCP servers and secrets

On install, each pack server whose id is free is added to the MCP server list
(the MCP servers list in Settings). A server you already have with the same id is left
alone. On remove, only the servers the pack added are removed, and only if you
have not edited them.

A pack never holds a secret. Write `${NAME}` where a value belongs in a server's
`env`, `headers` or `args`; the daemon replaces it with the value of `NAME` from
its own environment each time it starts an agent. The saved file keeps the
placeholder. Set `NAME` in the shell or launcher that starts the app. A name
that is not set stays as written, and the Packs list names it.

Sign-in for servers with `"authMode": "oauth"` happens per person, in the app. A
pack cannot carry tokens, and the builder refuses a literal that looks like one.

### Service settings

A pack can set only these keys. A value already in the daemon environment wins,
and removing the pack takes its values away again.

| Pack key | Becomes | Value |
|---|---|---|
| `MISH_AMR_CONSOLE_URL` | `MISH_AMR_CONSOLE_URL` | https URL (http on loopback) |
| `MISH_AMR_ANALYTICS_URL` | `MISH_AMR_ANALYTICS_URL` | https URL |
| `MISH_AMR_PROFILE` | `MISH_AMR_PROFILE` | short lowercase name |
| `MISH_VELA_WEB_URL` | `OD_VELA_WEB_URL` | https URL |
| `MISH_VELA_WEB_URLS` | `OD_VELA_WEB_URLS` | JSON object of name to https URL |
| `MISH_STYLE_PREVIEW_ORIGIN` | `MISH_STYLE_PREVIEW_ORIGIN` | https URL that serves `/style-catalog/v1/…` |

### Limits and safety

- Archive up to 12 GiB, 24 GiB extracted, 200,000 files, 2 GiB per file. They
  are enforced while bytes are written, and each file must have the size its
  archive entry declares.
- Links, devices and every non-regular entry are refused. So are absolute
  paths, `..`, backslashes, drive letters, control characters and two names that
  differ only by letter case. `__MACOSX`, `.DS_Store` and `.git` are skipped.
- The install route answers this computer only, refuses a browser write from
  another site, and needs a custom header for a file upload.
- A pack runs no code at install. A prebuilt adapter module is loaded by the
  fast lane when a build uses it, so install packs only from people you trust.

### Build a pack

`scripts/build-pack.mjs` assembles a pack from a private checkout. It only
reads the checkout. What goes in is decided by a mapping file:
`scripts/pack-map.json` lists paths, never content.

```bash
node scripts/build-pack.mjs ../private-checkout ~/Desktop/team-packet.zip --dry-run
node scripts/build-pack.mjs ../private-checkout ~/Desktop/team-packet.zip --version 2026.10.12
node scripts/build-pack.mjs ../private-checkout ~/Desktop/team-packs --split
```

- Each map resource names a `provides` key, a `type` (`dir`, `files`,
  `children`, `bundle`, `genui-overlay`, `catalog-delta` or `projects`), where
  it lands in the pack (`to`), and where it comes from in the checkout.
  `optional: false` makes a missing source an error.
- `projects` takes the projects folder (`from`) and the app database
  (`database`). Each project folder with a database row is packed with its row.
  The database is copied to a temporary folder and opened read-only there, so
  nothing is written next to the checkout. A project whose files live outside
  the checkout is left out and reported.
- `--split` builds one pack per `module` of the map (each resource names its
  module; `modules` lists them, and the module marked `env` / `mcpServers`
  carries those). A module larger than `--max-bytes` (1.5 GiB by default,
  counted before compression, so each file fits a GitHub release asset) is cut
  into numbered parts (`team-projects-1`, `team-projects-2`, ...) along whole
  design systems and projects. The output folder gets `<id>-<version>.zip` for
  each pack, `SHA256SUMS` (check with `shasum -a 256 -c SHA256SUMS`) and
  `inventory.json` (`mish-pack-inventory/1`: id, version, file, bytes, sha256,
  resources).
- `bundle` compiles a TypeScript adapter registry into the prebuilt module a
  pack carries. `genui-overlay` takes the catalogue rows of one licensed source
  and the demo documents. `catalog-delta` keeps the rows the public catalogue
  does not have.
- Keep a map with real private names outside this repository and pass it with
  `--map`. The committed map is a template.
- The builder leaves out links, `node_modules`, credential-looking files
  (`.env`, `mcp-tokens.json`, `.mcp.json` and other MCP client configs,
  `settings.local.json`, `auth.json`, key files) and names the daemon would
  refuse, and prints what it left out. It validates the manifest with the
  daemon's schema before it writes anything, never writes inside the checkout
  or this repository, and builds the same bytes from the same input.
- Text files that contain something shaped like a credential (a bearer token,
  a JWT, an `sk-` or `ghp_` key) are packed but named in the report. Captured
  pages carry look-alikes, so the builder does not drop them; check each one
  before you share the pack.
- Give the `.zip` to the team over a private channel. Do not commit it.

### What a Mish pack does not do

- Plugins and agency family packages. Ship plugins in a licensed pack
  (`plugins` content, below).
- It does not carry OAuth tokens or API keys. Teammates sign in and set their
  own variables.
- It does not carry conversations. A saved project arrives with its files and
  settings, without its chat history.
- It does not install plugins, so agency family generators (the website cards
  on Home) are not restored by a Mish pack.

## Licensed packs

A licensed pack is a folder of your own components plus a `pack.json` that
lists every file. You install it on your computer from Settings → Licensed
packs or with `od pack`. Both use the same daemon routes, so they always show
the same list.

## Where packs live

The daemon copies an installed licensed pack to `<RUNTIME_DATA_DIR>/packs/<id>/`,
under its own data root (see "Daemon data directory contract" in `AGENTS.md`).
Mish packs install to `<RUNTIME_DATA_DIR>/mish-packs/<id>/`. Do not edit files
in either folder, and never commit a pack to this repository. `pnpm guard` does
not look for pack files; run `pnpm exec tsx scripts/check-licensed-pack-content.ts`
to check a tree on demand (it only warns). Keep your pack in its own folder,
`.zip`, `.tgz` file or private GitHub repository.

## Read the component ledger

In Settings → Licensed packs, the read-only Component ledger shows the
same report. Filter by source, licence or status and click Refresh after
installing or removing a pack.

Run `od components ledger --json` with the daemon running. The read-only
`GET /api/components/ledger` route returns the same generated report. Its
`components` object uses component IDs as keys and combines the committed
public-core ledger with the live installed-pack inventory. Removing a pack
removes its rows on the next read. `--core-only` reads the committed core
ledger offline and deliberately excludes installed packs.

Without `--json`, the CLI prints tab-separated ID, source, licence, build
status, installation status, verification status and errors columns. Pack
licences retain the `licensed (pack-declared)` label. The errors column
names each duplicate as `duplicate-id (<packId>)`, separated by semicolons;
rows without errors have an empty final column.

Each entry reports source, rights, licensed, built, tracked, installed,
repair disposition, verified and evidenceDate. Built means implementation
bytes exist; tracked means the inventory names the ID. Core rows have
`installed: null`; pack rows have `source: "pack"`, `packId` and
`installed: true`. Pack rows label their licence `licensed (pack-declared)`;
this records the pack manifest claim. Licence and installation flags do not
certify repairs.
Verified requires a built, repaired row with dated evidence bound to its
current source digest. Undated historical evidence stays visible with
`verified: false` and `evidenceDate: null`.

The public-core generator reads GenUI, HyperUI/family sections, owned 21st
alternatives, selected shadcn, React95 and both GSAP recipe formats from
their existing metadata. Regenerate it with
`pnpm exec tsx apps/daemon/scripts/r13-component-ledger.ts --write`.
The same script with `--check`, and the daemon ledger tests in CI, reject
missing IDs, orphan IDs, source/cohort drift and missing cited rights files. Regeneration preserves
curated fields only while their source version stays unchanged.

Pack component kits expose individual JSON registry items with names
and inline source files. Cult catalogs provide `rows` in `catalog.json`;
GenUI overlays provide `components`. A catalog content path may name that
JSON file directly or its containing directory. Metadata must be listed
in the pack manifest, contained in the pack and match its recorded digest.
Missing or changed metadata fails the read instead of silently omitting
components. Conflicting IDs retain the first row and attach an `errors`
entry with `code: "duplicate-id"` for each conflicting `packId`, including
the retained provider when it is a pack. The report still returns HTTP 200
and other rows remain readable. A row with a conflict cannot claim verification. An exact
licensed GenUI overlay uses the same normalized digest as core, so it can
report the installed pack without inventing a new identity. Installed pack entries start unverified. This report
does not close the R13 state, preview or adoption acceptance criteria.

## Write `pack.json`

Put `pack.json` at the top of the pack folder:

```text
team-kit/
  pack.json
  components/button.tsx
  components/card.tsx
```

```json
{
  "format": "mishh-pack@1",
  "id": "team-kit",
  "version": "1.0.0",
  "title": "Team kit",
  "licence": { "scope": "Internal team use", "evidence": [] },
  "contents": [
    { "kind": "component-kit", "schema": "od-cult-kit/1", "id": "team-kit", "path": "components" }
  ],
  "files": [
    { "path": "components/button.tsx", "bytes": 120, "sha256": "<sha256 of the file>" },
    { "path": "components/card.tsx", "bytes": 127, "sha256": "<sha256 of the file>" }
  ]
}
```

- `id`: lowercase letters, digits and `-`. `version`: `major.minor.patch` with
  no leading zeros.
- `files[]` lists every file except `pack.json`, with its size in bytes and
  its sha256 (`wc -c < file` and `shasum -a 256 file`).
- `contents[].kind` is one of `component-kit` (`od-cult-kit/1`),
  `cult-catalog` (`od-cult-pack/1`), `genui-overlay` (`od-genui-overlay/1`) or
  `plugins` (`od-plugin-dir/1`). Its `path` must be a listed file or a folder
  that holds listed files.
- The full schema is `packManifestJsonSchema` in
  `packages/contracts/src/api/packs.ts`.

## Get the sha256

Every folder and `.tgz` install needs a sha256. A missing or wrong value
installs nothing. `od pack digest` prints it and does not need the daemon:

```bash
od pack digest team-kit                    # folder: the digest of pack.json
od pack digest team-kit-1.0.0.tgz          # archive: the sha256 of the file
```

For a folder, the value is not `shasum pack.json`: it is the digest of the
parsed `pack.json`. `od pack digest` also checks every `files[]` entry and
names each file that does not match, so fix `pack.json` until it prints a
digest.

For a `.tgz`, you can save the value beside the archive. Then the install
finds it without `--sha256`:

```bash
tar czf team-kit-1.0.0.tgz team-kit
od pack digest team-kit-1.0.0.tgz > team-kit-1.0.0.tgz.sha256
```

## Install

From the terminal:

```bash
od pack install team-kit --sha256 "$(od pack digest team-kit)"
od pack install team-kit-1.0.0.tgz         # uses team-kit-1.0.0.tgz.sha256
od pack install team-kit-1.0.0.tgz --sha256 "<hex>"
```

From the app: open Settings → Licensed packs, enter the SHA-256, then either
type the full path of the folder or `.tgz` in Source and click Install, or
click Install from file… and pick the `.tgz`.

Installing the same version again does nothing. A newer version upgrades. To
replace the same version with other files, or to go back to an older
version, add `--force` (in the app: select "Replace the same or a newer
version").

## List and remove

```bash
od pack list
od pack list --json
od pack remove team-kit
```

In the app, the Installed packs list shows the same packs and status. Click
Remove to remove one.

## Plugins in a pack

A pack can carry plugins. Put each plugin in its own folder under one
`plugins` entry, named by its plugin id, and list the ids:

```text
team-kit/
  pack.json
  plugins/brief-writer/mish.json
  plugins/brief-writer/SKILL.md
  plugins/deck-helper/mish.json
```

```json
"contents": [
  { "kind": "plugins", "schema": "od-plugin-dir/1", "path": "plugins", "ids": ["brief-writer", "deck-helper"] }
],
```

List every plugin file in `files[]` like any other file. The `name` in each
plugin's `mish.json` must equal the folder id.

- **Install:** the daemon checks each plugin file against its sha256, then
  registers the plugin through the normal plugin installer. The plugin then
  shows wherever plugins are listed: `od plugin list` prints
  `source=pack:team-kit@1.0.0`, and the plugin details in the app show
  "Licensed pack · team-kit@1.0.0".
- **Trust:** plugins from a pack installed from a folder or `.tgz` start
  trusted, like a plugin installed from a local folder. Plugins from a
  GitHub pack start restricted, like a plugin installed from GitHub; grant
  trust with `od plugin trust`. An upgrade, or the same version from the
  other kind of source, starts again from that default; reinstalling the
  same version from the same source keeps your grants. The daemon checks
  each plugin's files against `pack.json` before it registers them, but a
  program running as your user can change any installed plugin folder
  afterwards, so treat your account as the trust boundary.
- **Same id as a plugin you already have:** the pack never replaces it. That
  one plugin is skipped with a warning in the install result; the other
  plugins install.
- **Changed files:** a plugin whose files no longer match `pack.json` is not
  registered, and the pack shows as degraded. Install the pack again to
  repair it.
- **Upgrade:** the new version registers its plugins, updates the ones both
  versions have, and removes the ones it no longer lists. Installing the same
  version again repairs a deleted or changed plugin folder.
- **Remove:** `od pack remove team-kit` (or Remove in the app) unregisters
  every plugin the pack registered, even when its `pack.json` is damaged.
  Your own plugins stay. If a plugin folder cannot be deleted, the pack stays
  installed; remove it again.

## Install from a private GitHub repository

Put `pack.json` at the repository root and tag each release `pack@<version>`,
with the same version as `pack.json`. A GitHub install needs no sha256.

```bash
od pack install github:owner/repo@1.0.0    # tag pack@1.0.0
```

Without `@version`, the install takes the highest `pack@` tag.

The daemon reads the repository with your `gh` login or `GH_TOKEN` /
`GITHUB_TOKEN`. To use another token, store a fine-grained token that can
read only that repository:

```bash
gh auth token --hostname github.com | od pack auth set --stdin
od pack auth status
od pack auth clear
```

The token is read from stdin only, never from the command line. In the app,
paste it under GitHub access in Settings → Licensed packs.
