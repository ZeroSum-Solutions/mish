# 21st.dev reference catalog

This package holds the data behind the Catalog view's 21st.dev segment and the `od 21st`
commands:

- `generated/21st-items.json`: metadata for the saved 21st.dev references (name, author, item URL,
  rights). Only rows whose upstream licence is an explicit MIT grant carry the licence notice.
  No upstream source is stored here.
- `generated/21st-originals.json`: the independently authored alternatives built from
  `originals/` (see `originals/README.md`). They are this project's own work, with their own
  source, demo and notice.
- `generated/21st-thumbnails/` and `generated/21st-live-thumbnails/`: preview images, shipped only
  for MIT rows.
- `generated/preview-artwork/`: original generated images used to fill image slots in
  illustrative previews. Portraits show fictional people.

The daemon serves this data from `/api/21st` (`apps/daemon/src/routes/twenty1st.ts`). An optional
private preview kit (`TWENTY1ST_PREVIEW_DIR`) can add saved upstream demos on one machine; it is
never part of this repository or a public build.

Run the pinned workspace runtime:

```sh
mise exec -- corepack pnpm --filter @open-design/21st-catalog check
mise exec -- corepack pnpm --filter @open-design/21st-catalog test
mise exec -- corepack pnpm --filter @open-design/21st-catalog typecheck
mise exec -- corepack pnpm --filter @open-design/21st-catalog originals
```

`21st` and `21st-thumbnails` refresh the metadata and MIT preview images from a local copy of the
saved collection (`TWENTYFIRST_KIT_DIR`); without that copy, `check` validates the committed files
only.
