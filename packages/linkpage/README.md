# @mish/linkpage

A headless engine for creator link pages. It reads what a creator already has online, derives a
look from it, and renders a static page plus the forms machines read. It touches no files,
environment variables or clock: `fetch`, `llm` and `login` come from the caller.

```ts
import { buildPage, renderPage, llmsTxt, linksJson, createLlm } from '@mish/linkpage';

const { spec, warnings, needs } = await buildPage({
  sources: [{ connector: 'website', ref: 'https://example.com' }],
  options: { slug: 'sam', links: [{ label: 'Shop', url: 'https://example.com/shop', featured: true }] },
  llm: createLlm({ apiKey }), // optional: reads the person and their images
  fetch,
});
const html = renderPage(spec, { origin: 'https://links.example.com', machine: true });
const text = llmsTxt(spec, { origin: 'https://links.example.com' });
const json = linksJson(spec, { origin: 'https://links.example.com' });
```

## Parts

| Export | What it does |
|---|---|
| `connectors` | `website`, `substack`, `instagram`, `tiktok`, `manual`. Each reads one source into a `Signal`. Pass `logins.instagram` / `logins.tiktok` (a `fetch` that carries the creator's login) to use the platform API. |
| `buildPage` | Runs the connectors, optionally reads the person and their images with an `llm`, and returns `{ spec, warnings, needs, person }`. A failing connector is skipped and reported. |
| `deriveTheme` | Signals to a `Theme`: palette (with contrast guards), fonts, mood and background effect (`glaze`, `mesh`, `grid`, `bubbles`). |
| `checkPage` | Cleans a page spec and throws a plain message on the first problem. |
| `renderPage` | One self-contained HTML page. |
| `llmsTxt`, `linksJson` | The page for language models and for scripts. |
| `handleMcp` | A JSON-RPC handler for a small MCP server (read profile and links, latest posts, subscribe). |
| `createLlm` | An OpenRouter client with `json({ system, user, images })`. |

## In the app

The engine is wired into the daemon and the web app (`docs/link-pages.md`). The daemon keeps pages
under its data folder, serves `/api/linkpages*`, and `od linkpage …` calls the same endpoints.
Pictures are uploaded with `PUT /api/linkpages/:slug/assets/:name` (png, jpeg, webp or gif, at most
2 MB, checked by content) and referenced as `assets/<name>`. The signup form and click counting post
to the page's own endpoint: pass `signup: { endpoint }` when building and `trackBase` when rendering.
`POST /api/linkpages/:slug/events` accepts those events for local preview and writes a local log.

## Node-only

`@mish/linkpage/node` exports `createClaudeCliLlm`, the same `json(...)` answered by the local
`claude` command on the person's own subscription. It spawns a process and writes temporary
files, so it is kept out of the pure entry point.

## Tests

```bash
pnpm --filter @mish/linkpage typecheck
pnpm --filter @mish/linkpage test
```
