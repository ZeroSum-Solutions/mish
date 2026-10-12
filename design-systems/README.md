# Design Systems

Each subfolder is a portable design-system package. Selecting one from the
Design System surface or a supported project-creation workflow composes its
design context into the agent prompt.

The bundled catalog contains **1 package**: Neutral Product
(`neutral-product`), the first original agency archetype, with a promotion
record (see
[`docs/design-systems/QUALITY-STANDARD.md`](../docs/design-systems/QUALITY-STANDARD.md)).
It is also the default design system.

> **No brand-named packages.** The five brand-derived packages from upstream
> (Airbnb, Apple, Linear, Stripe, Vercel) were removed on 2026-09-23. They
> copied other companies' names, colors and fonts. Do not add a package that
> does. See `docs/legal/LICENSE-COMPLIANCE.md`.

Every bundled package
has the same minimum machine-readable shape:

```text
design-systems/<slug>/
├── manifest.json
├── DESIGN.md
└── tokens.css
```

- `manifest.json` owns stable discovery metadata, provenance, and declared
  package paths.
- `DESIGN.md` is the canonical design prose for agents.
- `tokens.css` is the canonical compiled semantic-token stylesheet.

The daemon still discovers legacy folders that contain only `DESIGN.md`, so
older and user-installed content remains compatible. That fallback is not the
authoring target for new repository content.

## Manifest and catalog behavior

The v1 manifest uses fixed canonical file names:

```json
{
  "schemaVersion": "od-design-system-project/v1",
  "id": "acme",
  "name": "Acme",
  "category": "Productivity & SaaS",
  "description": "A concise English catalog summary.",
  "source": {
    "type": "bundled",
    "origin": "Mishh Mashh curated bundled fixture"
  },
  "files": {
    "design": "DESIGN.md",
    "tokens": "tokens.css"
  }
}
```

- The folder slug and `manifest.id` must match and use normalized ASCII.
- `files.design` is `DESIGN.md`; `files.tokens` is `tokens.css`.
- `name`, `category`, and `description` are the primary packaged-catalog copy.
- `source` records package provenance.
- Every declared path must be safe, relative, and present.

At runtime, manifest metadata takes precedence over the legacy Markdown H1 and
`> Category:` conventions. Those Markdown conventions remain readable fallback
metadata for legacy packages. The exact precedence and authoring rules live in
[`docs/design-systems.md`](../docs/design-systems.md).

The catalog is scanned on every `/api/design-systems` request. After changing a
package, refresh the Design System surface; a daemon restart is not required.

## Revision approval

Generation pickers offer approved kits. Turn on **Show all kits** to inspect
Unreviewed kits and approve one before selecting it. Use **Unapprove** in the
inspection view to revoke approval. A selected Unreviewed kit
keeps its identity and shows a blocking message. Its Approve action binds the
revision in that notice; if the kit changed, inspect the new revision first.
Selected draft, missing, or empty kits also stop generation with a clear message.

Approval binds to the package content hash, including nested assets and content
metadata. Content edits revoke approval. Save editing-workspace changes to the
package, then inspect and approve the saved revision. Kit-authoring runs can edit
an Unreviewed kit; generation with that kit requires approval. Publish alone does
not approve a kit. Approve also publishes the reviewed user kit.

Use `od design-system list --json` to inspect approval and revision fields.
`od design-system approve <id> --revision <sha256>` approves an inspected hash;
`od design-system unapprove <id>` revokes it. Omitting `--revision` approves the
current inspected HTTP detail revision with an optimistic concurrency check.
The CLI prints the revision it binds. Approval receipts use a temporary file and
atomic rename. Ordinary lists reuse a digest while recursive file stats stay
unchanged; generation and approval re-read the content and receipt.
The UI and CLI use `PUT /api/design-systems/:id/approval` with `approved` and
`expectedRevision`. A stale revision returns HTTP 409.

Built-in kits ship approved through
[`approved-built-in-seed.ts`](../apps/daemon/src/design-systems/approved-built-in-seed.ts).
The seed names the vetted content digest. An edited or updated built-in becomes
Unreviewed until its new revision is approved. An explicit Unapprove overrides
the shipped seed. A stale positive receipt does not override a matching newly
vetted seed; an explicit Unapprove still does. When shipping a newly vetted
built-in revision, update its seed after the
[quality review](../docs/design-systems/QUALITY-STANDARD.md).

Finalize-design and project token suggestions read selected kit bodies through
the project-scoped gate in
[`server-services.ts`](../apps/daemon/src/design-systems/server-services.ts);
standalone readers use
[`generation-reader.ts`](../apps/daemon/src/design-systems/generation-reader.ts).
OD Next stores the selected revision and scope alongside its frozen prompt in
[`task-store.ts`](../apps/daemon/src/strategies/task-store.ts), then checks that
revision again before spawning the agent. These paths enforce the same approval rule.

After installing the seven vetted Atlas Digest packages through the supported
installer, run `od design-system seed-atlas --json`. The seed checks every kit
against the pinned hashes in
[`approved-atlas-seed.ts`](../apps/daemon/src/design-systems/approved-atlas-seed.ts)
before approving any. The repository contains the ids and hashes; private kit
assets stay outside Git. Each host must install these packages separately.

Daemon-owned approval storage follows the
[daemon data directory contract](../AGENTS.md#daemon-data-directory-contract).

## Rich package files

Packages may declare the richer files below through their corresponding
manifest fields:

```text
USAGE.md                     agent-facing read order and usage guide
components.html              standalone component fixture
components.manifest.json     derived component/token index
design-tokens.json           derived Design Tokens JSON
tailwind-v4.css               derived Tailwind v4 mapping
assets/                       optional static assets
fonts/                        optional webfonts
preview/                      indexed preview pages
source/                       importer evidence, snippets, and token reports
```

These fields are active runtime inputs, not structural placeholders. Prompt
composition consumes `USAGE.md`, `tokens.css`, component information, import
mode, craft bindings, and a manifest-derived pull index when present. Package
and static-file APIs expose declared preview/source files without widening the
filesystem boundary.

Derived files are caches rather than competing sources of truth:

- `components.manifest.json` is derived from `components.html` and `tokens.css`.
- `design-tokens.json` is derived from the token-contract report and must agree
  with `tokens.css`.
- `tailwind-v4.css` is derived from `tokens.css`.

The manifest and package-quality guards validate the declared paths, rich
profile, derived-file parity, token contract, component fixture, source
evidence, and preview coverage. Read
[`_schema/AGENTS.md`](_schema/AGENTS.md) before editing those contracts.

## Writing a package

`DESIGN.md` does not use a fixed nine-section template. The package-quality
guard requires at least seven substantive H2 headings for migrated packages,
without prescribing their names, order, or numbering. Use headings that fit the
actual system and keep their decisions synchronized with `tokens.css`.

For new repository content:

1. Create the three required files and keep the folder slug equal to
   `manifest.id`.
2. Record useful catalog metadata and source provenance in `manifest.json`.
3. Write at least seven substantive H2 sections in `DESIGN.md`.
4. Bind the shared semantic-token contract in `tokens.css`.
5. Add rich package files when the system needs components, previews, assets,
   fonts, or source evidence.
6. Run `pnpm guard` and `pnpm typecheck`.

The complete authoring guide and review checklist are in
[`docs/design-systems.md`](../docs/design-systems.md).

## Importing and refreshing

The product exposes local-folder, GitHub, and shadcn import flows in both the UI
and the `od design-systems import-*` CLI. Those importers write the package
contract rather than a standalone `DESIGN.md`.

[`scripts/sync-design-systems.ts`](../scripts/sync-design-systems.ts) is the
upstream bulk synchronizer. It imports brand-named systems, so do not run it
into this repository's bundled catalog. Do not copy the retired branch-only
importer or manual tarball recipe from old plans.

## Attribution

Package-level `manifest.source`, evidence files, and local license files are the
source of truth for provenance. `neutral-product` is original work; its
references and their rights status are listed in
`neutral-product/source/evidence.md`.
