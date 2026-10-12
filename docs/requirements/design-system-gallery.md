# Design system gallery

The library keeps search visible and matches every word across system name, category, description, identifier, palette values, and localized labels. Accents and case do not change the match. The same matcher serves `GET /api/design-systems?query=...` and `od design-systems list --query "dark inter" --json`; workspace visibility is applied before HTTP search.

Personal and team libraries support category filters. Packages whose description declares `Theme: light`, `Theme: dark`, or `Theme: mixed` also expose theme filters. Theme is explicit metadata, rather than inferred from a description or the first color.

Visualize opens with a system specimen showing source typography, semantic canvas/text/action colors, and either the package's reference image or a small UI example. Empty read-only logo modules are omitted. Source font names and local fallbacks are preserved and labeled. Fallback layout specimens use neutral sample labels without invented metrics, identities, or success claims. This view does not acquire proprietary font files.

The guide preserves prose-only imagery and layout sections as well as structured labels. Wrapped list items stay intact. Global Do/Don't rules appear as distinct columns, with a section navigation strip for the full guide. Module edits preserve the original source specification; the rules editor also excludes typography-specific rules. Color limitations remain visible beside the native palette. Wrapped labels retain their full values, and Neutral Product uses its dedicated spacing rhythm. The Visualize modal gives the guide its full width initially; the source sidebar remains available, and Showcase/Tokens keep the split preview.

The presentation target is Neutral Product's completeness, with the user's Neuform reference supplying a concrete pattern for inspectable type, color, spacing, and constraints. Refero's shadcn/ui reference supplies the compact specimen grid and consistent component framing; its Figma reference supplies image-first asset tiles. The existing app chrome remains neutral. Each source owns the colors, fonts, imagery, and component rules inside its previews. No new palette ramps or unsupported source claims are generated.

A declared `assets/preview.jpg` provides the library thumbnail and reference image. The catalog advertises it only when the assets directory and image are real local entries. Static reads retain their existing workspace authority checks.

## Private Study library

The 108 Study packets are private portable imports, not bundled systems. Each package preserves source CSS, all original files and screenshots, the full specification, source metadata, and a hash inventory. Its source identity, imagery direction, layout, component treatment, and explicit Do/Avoid rules feed the native guide. Missing source guidance is labeled rather than invented. The package includes a source-specific `system/kit.html` showcase, a separate interactive component lab exposed in the asset gallery, and focused reference/color/type/spacing/media/layout/rules preview pages. Those pages embed their dependencies and use local fragment navigation so the query-style static endpoint retains workspace authority. Four sources explicitly lack imagery direction. Palette roles remain source-defined; malformed source colors are labeled without correction. Sparse source token sets remain sparse; 11 packets do not meet the richer bundled token-coverage threshold.

Import a portable package through the existing local-import UI or `od design-systems import-local <absolute-package-path> --import-mode verbatim --json`, with the target daemon and explicit workspace/member flags when applicable. Runtime storage follows the root AGENTS.md daemon data directory contract. Do not copy Study metadata into the runtime ownership metadata file.

Semantic tables such as Neutral Product retain both the light and dark values under the actual token names. Source limitation notes remain prose and cannot become extra palette swatches. Wide-screen prose uses a bounded reading measure while preserving the source paragraphs.

## Validation

Targeted web coverage checks search semantics, collection/theme filters, source color roles, private package image URLs, modal behavior, logo edit focus, font-name/Markdown parsing, prose guidance, wrapped rules, canonical rule editing, and opening actual asset viewers. Daemon coverage checks query validation, workspace isolation, CLI encoding, thumbnail existence, and symlink rejection. Browser checks cover the live library, component interactions, asset previews, and narrow panels. Provider generation and production deployment are outside this change.
