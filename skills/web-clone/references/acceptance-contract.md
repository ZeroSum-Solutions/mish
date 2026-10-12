# Reference extraction and remix gates

Use this contract when collecting reusable reference systems. Website Clone owns the
run. Delegate a bounded effect packet to `od-web-effect-extractor` when reconnaissance
finds Canvas, WebGL, Three.js, shaders, cursor effects, or scroll-driven motion. Pass
source URL, capture viewports, defining regions, interaction targets, packet directory,
and unresolved observations. Merge the returned evidence before building.

This is a candidate workflow. Never describe it as locked until a human explicitly
accepts a verified baseline and second identity against their exact hashes.

## Order

Reconnaissance → complexity/rendering classification → specialist extraction when
applicable → faithful baseline → visual and behavioral verification → measured
DESIGN.md and tokens → second identity → the same runtime gates → human acceptance
→ immutable version → asset-bank registration.

A preliminary measurement notebook is useful before building. The final design
system must derive from the verified baseline plus source evidence. Screenshot-only
style inference is insufficient. Preserve distinct source, baseline, remix, and
verification directories. Put generated candidate results outside the packet input
so hashing the packet cannot include the hash result itself.

## Minimum packet

Each technical claim carries SOURCE, PARTIAL, or GUESS, an evidence path, and a
limitation where applicable. A defining PARTIAL/GUESS claim blocks fidelity approval.
Absence is recorded as unknown, never as a measured zero or “not applicable.”

| Evidence | Required content |
|---|---|
| Provenance | URL, UTC capture time, extractor revision, viewport/DPR, rights and deployment notes |
| Captures | Full desktop/mobile page, tablet layout, defining sections, interaction states, loading and reduced motion |
| Topology | All in-scope routes, semantic DOM boundaries, section order, valid link/anchor/form destinations |
| Typography | Computed families, local font files and weights, line height, tracking, responsive changes |
| Surfaces | Measured color roles, CSS variables, gradients, blend modes, borders, shadows |
| Geometry | Containers, grids, gutters, spacing, overlaps, sticky bounds, breakpoints |
| Assets | Source URL, contained local path, SHA-256, dimensions, crop, focal point, role, provenance/use rights |
| Inventory | Components, sections, states, slot contracts, responsive transformations |
| Behavior | Scroll, hover, click, pointer, loading, idle, resize, reduced motion; explicit before/after assertions |
| Motion | Trigger, start/end states, duration, easing, stagger, scrub/time base, responsive variants |
| Runtime | Console/shader errors, failed requests, unsupported behavior, unresolved observations |

For effects also require canvas dimensions/DPR, context/renderer/extensions and color
management; scene graph or ordered layers; cameras/lights/geometry/materials/textures/
models/postprocessing/framebuffers; shader sources where observable; uniforms with
observed values; draw/pass order; input bindings and time base. Capture at least two
animation timestamps and multiple scroll positions. Require nonblank-canvas checks,
actual animation advancement, isolated pointer/scroll response, resize, reduced motion,
and unavailable-WebGL fallback. If worker or GPU state is inaccessible, label that gap.

When runtime reconstruction is required, first create a RAW REPLAY baseline. Prove
its rendering and input behavior before translating it into editable components.
Do not substitute a procedural approximation for a source terrain/model pipeline.

## Separate gates

1. Packet: required evidence exists; every file is contained and freshly hashed;
   required viewport/route/state checkpoints cannot be made optional.
2. Baseline runtime: working scroll/navigation/CTAs/forms, local fonts/assets,
   desktop/tablet/mobile, no unexplained errors. An event dispatch is not a pass:
   assert observed before and after state, with screenshots and failure reasons.
3. Baseline visual: same viewport and animation state; side-by-side, overlay and
   difference image for every defining region; record metrics and classify every
   meaningful deviation. No arbitrary numerical similarity ceiling.
4. Design system: measured DESIGN.md, machine tokens, components/sections, motion,
   slots/effect parameters, responsive/accessibility rules, and example prompts.
5. Remix: separate fictional identity with original marks/copy/client imagery removed;
   retain accepted rhythm and behavior through declared tokens and variants. Test the
   same runtime states and document intentional changes.
6. Portability: give a fast model only the packet, verified system, recipes and slot
   contracts. Retain generated variation and test results. If it needs hidden repairs,
   revise the contract and rerun; do not claim portability from compilation.
7. Human authority: automation recommends; an explicit human action accepts exact
   packet, complete rendered build, baseline and remix identities.

Hash every packet byte, including raw extraction. Bind the rendered build to source,
CSS, shaders, assets, fonts, route wrappers, configuration, lockfiles/dependencies and
served output. A one-file template hash or Git SHA alone is insufficient. Recheck
these identities at acceptance. Any change creates a new candidate/version.

## Results and reuse

Use ACCEPTED only after all gates and explicit human acceptance; REJECTED for a
material failure; INCONCLUSIVE for missing or unobservable evidence. Never convert
INCONCLUSIVE into ACCEPTED through a score, optional flag, or descriptive review.

Asset-bank entries contain: resource ID, immutable version, category, owning repo,
relative path, content hash, accepted reference version, provenance/use rights,
inputs/slots/tokens, invariants, remix axes, compatibility, example prompt, and test
and screenshot references. Categories: component, section, layout, motion recipe,
effect, shader, model, texture, font, media, token system, prompt, reference packet.
Keep restricted source material reference-only. Promote only reusable material with
appropriate rights and an accepted version dependency.

Invariants state what preserves identity. Remix axes state safe changes to branding,
copy, color roles, type, media, density, section selection/order, surfaces, intensity,
and effect/model/lighting parameters. Document independent axes and combinations
that break composition or behavior; do not leave these decisions implicit.
