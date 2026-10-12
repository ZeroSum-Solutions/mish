# Drop in your own components (packs)

A pack is a folder of your own components plus a `pack.json` that lists every
file. You install it on your computer from Settings → Licensed packs or with
`od pack`. Both use the same daemon routes, so they always show the same list.

## Where packs live

The daemon copies an installed pack to `<RUNTIME_DATA_DIR>/packs/<id>/`, under
its own data root (see "Daemon data directory contract" in `AGENTS.md`). Do not
edit files there, and never commit a pack to this repository. `pnpm guard`
flags any tracked `pack.json` with `"format": "mishh-pack@1"`. Keep your pack
in its own folder, `.tgz` file or private GitHub repository.

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
  plugins/brief-writer/open-design.json
  plugins/brief-writer/SKILL.md
  plugins/deck-helper/open-design.json
```

```json
"contents": [
  { "kind": "plugins", "schema": "od-plugin-dir/1", "path": "plugins", "ids": ["brief-writer", "deck-helper"] }
],
```

List every plugin file in `files[]` like any other file. The `name` in each
plugin's `open-design.json` must equal the folder id.

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
