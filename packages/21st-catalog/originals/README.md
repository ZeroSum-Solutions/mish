# Saved-reference original alternatives

All 22 saved 21st.dev references have an independently authored ZeroSum alternative here. The saved metadata in `generated/21st-items.json` retains the upstream author, item URL, rights, and pinned notices. `generated/21st-originals.json` contains our separate executable work; no upstream registry component or demo source is read by this generator.

Every alternative exports `mount(element, options) => { destroy() }`, uses the same dependency-free lifecycle shape as the owned GenUI catalog, scopes CSS beneath `.mm-original`, honors system and explicit reduced motion, and runs with no remote runtime assets or network calls. Browser previews are isolated documents; exported files include editable TypeScript, a ready-to-use browser module, stylesheet, self-contained offline HTML demo, README, and our notice. Source responses include a SHA256 for each file and a SHA256 of the ordered path/hash manifest.

The source endpoint is `/api/21st/:id/source`; `?download=zip` downloads all seven files. The executable preview endpoint is `/api/21st/:id/preview`. `od 21st source|export|preview` uses the same routes. Export requires a new directory and verifies all checksums before writing. Open the exported `index.html` directly to run; import `component.js` and include `style.css` to reuse or remix.

## Design direction

The user supplied the saved collection and requested original reusable implementations where upstream reuse was unavailable. The primary gallery direction follows Refero's [Linear changelog style](https://linear.app/changelog) (style `11d3e58a-87d7-4a9a-bbf5-720f4fd3ffc6`): precise neutral framing, compact controls, and contained graphics. Light framing borrows [shadcn's architectural component presentation](https://ui.shadcn.com) (style `c14c0a94-1037-449e-bf5b-4cb972656ac7`): restrained borders and legible monochrome text. Color belongs to the demos, with mint reserved for interactive/status roles in the demo shell. Typeface assets are system-local. Illustration is explicitly code-native geometry, not fetched photography.

| Decision | Evidence and role |
| --- | --- |
| Separate attribution and original actions | User request and saved manifest rights: upstream cards stay references, our source has its own provenance |
| Neutral gallery framing, compact pill controls | Linear Refero style: container/interaction roles |
| True light surface/text tokens | shadcn Refero style: component framing role |
| Geometric shapes, floating particles, color control | Public description on the saved Animated Geometric Card page: behavioral brief only |
| Distinct behaviors per saved item | Saved component names and semantic type: carousel, chart, modal, scheduler, stream, chat |
| Offline graphics and explicit sample states | User constraints: no hidden network or false publish/send/booking claims |

## Coverage

| Saved reference | Original | Distinct interaction |
| --- | --- | --- |
| Image Stream Hero | Field notes | Pause and reverse art stream |
| Phosphor 30 | Signal laboratory | Brightness and signal control |
| Animated Geometric Card | Orbital study | Pointer tilt, particles, palette switch |
| Gallery Hover Carousel | Chromatic atlas | Hover/focus expansion and held selection |
| Spline Scene | Spatial object | Local CSS 3D orbit control |
| Shared Element Gallery | Expanded moments | Artwork expansion in native modal |
| ScannerCardStream | Inspection lane | Pause scan beam |
| Glassmorphism Listen App | Listening room | Local play state, seek, track selection |
| Glassmorphism Portfolio | Studio profile | Local project filtering |
| 3D cards Slider | Depth deck | Perspective deck navigation |
| System Monitor | Machine pulse | Explicit sample CPU/memory switch |
| Dashboard Activities | Activity ledger | Filter and mark sample events reviewed |
| Radar Chart | Capability map | Compare accessible sample datasets |
| Glass Testimonial swiper | Studio voices | Pointer swipe, arrows, quote navigation |
| RuixenMonoChat | Conversation sketch | Local transcript and explicit canned reply |
| SocialPostCard | Field dispatch | Local like/save toggles |
| Offer Carousel | Weekend editions | Offer navigation and sample application |
| Card by ravikatiyar162 | Collection card | Save and expand notes |
| Dialog | Decision dialog | Focus-managed sample confirmation |
| Card by hero_ui | Destination card | Sample guest selection and availability |
| Coach Scheduling Card | Session planner | Sample date/time selection and confirmation |
| Background Paths | Contour field | Path density and pause |

## Rebuild and verify

From the repository root:

```sh
mise exec -- corepack pnpm --filter @open-design/21st-catalog originals
mise exec -- corepack pnpm --filter @open-design/21st-catalog exec node --experimental-strip-types scripts/originals.ts --check
mise exec -- corepack pnpm --filter @open-design/21st-catalog typecheck
mise exec -- corepack pnpm --filter @open-design/21st-catalog exec node --experimental-strip-types --test tests/originals.test.ts tests/twenty-first.test.ts
mise exec -- corepack pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/twenty1st-routes.test.ts tests/twenty1st-cli.test.ts
mise exec -- corepack pnpm --filter @open-design/web exec vitest run -c vitest.config.ts tests/components/CatalogView.21st.test.tsx
```

The generator reads only our source tree and public saved metadata. It embeds TypeScript-stripped browser modules as generated JSON compatibility output, with exact SHA256 CSP script/style hashes; it adds no tracked JavaScript files, framework, dependency, or network build step.
