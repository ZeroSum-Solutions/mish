# apps/web/AGENTS.md

Follow the root `AGENTS.md` and `apps/AGENTS.md` first. This file holds web-runtime conventions: previews, CSS ownership, shared components, i18n and motion.

## HTML preview render mode

- `apps/web/src/components/file-viewer-render-mode.ts` decides URL-load vs srcDoc for HTML previews. Bridges (deck, comment/inspect selection, palette, edit, tweaks) can ONLY inject through the srcDoc path. Add a new disqualifier to `UrlLoadDecision` whenever a feature needs a srcDoc-only bridge; pass it from `FileViewer.tsx` based on a source-content heuristic where appropriate (e.g. `hasTweaksTemplate`). The host keeps both iframes mounted simultaneously and swaps CSS visibility so toggling render mode does not cause an iframe reload flash; `iframeRef.current` stays aligned with the active iframe via `useEffect`. Receive filters use `isOurIframe(ev.source)` to accept messages from either iframe but signals that should ONLY come from the active iframe (e.g. `od:tweaks-available`) re-check `ev.source === iframeRef.current?.contentWindow`.

## Web CSS ownership

- `apps/web/src/index.css` is an import-only cascade entrypoint. Do not add selectors or declarations there; add imports only when a truly global stylesheet is needed, and keep import order intentional.
- Shared global styles belong in `apps/web/src/styles/`: design tokens, base/reset rules, primitives, app-shell layout, and legacy cross-component selectors that cannot safely be scoped yet. Keep domain-level global files grouped by owner (for example `styles/viewer/` and `styles/workspace/`) instead of adding more large files directly under `styles/`.
- New component-owned UI styles should default to CSS Modules next to the component (`Component.module.css`) instead of expanding global stylesheets. This is preferred for isolated components, panels, menus, drawers, toolbars, cards, and form sections.
- When touching an existing component with nearby global styles, prefer migrating that component's local selectors to a CSS Module as part of the change if it is small and testable. Do not mix a large mechanical move with behavior/styling changes in the same patch.
- Keep global class names only for deliberate shared contracts: reusable primitives, theme hooks, third-party/content styling, cross-component layout, or selectors that rely on global cascade/specificity. Document any new global selector group with its owning feature.
- CSS refactors must preserve cascade semantics. For mechanical splits, verify expanded import content/order matches the previous stylesheet; for CSS Module migrations, validate the affected UI path with `pnpm --filter @mish/web typecheck` and a focused build/test or visual check when practical.

## Web component reuse

- `docs/design/ui-system.md` is the UI system rulebook: hierarchy, type roles, spacing and padding, sizing, radii, elevation and glass, interaction states (spring-loaded press, focus ring), motion and the component catalogue. Read it before adding or restyling web UI.
- New `apps/web` UI should reuse shared primitives from `@mish/components` when one exists instead of styling plain HTML elements directly. For example, use `Button` for app buttons and `VisuallyHidden` for screen-reader-only text/status content.
- Do not add new raw primitive classes such as `primary`, `primary-ghost`, `ghost`, `subtle`, `icon-btn`, or `sr-only` for new UI. Those classes are legacy compatibility surface for existing markup until it is migrated.
- If a needed primitive is missing, prefer adding a small focused primitive to `packages/components` with colocated CSS Modules, then consume it from the app. Keep product-specific layout and workflow styling in the app, not in `packages/components`.
- Keep semantic plain HTML when it is content markup or a specialized control that the shared package does not model yet; do not force a migration that would hide native behavior or make a custom widget harder to reason about.
- `apps/web` transpiles `@mish/components` from source during dev, so component and CSS Module edits should work through the normal web dev loop without rebuilding the package.

## i18n keys

- `apps/web/src/i18n/types.ts` is the typed `Dict`; every key must be defined in `apps/web/src/i18n/locales/en.ts`. The product is English only (owner decision 2026-10-10, replacing the 2026-09-23 rule); do not add a locale without an owner decision. Add the key to `types.ts` first; missing translations produce a typecheck error.

## UI animation philosophy

- Default ease-out for UI transitions: `cubic-bezier(0.23, 1, 0.32, 1)`. Built-in `ease` is too weak; `ease-in` is forbidden for UI elements because it feels sluggish.
- Asymmetric durations: enter around 200ms, exit around 140ms. Exit reads as decisive because the user has already chosen to dismiss.
- Accordion expand and collapse uses `grid-template-rows: 0fr -> 1fr` (modern auto height pattern). Pair with opacity fade and the easing above. The shared `.accordion-collapsible` + `.accordion-collapsible-inner` class pair (defined in `apps/web/src/styles/viewer/composio.css`) is the canonical implementation; reuse it for new disclosure UI.
- Never animate from `transform: scale(0)`. Start from `scale(0.9)` or higher with `opacity: 0`.
- For elements that show conditionally, keep them mounted and toggle a CSS class (e.g. `.chat-jump-btn-active`). React unmounts skip the exit transition entirely.
