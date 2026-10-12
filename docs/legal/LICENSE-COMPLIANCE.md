# License compliance

Status as of 2026-09-23. This is an engineering record, not legal advice.

## The license

- The upstream project is licensed under **Apache-2.0**. The license has no
  commercial restriction and no extra clauses.
- The root `LICENSE` keeps the upstream project's original copyright line.
- `NOTICE` names this product, states that it is a modified version, and lists
  the bundled third-party licenses.
- Apache-2.0 obligations apply when we **distribute** the software: we give a
  copy or a build to another person. Private use has no open obligation.

## Rules

### Do not

1. **Do not use upstream names or logos as our identity.** Apache-2.0 §6 grants
   no trademark rights. Upstream's names, logo, Discord, X account and support
   email are theirs.
2. **Do not redistribute `@powerformer/vela-cli`.** Its npm license is
   `UNLICENSED`. `tools/pack` copies it into a packaged build whenever the
   optional package is installed on the build machine
   (`copyOptionalVelaCliBinary`); `--require-vela-cli` only makes the copy
   mandatory. See "Open items before any distribution".
3. **Do not send data to, or take content from, upstream services by default.**
   See "Network defaults" below.
4. **MotionSites: metadata and deep links only, never vendored content.**
   `motionsites.ai` publishes no `/terms`, `/license` or `/pricing` route (confirmed 2026-09-24,
   including its SPA's full client-side route table) — the only rights statement on the site is
   its footer, "All rights reserved." A free or paid MotionSites plan opens prompts for the
   signed-in account to *read*; it grants no redistribution right. Bundling or proxying a
   MotionSites prompt's text, preview image, video, Lovable/Bolt remix target or creator GitHub
   repository is out of scope. The one clean path is source discovery → deep link → the
   signed-in user's own, on-demand prompt fetch: `apps/daemon/src/motionsites/design-reference.ts`
   fetches a prompt's text only when a build actually asks for it (`designReferenceId`), holds it
   in memory for that one build, and never writes it to a catalog file, a build record, a log or an
   SSE frame — see `docs/agency-site.md`'s "Sections and design references" and
   `packages/section-catalog/src/motionsites.ts`'s own rights-evidence string. The bundled
   `local-corpus` source (`packages/section-catalog/src/local-corpus.ts`) is the opposite case —
   owner-authored ZeroSum prompts, never a rewrite of scraped MotionSites text — and carries its
   own, separate rights evidence per entry.

### Do

1. Keep `LICENSE` and `NOTICE` in every copy we distribute.
2. Keep the third-party license files listed in `NOTICE`.
3. Record modified upstream files in git history. Cherry-picks follow
   `docs/FORK-PIN.md`.
4. In a desktop build, keep the LGPL components (ffmpeg and ffprobe installers,
   `@img/sharp-libvips-*`) as separate, replaceable libraries.
5. Take the MIT side of dual-licensed packages such as `jszip`.

## Network defaults

These paths send data to, or take content from, upstream services only when an
operator sets an explicit URL:

| Path | Upstream default before | Now | Opt-in variable |
|---|---|---|---|
| Langfuse telemetry relay | none | none | `MISH_TELEMETRY_RELAY_URL` |
| AMR entry and profile analytics mirror | `amr-api.mish.invalid` | off | `MISH_AMR_ANALYTICS_URL` |
| Download-attribution ledger | `download.mish.invalid` | off | `OD_ATTRIBUTION_LEDGER_URL` |
| What's New card document | `whatsnew.mish.invalid` on release channels | off | `OD_WHATS_NEW_URL` |
| Packaged desktop updater | `releases.mish.invalid`, on for packaged builds | off, also under `OD_UPDATE_ENABLED` | `OD_UPDATE_METADATA_URL` |

Known remaining upstream calls (not changed yet):

- **AMR.** The AMR Cloud sign-in and AMR model routing call
  `amr-api.mish.invalid` when a user chooses AMR. That is an upstream service
  under upstream terms.
- **Hosted images.** The visual-style picker and plugin previews load images
  from `repo-assets.mish.invalid`. Turning this off breaks those previews
  until we host the images ourselves.

## Open items before any distribution

Each item below must be fixed, and checked in the built artifact, before we give
a desktop build to anyone:

- **Notices in the installer.** Packaged builds do not include `LICENSE`,
  `NOTICE`, or the 7-Zip `License.txt` next to `7z.exe` and `7z.dll`. Add them.
- **Vela CLI.** Stop `copyOptionalVelaCliBinary` from copying the binary, or
  build on a machine without `@powerformer/vela-cli`, and check the artifact.
- **Packaged app identity.** Installer and bundle names use `Mish` (renamed 2026-10-12).
- **Cloud sign-in label — done.** The UI used to name upstream's cloud service
  as if it were ours. The label is now `AMR`.
- **Internal package scopes** (`@mish/*`) and code identifiers are not
  shown to users. They can stay.
- **Upstream release workflows** (`bake-plugin-previews*.yml`,
  `whats-new-publish.yml`) publish to upstream storage and need upstream
  secrets. They cannot run in this fork.

## Removed brand-named design systems

On 2026-09-23 we removed the five brand-derived design systems that came
from upstream: `airbnb`, `apple`, `linear-app`, `stripe` and `vercel`, from
`design-systems/` and from `plugins/_official/design-systems/`. They copied
other companies' names, color names and font names. The only bundled design
system is now `neutral-product`, which is original work. Do not add a
design system that copies another company's name, colors or fonts.

## Owned example replacements (2026-10-09)

Eight of the 18 MotionSites-origin bundled example packages have been replaced
with original ZeroSum Solutions templates. Their IDs remain for compatibility;
their current manifests name ZeroSum Solutions, use Apache-2.0 and carry owned
rights evidence. `NOTICE` removes only those eight from the disputed attribution.
The other ten retain the caveat and are not cleared for distribution by this work.
See [the package inventory and verification record](../motionsites-owned-rewrite.md)
and each replacement’s `RIGHTS.md`. Bundled OFL fonts keep their separate notices.
This replacement does not clear old Git revisions, cached previews or builds
made before the replacement.

## Fonts

Example families and their previews ship OFL (or other redistributable open)
fonts only, with a licence file beside each font directory. "Open" means any
licence that lets us redistribute the file inside our product; it is not
limited to OFL. Commercial fonts
are never committed, even for private testing. The same rule holds for the app
itself (`apps/web/public/fonts/`), because those files ship in desktop builds.

- **Licence file.** Every directory that holds font files (text faces and icon
  fonts alike) has the full text of each file's redistributable licence beside
  it: `OFL.txt` for SIL OFL faces, with each face's copyright line, or the
  licence file the project publishes, for example
  `apps/web/public/REMIXICON-LICENSE.txt` for the Remix Icon font
  (`remixicon.ttf`, `remixicon.woff2`; Remix Icon License v1.0, which permits
  redistribution inside a larger product but not as a standalone icon set). A
  font directory without one is a review blocker.
- **Check the bytes, not the name.** Before committing a font, read its name
  table (copyright, licence, manufacturer). "All rights reserved" with no open
  licence means the font cannot be committed.
- **Scraped reference sites.** A reference site's own fonts, photography and
  video stay out of the repository. Example packages use OFL faces and
  labelled geometric stand-ins drawn by `scripts/make-agency-stand-ins.ts`.

On 2026-10-06 we removed the commercial fonts that had been committed: the
two Pangram Pangram families in `agency-emmpo`, the Displaay, Colophon and
Vocal Type families in `agency-watson`, and the CoType Foundry monospace in
`apps/web/public/fonts/`. They were replaced by Archivo, Bodoni Moda, Kumbh
Sans, Fraunces and IBM Plex Mono (all SIL OFL 1.1, already in the
repository). The same change replaced the two packages' scraped images and
video with stand-ins and dropped the third-party screenshots under
`skills/agency-{emmpo,watson,cult-heroes}/assets/`. Removal from the tip does
not remove the files from Git history; whether to rewrite history is an owner
decision.

## Questions for a lawyer

- Did the upstream owners publish a trademark policy after the pin date?

## Dependency licenses (pnpm licenses list, 2026-09-22)

Mostly MIT, Apache-2.0, ISC and BSD. No AGPL, SSPL, BUSL or Elastic licenses.
Flags: `@powerformer/vela-cli` (UNLICENSED), ffmpeg/ffprobe installers
(LGPL-2.1), `@img/sharp-libvips-darwin-arm64` (LGPL-3.0-or-later), `jszip`
(MIT or GPL-3.0), `khroma` (no license field; MIT upstream).
