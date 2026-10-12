# Component kit payload

The public repository carries no licensed component payload. The `cult-ui-pro/` folder is absent here, and the Cult routes answer that the kit is unavailable until one is provided.

A kit comes from one of these, in this order:

1. `CULT_KIT_DIR`, an explicit override that names a kit folder.
2. A Mish pack that provides `catalogs.cultKit` (see `docs/packs.md`). Install the team packet and the daemon reads the kit from the pack, with no restart.
3. This folder, `cult-ui-pro/`, when a private build puts a kit here. Builds verify its `manifest.json` (every file's bytes and SHA-256) before copying the resource tree; a checkout without a manifest packages without a kit.

A kit folder holds `manifest.json`, `registry/<name>.json`, `converted/<name>/{template.html,styles.css,slots.json}` and `previews/` (a `manifest.json` and `<name>.{light,dark}.html.gz`). Registry items verify their catalog pins when served, and preview HTML verifies its compressed file hash before decompression. Keep harvest folders, source-control metadata, tokens, fetch logs and dependency trees out of a kit.

The TypeScript materializer is `tools/pack/scripts/materialize-component-kit.ts`. Set `CULT_KIT_DIR` and `CULT_PREVIEW_HARNESS_DIR`, then run it with the pinned Node runtime and an empty staging-directory argument. `scripts/build-pack.mjs` packs the result into a Mish pack.
