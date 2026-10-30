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
| `GET /api/linkpages`, `GET/PUT/DELETE /api/linkpages/:slug` | List, read, replace, delete |
| `GET /api/linkpages/:slug/render?origin=` | The page as HTML, in a CSP sandbox, for the preview frame |
| `GET /api/linkpages/:slug/export?origin=` | The site files |
| `POST /api/linkpages/:slug/publish` | `{ origin?, trackBase? }` returns a `LinkPagePublishResult`: the file list ready to deploy. `published` is false until a host exists |
| `PUT /api/linkpages/:slug/assets/:name` | A picture, raw body. Images only (png, jpeg, webp, gif), at most 2 MB, type checked against the bytes. No SVG |
| `GET /api/linkpages/:slug/assets/:name` | The picture, so the preview resolves `assets/<name>` |
| `POST /api/linkpages/:slug/events` | A view, click or signup from local preview. Validated with the contract, a filled `website` honeypot field is dropped silently, appended to `linkpages/<slug>/events.jsonl` (capped at 5 MB) |

Pages live under the daemon's data folder (`linkpages/<slug>/page.json`, `assets/`, `events.jsonl`),
never in the repository.

## Instagram and TikTok

Both platforms show little without the creator's login, and only a **business or creator account**
can be read through their official APIs. The web view has a Connect step for them that says so and
uses the existing Composio connectors state (`connectConnector`, connector statuses). A build that
names no connected accounts uses the login already connected in Mish; the browser never handles a
connected-account id. Without a login the page is built from what any visitor can see and the
response lists `needs`.

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
