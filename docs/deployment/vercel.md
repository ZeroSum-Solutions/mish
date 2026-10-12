# Vercel

Two unrelated things in this repository involve Vercel:

1. **Deploying a project's page from the app.** The daemon uploads one project's page to your
   Vercel account. This is a product feature and works from a local install.
2. **Deploying this repository's web app.** The root [`vercel.json`](../../vercel.json) builds the
   web UI as a static site. The daemon does not run there, so the result is a UI shell only.

## Deploy a project page from the app

### Set up

The daemon talks to Vercel with your own Vercel token. Paste it once in the deploy dialog: open
the project, choose **Share**, then **Deploy to Vercel**. A team ID or team slug is optional. The
daemon saves the token on the machine it runs on (`PUT /api/deploy/config`) and reuses it for later
deploys. No `od` subcommand sets the token, so configure it in the app before using the CLI.

### Deploy

From the web app, use the same **Deploy to Vercel** dialog. From the CLI:

```bash
od deploy <projectId> --file index.html
od deploy <projectId> --file index.html --vercel-name bobs-bakery --public --json
od deploy name-check bobs-bakery --json
```

`od deploy --help` lists every flag. Both surfaces call `POST /api/projects/:id/deploy`; the
daemon ([`apps/daemon/src/deploy.ts`](../../apps/daemon/src/deploy.ts)) then calls the Vercel REST
API:

1. It creates the Vercel project for this Mish project, or reuses the one it saved earlier.
   `--vercel-name` (or **Site address** in the dialog) chooses the name; `od deploy name-check` is
   an advisory, team-local check and reserves nothing.
2. It uploads the page and the local files the page references. Preflight
   (`POST /api/projects/:id/deploy/preflight`) lists the same files. See
   [`docs/architecture.md` → Publish and deploy](../architecture.md#86-publish-and-deploy) for the
   publication allowlist.
3. It creates a preview deployment and polls it until Vercel reports `READY`, `ERROR`, `CANCELED`
   or `BLOCKED`, for about a minute at most.
4. Only a `READY` deployment takes the project's stable alias, so a failed deploy never replaces a
   working site.

Vercel deploys are preview deployments. A request for `--target production` is refused with
`400`; production targets and custom domains are not part of this flow.

### Results and errors

| Outcome | What you get |
|---|---|
| Deployment `READY` | The stable alias URL, with `access` set to `public`, `protected` or `unknown` |
| Deployment `ERROR`, `CANCELED` or `BLOCKED` | `VERCEL_DEPLOY_FAILED` (HTTP 502), with Vercel's reason when it gives one |
| Still building when polling stops | `VERCEL_DEPLOY_TIMEOUT` (HTTP 504). Check the Vercel dashboard, then deploy again |
| Site name already taken | `VERCEL_NAME_TAKEN` (HTTP 409), with a suggested name |

`access` is `public` only when Vercel confirms deployment protection is off and an anonymous
request reaches the page. **Make preview public** in the dialog, or `--public` on the CLI, turns
protection off for the whole Vercel project, including earlier deployments. With `--public`,
`od deploy` exits 1 unless access is `public`.

The repository's tests exercise this flow against stubs of Vercel's documented API, not a live
Vercel account.

Cloudflare Pages is the other provider (`--provider cloudflare-pages`); it shares the publication
allowlist. Agency-site specifics, such as naming and recovering from a lost create response, are
in [`docs/agency-site.md`](../agency-site.md).

## Deploy this repository's web app

The root [`vercel.json`](../../vercel.json) configures a Vercel project that uses the repository
root:

| Setting | Value |
|---|---|
| Install | `pnpm install` |
| Build | `OD_WEB_OUTPUT_MODE= pnpm --filter @mish/web build` (a static export) |
| Output | `apps/web/out` |
| Framework | none (`framework: null`) |
| Rewrites | App routes go to `/index.html`, except `/api`, `/artifacts`, `/frames` and `/_next` |

In the Vercel project settings, set the environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so
that Vercel uses the `pnpm@10.33.2` pinned in the root `package.json`. Vercel takes the Node
version from `package.json#engines` (`~24`). Browser source maps are not emitted when `VERCEL=1`,
so they are not published.

### What works on the Vercel URL

Only the static UI. The daemon owns every `/api/*` route and does not run on Vercel, so each API
request returns 404. Projects, agents, generation and the in-product deploy above do not work on the
Vercel URL, and the static build has no setting that points it at a remote daemon.

To use the product, run it where the daemon runs: locally with `pnpm tools-dev` (see
[`QUICKSTART.md`](../../QUICKSTART.md)), or self-hosted with [Docker](docker.md).
