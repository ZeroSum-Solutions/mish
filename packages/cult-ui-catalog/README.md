# Cult catalog previews

`thumbnails` renders each non-converted catalog row with the installed private live-preview
harness first. This gives the thumbnail and opened Catalog modal the same actual component,
styles, real UI dependencies, and offline example data. The renderer refuses runtime errors
reported by either the browser or the preview's error boundary, then checks the image pixels.
The source kit remains read-only.

`CULT_PREVIEW_DIR` selects the external preview harness. When it is not installed, the renderer
uses the source converter, server render, and client fallback. `CULT_KIT_DIR` selects the kit;
`AI_ELEMENTS_DIR` can supply its omitted shared AI Elements library. The fallback pins one React
instance and uses real `cobe` with SwiftShader for WebGL globes.

The live harness labels local example records and original offline illustrations in its
`mockNote`; the Catalog modal displays that note as demo data. Those previews demonstrate the
component, not a connected model, database, or paid service. The source of generated thumbnails
is recorded in `generated/thumbnails.json`. No kit source is copied into this package.

Converted previews may contain original geometric artwork in empty image slots. The preview
labels that artwork, and generation still requires the project's supplied imagery. To capture a
converted row from its actual daemon frame, set `CULT_PREVIEW_DAEMON_URL` to the running loopback
daemon origin and select that row with `--only`. The renderer rejects non-loopback origins and
blocks network requests during capture. Without that option, converted rows retain their
committed converter previews.

Run the pinned workspace runtime:

```sh
mise exec -- corepack pnpm --filter @open-design/cult-ui-catalog thumbnails
mise exec -- corepack pnpm --filter @open-design/cult-ui-catalog thumbnails --only=globe-demo
mise exec -- corepack pnpm --filter @open-design/cult-ui-catalog thumbnails --check
mise exec -- corepack pnpm --filter @open-design/cult-ui-catalog typecheck
```

Do not run committed-thumbnail consistency tests while regeneration is writing assets. The
writer saves the complete manifest after rendering all selected rows, then validates it.
