# Link pages

**Parent:** [`architecture.md`](architecture.md) · **Engine:** [`packages/linkpage`](../packages/linkpage/README.md) · **Contract:** [`packages/contracts/src/api/linkpage.ts`](../packages/contracts/src/api/linkpage.ts)

A link page is one tidy page for a creator, built from the places they already have online: a
website, a Substack, an Instagram or TikTok handle. The engine reads those places, derives a look
from them, and renders a static site (`index.html`, `llms.txt`, `links.json`, `spec.json`, pictures).

Link pages are not projects and not skills. They have their own store, so the web surface is an
entry view (Link pages in the left rail, `/link-pages`) and not a New Project tab
([`modes.md`](modes.md)).

## Three ways in

| Surface | Where |
|---|---|
| Web | Link pages view: [`LinkPageView.tsx`](../apps/web/src/components/LinkPageView.tsx) |
| CLI | `od linkpage …` ([`linkpage-cli.ts`](../apps/daemon/src/linkpage-cli.ts)) |
| HTTP | `/api/linkpages*` ([`routes/linkpage.ts`](../apps/daemon/src/routes/linkpage.ts)) |

All three use the validators in the contract package, so a bad request reads the same everywhere.

## `od` commands

```bash
od linkpage build --config sam.json      # { slug, sources, options, connectedAccounts?, save? }; '-' reads stdin
od linkpage list
od linkpage get sam
od linkpage asset sam ./me.png           # prints the path to use: assets/me.png
od linkpage render sam --out ./site --origin https://links.example.com
od linkpage publish sam --origin https://links.example.com --track-base https://links.example.com/go
od linkpage delete sam
```

`--json` prints the daemon's response. `publish` lists the files that would be deployed; it does
not upload anything (see hosting below).

## Endpoints

| Method and path | What |
|---|---|
| `POST /api/linkpages/build` | Build (and by default save) a page |
| `GET /api/linkpages`, `GET/PUT/DELETE /api/linkpages/:slug` | List, read, replace, delete. `GET` and `PUT` answer without `connectedAccounts`, and a `PUT` that sends them is refused (400); an edit never changes which login a page uses |
| `GET /api/linkpages/:slug/render?origin=` | The page as HTML, in a CSP sandbox, for the preview frame |
| `GET /api/linkpages/:slug/export?origin=` | The site files |
| `POST /api/linkpages/:slug/publish` | `{ origin?, trackBase? }` returns a `LinkPagePublishResult`: the file list ready to deploy (`url` is `<origin>/`). `published` is false until a host exists |
| `PUT /api/linkpages/:slug/assets/:name` | A picture, raw body, for a page that already exists (404 otherwise). Images only (png, jpeg, webp, gif), at most 2 MB, type checked against the bytes. No SVG |
| `GET /api/linkpages/:slug/assets/:name` | The picture, so the preview resolves `assets/<name>` |
| `POST /api/linkpages/:slug/events` | A view, click or signup from local preview. Validated with the contract, a filled `website` honeypot field is dropped silently, appended to `linkpages/<slug>/events.jsonl` (capped at 5 MB) |

Pages live under the daemon's data folder (`linkpages/<slug>/page.json`, `assets/`, `events.jsonl`),
never in the repository.

## Model

The builder reads people with a model in two lanes ([`linkpage/llm.ts`](../apps/daemon/src/linkpage/llm.ts)):

1. **OpenRouter first.** The key comes from the daemon key store, the same one the brief generator
   uses: `OPENROUTER_API_KEY`, then a key saved with `od agency config set --provider openrouter --key-stdin`,
   then the vault. The lookup is bounded (5 s) and the key is never logged. The model is pinned to
   `anthropic/claude-sonnet-5.5`: it reads pictures (the style-from-photos step sends image URLs, which
   the text-only fast-lane caller cannot), answers JSON mode cleanly, and matches the model the second
   lane runs.
2. **The `claude` command** (the owner's subscription) when there is no key, or when an OpenRouter
   call fails or runs past 60 s. A cancelled call is not retried. It runs the executable the daemon found
   on `PATH`, and because it reads text scraped from other people's sites it is locked down:
   `--tools Read` (the only tool), `--strict-mcp-config`, `--setting-sources ""` (no user or project
   settings, hooks or CLAUDE.md), `--disable-slash-commands`, `--permission-mode dontAsk`, the prompt on
   stdin, and a temporary folder that is deleted afterwards.
3. **No model**: the page is built from plain signals and the build warns.

## Instagram and TikTok

Both platforms show little without the creator's login, and only a **business or creator account**
can be read through their official APIs. The web view has a Connect step for them that says so and
uses the existing Composio connectors state (`connectConnector`, connector statuses). A build that
names no connected accounts uses the login connected in Mish right now (a saved id is used only when
none resolves); the browser never handles a connected-account id: it is not returned by `GET`/`PUT`
and a `PUT` cannot set it. Only `od linkpage build` (and a raw `POST /build`) can name one, and the
Composio proxy refuses an account whose owner it cannot confirm. Without a login, or when the login
read fails, the page is built from what any visitor can see (a failed login adds a warning) and the
response lists `needs`.

## The built site

A site is served at **its own root**, one subdomain (or domain) per creator, so everything in it is
relative to `/`: `assets/avatar.png`, `llms.txt`, `links.json`. `origin` is that root with no slug
path: the canonical link is `<origin>/`, `links.json` has `page_url: "<origin>/"` and `publish`
returns `url: "<origin>/"`. With `trackBase`, links in `index.html`, `links.json` (`tracked_url`) and
`llms.txt` go through `<trackBase>/<slug>/<block>/<index>` (ids URL-encoded). `llms.txt` does not
advertise an MCP endpoint: `handleMcp` exists in the engine but no route serves it yet.

Builds are forgiving about what they scrape: a font name that is not ASCII is folded to ASCII and one
that is not a name (a `clamp()` or size from a WordPress variable) is dropped for a system stack; a
post, social or link item with an address that is not a web address is dropped with a warning. Spec
checking (`checkPage`) also strips fields it does not know from blocks and the theme.

## Hosting plan (not built yet)

- **Static export on a subdomain.** `render` and `export` already produce a complete static site.
  Each creator's site is served from a subdomain of ours (for example `<slug>.links.example`), or
  from their own domain pointed at the same host. `origin` gives the canonical address and
  `trackBase` routes link clicks through a counter.
- **Public events.** The page posts signups and clicks to a small public endpoint on that host. The
  event module the daemon uses for local preview
  ([`linkpage/events.ts`](../apps/daemon/src/linkpage/events.ts)) is the pure part to reuse there.
  The daemon's own `/api` is loopback-only and rejects sandboxed-origin posts, so a preview frame
  cannot sign up; it works once the page is hosted.
- **Composio platform account.** One Composio platform account holds the app credentials; each
  creator gets their own connected account for Instagram and TikTok. Mish stores only the
  connected-account id, never a token. The proxy call in `connectors/composio.ts` is written
  against Composio's documented proxy endpoint and has not been run against a live account.

## Known gaps

Reviewed and left for later; none blocks the draft.

- N2, N5, N6, N7, N9, N10, N11: minor review notes (wording, small refactors, extra test cases) that
  were judged not worth the churn in this PR.
- `handleMcp` is not served by any route, so the hosted site has no MCP endpoint yet.
- The Instagram and TikTok request formats follow the platforms' documentation and have not been run
  against live accounts; the Composio proxy call is likewise untested live.
- The avatar picture needs a built page first (it is stored under the page's slug).
