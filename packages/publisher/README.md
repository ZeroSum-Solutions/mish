# @mish/publisher

The headless Agency Site publisher. One family compiler plus explicit inputs go in; deterministic
static files come out:

```ts
const result = await compile({ compiler, spec, brandTokens, assets: { resolve } });
// result.files: [{ path: 'index.html', mediaType, bytes, sha256 }, ...assets], sorted by path
```

`compile` reads no files, no environment variables, no clock and no randomness. The compiler's
static resources (vendored CSS, catalog component code and catalog JSON) travel inside the
`compiler` value; the page content travels in `spec`; asset bytes come only from your resolver.
The same inputs always give the same bytes.

The fast lane (`packages/agency-fast-lane`) renders every draft through this package, so its
output and the publisher's output are the same pages.

## Entry points

| Import | What it is |
|---|---|
| `@mish/publisher` | `compile` and the lower-level render calls, the booking embed slot, all types. Pure: imports only `node:crypto`. |
| `@mish/publisher/families` | `BUNDLED_FAMILIES` and `loadBundledFamily(id)`. |
| `@mish/publisher/families/<family>` | One prebuilt, frozen `FamilyCompiler` per public family package: `app-shell`, `community`, `crm-dashboard`, `docs-hub`, `guide`, `listings`, `marketing-site`, `nonprofit`, `practice`, `publication`, `restaurant`, `storefront`. Self-contained; nothing is read from disk. |
| `@mish/publisher/node` | `loadFamilyCompiler(packageDir, family)`: builds a `FamilyCompiler` from a family package on disk. The only part that touches the filesystem, once, at load time. |

## Use from a server

```ts
import { compile } from '@mish/publisher';
import practice from '@mish/publisher/families/practice';

const result = await compile({
  compiler: practice,
  spec: { recipe: savedRecipe },                   // schemaVersion 2 typed section JSON
  brandTokens: { name: 'Willow Creek Family Dental' },
  assets: { resolve: (asset) => storage.read(asset.destination) },
});
for (const file of result.files) await bucket.put(`${releaseId}/${file.path}`, file.bytes, file.mediaType);
```

`practice.reference` is that family's reference recipe, the starting point for a new site, and
`practice.schema` is its JSON schema. The package needs Node 24 and has no runtime dependencies.

### From another repository

The package is private (not on a registry). Build it and pack it in a Mish checkout:

```sh
pnpm --filter @mish/publisher build
cd packages/publisher && npm pack          # mish-publisher-<version>.tgz, about 440 KB
```

Then depend on the tarball (`"@mish/publisher": "file:vendor/mish-publisher-0.1.0.tgz"`), or on
a built checkout (`"file:../mish/packages/publisher"`). The tarball holds `dist/` (code, type
declarations, the twelve family bundles, the Apache-2.0 `LICENSE` and a `NOTICE` with the MIT
notice of the HyperUI CSS the bundles carry) and this README. Keep `NOTICE` with any copy of the
bundles you redistribute. The `consumer` test installs the tarball offline into a fresh project and
compiles from it.

## `compile(input): Promise<CompileResult>`

```ts
type CompileInput = {
  compiler: FamilyCompiler;            // a bundle, or loadFamilyCompiler(...).compiler
  spec: SiteSpec;
  brandTokens?: BrandTokens;
  assets?: { manifest?: JsonObject; resolve?: AssetResolver };
  entry?: string;                      // the page file name, default 'index.html'
};

type SiteSpec = {
  recipe: JsonObject;                  // the family recipe: typed section JSON
  effects?: EffectPlan;                // effect placements (catalog components) to apply
  bookingEmbeds?: readonly BookingEmbed[];
};

type BrandTokens = Readonly<Record<string, Json>>;
type AssetResolver = (asset: ResolvedAsset) => Uint8Array | Promise<Uint8Array>;

type CompileResult = {
  entry: string;
  files: PublishedFile[];              // { path, mediaType, bytes, sha256 }, sorted by path
  digest: string;                      // sha256 over each file's `${path}\0${sha256}\n`
  manifest: ArtifactManifest;          // the compiler's artifact manifest for the entry
  recipe: Json;                        // the recipe as the family validated it
  effects?: EffectRenderReport;        // what the effect plan applied and skipped
};
```

- **The page.** The entry is one HTML file with its CSS inlined, as the compiler has always
  produced it. Assets the page references are separate files at their `destination` paths.
- **Brand tokens** replace the same keys of `recipe.brand` before the family validates the
  recipe. The family schema decides which keys exist; the public families take `name` and
  `descriptor`. Unknown keys and markup are refused by the family's validator. Neither the recipe
  nor the tokens are changed.
- **Assets.** `assets.manifest` is the approved roster to render against (default: the
  compiler's own). The resolver is called once per asset the page uses, one at a time, in roster
  order. The resolver gets its own copy of each descriptor, so it cannot change what is verified or
  where a file goes. The publisher copies the returned bytes, then checks size, file signature, byte
  count and SHA-256 against the roster with the compiler's own verifier. Two files at one path are
  refused before any resolver runs. A page that uses no asset never
  calls it. None of the public family packages ships image assets today.
- **Errors** are `PublisherError` with a `code`: `unsealed-compiler` (a compiler copy without
  `resources.ts` or without a resource table of strings, which would read its own files, or one
  that cannot verify asset bytes),
  `invalid-spec`, `invalid-brand-tokens`, `missing-asset-resolver`, `asset-rejected`. Booking slot
  errors are `BookingEmbedError` (`code: 'invalid-booking-embed'`). Validation errors from the
  family (a bad recipe, an unknown placement) pass through unchanged.

### Guarantees and how they are tested

| Guarantee | Test |
|---|---|
| The publisher changes no output: every public family's reference page, three effect plans and the booking cases match recorded digests. The plain pages were recorded on `main` before this package existed. | `tests/golden.test.ts` (`UPDATE_GOLDEN=1` rewrites `tests/golden/pages.json` after an intended change) |
| Equal inputs give equal bytes: twice, from equal copies, from a bundle or from disk, with any resolver timing. Inputs are not mutated, an edit to a returned effect declaration cannot reach a later compile, and an edited (unfrozen) resource table is never served from a stale cache. | `tests/determinism.test.ts` |
| No ambient input: with every reading `fs` / `fs/promises` call made to throw, and `process.env` (reads, `in`, key listing, descriptors), the clock (`Date()`, `new Date()`, `Date.now`, `performance.now`, `process.hrtime` and `.bigint`) and randomness (`Math.random`, the `node:crypto` random functions, `crypto.randomUUID`, `crypto.getRandomValues`) watched, every family compiles with zero accesses. A sanity test proves each watch fires. A child process under `node --permission` that may read only `dist/` compiles to the golden bytes. An edited resource table changes the page; a missing resource fails rather than falling back to disk. | `tests/sealed.test.ts` |
| Assets come only from the resolver and are verified; a resolver cannot change a descriptor, and two files never share a path. | `tests/assets.test.ts` |
| The packed tarball works in another project. | `tests/consumer.test.ts` |

The output carries no timestamps or random ids, so there is no clock or seed to inject.

## Booking embed slot

A typed section that puts a booking widget on the page, so a visitor books from the site and the
booking lands in the business's booking system (the ZeroSum booking widget: a hosted page at
`<api>/book/<key>` and a script at `<api>/embed.js`).

```ts
type BookingEmbed = {
  id: string;                          // the section id: lowercase letters, digits, hyphens; unused on the page
  placement?: { after: string } | { before: string };  // an element id on the page
  heading: string;                     // ≤ 120 characters; also the frame's accessible title
  body?: string;                       // ≤ 400 characters
  key: string;                         // the widget key: "zsb1_" and 64 of A–Z a–z 0–9 _ -
  pageUrl: string;                     // the key's hosted booking page, <api>/book/<key> (script mode: exactly <scriptUrl origin>/book/<key>)
  mode: 'iframe' | 'script';
  scriptUrl?: string;                  // exactly <api>/embed.js, no query; required in script mode (same origin as pageUrl), refused in iframe mode
  height?: number;                     // 320–2000 CSS px, default 720
  linkLabel?: string;                  // ≤ 80 characters, default "Open the booking page"
};
```

- **`iframe` mode** renders an `<iframe>` of `pageUrl` (lazy, sandboxed to
  `allow-scripts allow-forms allow-same-origin`, `strict-origin-when-cross-origin` referrer). No
  script runs on the site.
- **`script` mode** renders an empty `<div data-zs-booking="<key>" data-zs-title="<heading>">` and
  adds `<script src="<scriptUrl>" async>` once, just before `</body>`. The script fills the element
  with a frame of `<script origin>/book/<key>` and resizes it to fit; until then the empty element
  is hidden. Every copy of the script mounts every `[data-zs-booking]` element on the page, so all
  script-mode slots on a page must use the same `scriptUrl`, and `pageUrl` must share its origin.
- Both modes keep a plain link to `pageUrl` beside the widget (never inside the element the script
  replaces), so booking still works with frames or scripts blocked.
- **Placement**: after or before the element with the given id. Omitted: at the end of `<main>`,
  else just before the page's last `<footer>`, else at the end of `<body>`. Slots with the same
  anchor keep their list order. The page is scanned as HTML: attributes are parsed (quoted `>`,
  any case, character references), and markup inside comments and the raw-text elements
  (`<script>`, `<style>`, `<textarea>`, `<title>`, `<iframe>`, `<noscript>`, `<noembed>`,
  `<noframes>`, `<xmp>`, `<plaintext>`) is never an anchor. Script text follows HTML's escape
  states, so a `</script>` hidden by `<!--<script>` does not end it. Nor is anything inside a
  `<template>`, which is not in the document, or inside a `<select>`, which accepts only options,
  option groups, `<hr>`, text and comments (anything else is refused). A `<frameset>` page is
  refused, and so is markup inside `<noscript>`, which a browser without scripting parses as HTML.
  Table parts (`<tr>`, `<td>`, …), `<html>`, `<head>`, `<body>` and head content (`<title>`,
  `<meta>`, `<style>`, …) are never anchors; a whole `<table>` is. Nor are formatting elements
  (`<a>`, `<b>`, `<em>`, …), which HTML's error repair can clone into two, or a `<form>` opened
  inside another form, which a browser discards. Tags, comments (`<!-->`,
  `--!>`), bogus comments (`<!x>`, `<?x>`, `</ x>`), unclosed quotes and character references
  (`&#120` without `;` too) follow the HTML tokenizer, in one linear pass. Inline `<svg>` and
  `<math>` are foreign content: nothing inside one is an anchor (the `<svg>` itself can be), and a
  page whose inline SVG or MathML holds a CDATA section, an HTML tag that ends it early (`<p>`,
  `<div>`, …), markup inside `<title>`, `<desc>`, `<foreignObject>` or a MathML text element, or a
  stray end tag is refused rather than guessed at. Plain icons (`<svg><path/></svg>`) are fine.
- **Content-Security-Policy.** Family pages ship a strict CSP `<meta>` (`default-src 'none'`).
  The slot widens it as little as works: `frame-src` gets the booking origin(s), and in script mode
  `script-src` gets exactly the widget script URL (any effect script hashes stay). That URL must be
  `<api>/embed.js`: a CSP source ending in `/`, or a bare origin, would allow every script under it. A server that
  sends its own CSP header for the site must allow the same sources.
- **Refused**: invalid fields; a script URL other than `<api>/embed.js`; a key not in the widget's format (the widget ignores any other, so
  it would never mount); a `pageUrl` that is not that key's booking page (so the widget and the
  fallback link always book the same calendar); URLs that are not `https` (plain `http` only for `localhost` and
  `127.0.0.1`), whose host is not a plain DNS name or IPv4 address (so no `*`, `;`, `_` or IPv6
  literal, which a CSP source cannot express safely), or that carry credentials or a fragment;
  two script URLs on one page; a slot id used twice or already on the page; an anchor that matches
  no element or several; an `after` anchor that is a void element; and static-prototype pages
  (`app-shell`, `crm-dashboard`), whose controls are not wired.
- The section is spliced in before the effect plan applies, so the plan's page byte budget counts
  it; the widget script is added after, because the effect step authorizes only inline scripts it
  can hash.

The pure helpers are exported for callers that splice their own pages: `parseBookingEmbed` (one
slot), `parseBookingEmbeds` (a page's list, with the rules across slots), `renderBookingEmbed`, `spliceBookingEmbeds` (sections and `frame-src`), `finishBookingEmbeds`
(scripts and `script-src`), `allowCspSource` and `BOOKING_EMBED_CSS`.

The slot is a publisher (library) capability. The Mish UI and the `od` CLI do not offer it yet;
it is for headless publishing from the business dashboard.

## Lower-level calls

- `renderPage(compiler, recipe, entry, { effects?, compose?, approvedAssets? })`: one synchronous
  render inside the compiler's resource scope, returning the compiler's raw result. The fast lane
  and the daemon call it for every draft. It also serves older, unsealed copies.
- `readEffectDeclaration(compiler)`: the family's effect placements (a fresh copy), or `null`.
- `linkHonestyCheck(compiler)`: the shared link-honesty check, when the copy ships one.
- `applyBrandTokens(recipe, tokens)` and `isSealed(compiler)`.

`@mish/publisher/node` adds `loadFamilyCompiler(packageDir, family)` (returns the compiler, the
package and assets directories, and the copy's verified `readApprovedAsset`),
`directoryAssetResolver(loaded, root?)` and `collectCompilerResources(scriptsDir)`.

## How a compiler is sealed

Every Agency Site compiler copy is synced from `plugins/_official/shared/agency-compiler/scripts/`.
Its `resources.ts` routes each static read (`catalog/hyperui/<family>.css`,
`catalog/CATALOG.json`, `families/<family>/catalog.json`, `catalog/components/<id>/…`) through
`withCompilerResources(table, fn)`. Inside that scope the table is the only source, and a value
that is not a plain object of strings is refused rather than read as "no table"; a table that
is not frozen is copied and frozen for the scope, so parsed caches never outlive an edit. Outside
it, the copy reads its own files as before (a missing required file raises the native `ENOENT`, and
only successful reads are kept), so the CLI scripts and the daemon keep working unchanged.

`scripts/build.ts` loads each family package from `plugins/_official/examples/agency-<family>/`,
collects its table, and bundles the copy's code with esbuild and the table, roster, reference
recipe and schema inlined as data.

## Commands

```sh
pnpm --filter @mish/publisher build       # tsc + the family bundles into dist/
pnpm --filter @mish/publisher test        # builds, then runs tests/*.test.ts
pnpm --filter @mish/publisher typecheck
```

`pnpm install` builds this package before `@mish/agency-fast-lane`, which imports its `dist/`. In
an install context without `plugins/` or the repository `LICENSE` (the Docker build installs before
it copies them), the build makes the code entries only and says so; the daemon there loads families
from disk through `@mish/publisher/node`. The packaged desktop app installs this package from its
own `pnpm pack` tarball, like the other internal packages (`tools/pack`).
Rebuild it after changing the shared compiler or a family package, then run the golden test.
