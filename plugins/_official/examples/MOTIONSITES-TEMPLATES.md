# MotionSites-origin example packages — replacement status

Updated 2026-10-09. Eight packages have been replaced by owned ZeroSum Solutions
examples. Their current markup, copy, styles, illustrations and browser code are
new work under Apache-2.0; bundled fonts retain SIL OFL notices. Their package IDs
remain for compatibility. See `docs/motionsites-owned-rewrite.md` and each
replacement's `RIGHTS.md` for briefs, provenance and verification.

**Owned replacements:** acreage-farming, aerocore, ai-designer-portfolio,
cinematic-landing-page, codenest-coding-platform, dreamcore-landing,
evergreen-finance, innovation.

**Still disputed:** layered-depth, liquid-glass-agency, luxury-botanical,
mindloop-landing, mythic-naturecore, nimbus-grid, orbis-nft, portfolio-cosmic,
skyelite-private-jets, stellar-launch. These ten retain upstream's CC-BY-4.0 /
author Eli metadata and their `NOTICE` attribution. That metadata is an
unconfirmed upstream claim, not independent permission. The recorded MotionSites
rights statement is "All rights reserved"; do not treat these ten as cleared.

## Historical import

The original set was restored from upstream `nexu-io/open-design` commit
`a93869ee09`, with follow-up `b8489c9874`, and pruned in `1319bcef2e`.
Eighteen of the 25 upstream example packages were restored. The following audit
records the earlier host cleanup only; it does not describe the new owned
implementations or establish redistribution rights. Old Git revisions and
already-built artifacts can still contain disputed material.

**Historical i18n baseline:** manifests kept the full 18-locale `title_i18n`/`description_i18n`
maps — matches `motion-frames/open-design.json`, the current convention. The
web app's own UI chrome ships only `en`; plugin manifests are data,
not UI strings, so no trim applied.

## Historical asset-host audit (before owned replacements)

A DeepSeek review found the first pass incomplete and self-contradictory
(host list didn't match the doc table). Re-audited with
`grep -oE 'https?://[^"'"'"' )]+'` over `example.html` + the manifest's
`useCase.query` build prompt + `SKILL.md` for all 18, then checked which
hosts are *live* in `example.html` versus only mentioned in prose. Also
checked whether the daemon's plugin-asset-cache
(`apps/daemon/src/plugins/plugin-asset-cache.ts`) already handles the
flagged hosts: it rewrites `src`/`poster`/CSS-`url()` through
`/api/asset-cache`, but **only** for URLs whose path ends in a recognized
image/video extension (`CACHEABLE_MEDIA_EXT`). It never touches fonts,
scripts, iframes, HLS `.m3u8`, or extension-less CDN URLs (Unsplash,
Picsum) — none of those would have been rewritten, and the preview route's
CSP (`img-src 'self'`, `connect-src 'none'`, no `font-src`) blocks them
outright. **The cache was not the applicable mechanism for any flagged
host** — every one below was a genuine gap.

Fixed in `example.html`, the manifest's `useCase.query`, and `SKILL.md`
together (so regenerating from the plugin doesn't reintroduce the host):

| plugin | host removed | what it was | fix |
|---|---|---|---|
| acreage-farming | images.unsplash.com ×4 | hero poster + 3 service-card photos | CSS radial-gradient placeholders; `.hero` also gained its own gradient so it renders before/without the mp4, and the placeholders are `aria-hidden="true"` (decorative — an `h3`/paragraph already carries the meaning) rather than `role="img"` with a made-up photo caption |
| ai-designer-portfolio | assets.website-files.com ×2 | `@font-face` .otf (commercial font, someone else's Webflow CDN) | dropped; stack already fell to Space Grotesk. Also dropped the same-origin `PP Mondwest` `@font-face` (pointed at a file this plugin never shipped, so it 404s) — the `--serif` stack falls to DM Serif Display instead |
| ai-designer-portfolio | halaskastudio.com ×3 | 3 pricing-CTA hrefs to a real studio's booking page | `#partner` in-page anchor (matches the page's other CTAs) |
| cinematic-landing-page | picsum.photos ×1 (7 tiles) | gallery tile backgrounds | per-tile CSS gradient, hue hashed from the item seed — verified: all 7 seeds (`pastry/bread/dessert/savory/sweet/culinary/ingredient`) hash to distinct hues (0–345°, no collisions) |
| codenest-coding-platform | cdn.jsdelivr.net + stream.mux.com | hls.js + HLS hero background video | `<div>` with a CSS radial gradient, no video/JS |
| mindloop-landing | cdn.jsdelivr.net + stream.mux.com | hls.js + HLS CTA background video (hero/mission/solution videos were already on the mirror) | same — CSS gradient div |
| nimbus-grid | fragcoord.xyz | live shader `<iframe>` embed | removed; kept only the existing `.shader-fallback` gradient |
| portfolio-cosmic | stream.mux.com ×2 | hero + contact HLS background video | removed the `<video>`; kept the existing `.video-fallback` gradient |
| evergreen-finance, layered-depth, stellar-launch | db.onlinewebfonts.com | Cooper BT / Zimula Trial / TT Firs Neue (font-piracy mirror, no license) | dropped to each file's own declared fallback |
| aerocore | unpkg.com/@phosphor-icons/web | icon-font CSS (no precedent among currently-shipped plugins) | inline `<svg><symbol>` sprite, 12 hand-authored icons via `<use>` — rendered in headless Chromium (Playwright): all 23 `<use>` references resolve to a symbol with a non-zero bounding box, no empty-box icons |
| ai-designer-portfolio ×1, dreamcore-landing ×3, evergreen-finance ×3, stellar-launch ×3 | `plugin-assets.open-design.ai` URLs with a malformed `&w=1280&q=85` (or HTML-escaped `&amp;w=…&amp;q=…`) suffix after `.webp` | 10 URLs on the **accepted mirror host** that still bypassed the cache — the suffix has no leading `?`, so the path does not end in a recognized extension and `isCacheableExternalUrl` returns false | verified with a `HEAD` request that the URL 404s with the suffix and returns `200 image/webp` without it, then stripped the suffix in `example.html`, `SKILL.md`, and `useCase.query` for all 4 plugins |

A same-origin **mirror host is not automatically cache-eligible** — the 10
URLs above prove a URL can pass the "it's plugin-assets.open-design.ai"
check in a doc/table and still bypass the cache and 404 under the preview
route's CSP if its path doesn't end in a recognized extension. `scripts/
check-plugin-mirror-urls.ts` (wired into `pnpm guard`) now asserts, for
every bundled example plugin's `example.html`, that every
`plugin-assets.open-design.ai` reference satisfies `isCacheableExternalUrl`
from `apps/daemon/src/plugins/plugin-asset-cache.ts` — so this class of
regression fails CI instead of shipping.

Not fixed because there was nothing live to fix — flagged by the raw grep but
only present in manifest/SKILL.md *prose*, not loaded by `example.html`:
`luxury-botanical` (`cdn.tailwindcss.com`), `orbis-nft`
(`d8j0ntlcm91z4.cloudfront.net`). `liquid-glass-agency`'s SKILL.md documents
Mux HLS URLs and a pinned `unpkg.com/framer-motion@11.11.13` script, both
scoped explicitly to an *optional React port* (the vanilla seed already
reuses the mirrored MP4 everywhere and ships no HLS/JS) — left as-is.
`stellar-launch`'s `base.launchex.vc` and `aerocore`'s `linkedin.com`/`x.com`
are plain `href` links, not asset loads — left as-is (already cleared, not a
fork-policy issue). `aerocore` also hotlinked `unpkg.com/@phosphor-icons/web`
(no precedent among currently-shipped plugins) — replaced with an inline
`<svg><symbol>` sprite (12 hand-authored icons) via `<use>`.

**Post-fix host inventory for every shipped `example.html`:** Google Fonts
(`fonts.googleapis.com`/`fonts.gstatic.com`), the mirrored
`plugin-assets.open-design.ai` (every reference verified cache-eligible —
`scripts/check-plugin-mirror-urls.ts` passes), `www.w3.org` (inline SVG
namespace URI, not a network fetch), and the two cleared `href`-only links
above. Nothing else.

| id | title | spine · archetype | live hosts | verdict |
|---|---|---|---|---|
| acreage-farming | Acreage — Precision Farming | PA · SaaS trial landing | fonts, plugin-assets.open-design.ai | ready |
| aerocore | AeroCore — Cinematic Aerospace Engine Landing | TL · industrial cinematic marketing | fonts, plugin-assets.open-design.ai, linkedin.com/x.com (href) | ready |
| ai-designer-portfolio | AI Designer Portfolio — Viktor Oddy | TL · portfolio + pricing | www.w3.org, fonts, plugin-assets.open-design.ai, linkedin.com/x.com (href) | ready |
| cinematic-landing-page | Cinematic Landing Page | TL · enterprise B2B landing | www.w3.org, fonts, plugin-assets.open-design.ai | ready |
| codenest-coding-platform | CodeNest — Coding Platform Hero | LM · edtech hero | fonts only | ready |
| dreamcore-landing | Dreamcore Landing — Parallax Portal Hero | CS · immersive brand landing | fonts, plugin-assets.open-design.ai | ready |
| evergreen-finance | Evergreen Finance — Kova Fintech Landing | PA · fintech product landing | fonts, plugin-assets.open-design.ai | ready |
| innovation | Innovation — Dark Editorial Landing | TL · agency editorial landing | fonts, plugin-assets.open-design.ai | ready |
| layered-depth | Layered Depth — Qelora Architecture Studio | TL · studio marketing | plugin-assets.open-design.ai only | ready |
| liquid-glass-agency | Liquid Glass Agency | TL · agency landing | fonts, plugin-assets.open-design.ai | ready |
| luxury-botanical | Luxury Botanical — Beyond The Collection | CO · luxury product landing | www.w3.org, fonts, plugin-assets.open-design.ai | ready |
| mindloop-landing | Mindloop Landing — Monochrome Content Platform | CS · content/newsletter landing | fonts, plugin-assets.open-design.ai | ready |
| mythic-naturecore | Mythic Naturecore — Reverie | CO · immersive brand story | www.w3.org, fonts, plugin-assets.open-design.ai | ready |
| nimbus-grid | Nimbus Grid — Secure Cloud Storage | PA · SaaS product marketing | fonts only | ready |
| orbis-nft | Orbis NFT — Dark Space Landing | CO · collection-drop landing | www.w3.org, fonts, plugin-assets.open-design.ai | ready |
| portfolio-cosmic | Portfolio Cosmic — Dark Landing | TL · personal/portfolio landing | fonts only | ready |
| skyelite-private-jets | SkyElite Private Jets | BA · charter booking landing | fonts, plugin-assets.open-design.ai | ready |
| stellar-launch | Stellar Launch — Launchex Awards | TL · awards/program landing | fonts, plugin-assets.open-design.ai, base.launchex.vc (href) | ready |

**Verdict counts:** ready 18 · needs-asset-fix 0 · hold 0 · not restored 7.

## Not restored

7 of the 25 upstream plugins carry upstream's own quality rationale, not just
the license-driven prune, and were removed from this branch (`git rm`):

- **ai-automation, art-landing, flowmate, modern-agency,
  prisma-creative-studio, urban-jungle** — dropped upstream in `75f1472d53`
  ("drop 6 low-quality example templates... broken/poor visuals").
- **shamoni** — dropped upstream in `b034609cde`: its baked preview
  duplicates `luxury-botanical`'s hero imagery, so the Community shelf
  showed the same tile twice.

None of the 18 shipped plugins are wired into `curatedPriority.ts`, the Home
facet rails, or any test fixture.

## Open question for the owner

`plugin-assets.open-design.ai` (the upstream Cloudflare R2 mirror, referenced
by 15 of the 18) is an upstream-owned host outside this fork's control — same
caveat `LICENSE-COMPLIANCE.md` already logs for `repo-assets.open-design.ai`.
