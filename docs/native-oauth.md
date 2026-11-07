# Native OAuth (slice 1: TikTok)

Mish now has its own OAuth provider behind the connector layer. Slice 1 covers TikTok only (Login Kit
plus the Display API). It replaces Composio for TikTok; Composio still serves every other connector,
and Instagram's Composio path is untouched.

## How it works

- **Catalog.** `apps/daemon/src/connectors/native/definitions.ts` defines a `tiktok` connector with
  `authentication: 'native'`. While the native provider is installed (the daemon does this at start),
  it replaces the Composio `tiktok` entry of the same id. Contracts: `ConnectorAuthDetail.provider`
  gains `'native'` (`CONNECTOR_AUTH_PROVIDERS`), plus `parseNativeOAuthCallbackQuery`.
- **Connect.** `POST /api/connectors/tiktok/connect` returns `auth.kind = 'redirect_required'` with the
  TikTok authorize URL (`client_key`, comma-separated `scope`, `response_type=code`, `redirect_uri`,
  `state`, PKCE `code_challenge` + `S256`). Browser-supplied credentials are refused.
- **State.** 32 random bytes, bound to the connector, single use, 10 minute lifetime, kept in daemon
  memory with the PKCE verifier (and the opener's callback nonce). Mismatch, expiry and replay are
  separate errors. A state is burned even when the exchange fails.
- **Callback.** `GET /api/connectors/oauth/callback/tiktok` (the same route shape Composio uses)
  verifies the state, exchanges the code (`POST https://open.tiktokapis.com/v2/oauth/token/`,
  form-encoded, with `code_verifier`), names the account from `user/info`, and writes the tokens to the
  encrypted store. The plaintext credential record keeps only `{ provider: 'native', accountId }`.
- **Refresh.** Lazy, on use, when the access token has under 5 minutes left. One refresh at a time per
  account (a promise lock). TikTok returns a new refresh token every time, so the new pair is written to
  the store before the new access token is used. `invalid_grant` (an old refresh token, or a revoked
  grant) becomes "reconnect TikTok". A 401 from the API forces one refresh and one retry.
  `needsRefresh` / `refreshIfNeeded` are the interface for a scheduled job (see "Not done").
- **Executor.** `request(connectorId, accountId, {endpoint, method, headers, body})` is the same narrow
  seam the Composio proxy has. It sends the Bearer token only to `https://open.tiktokapis.com/v2/...`
  (no other host, port, userinfo or http; `/v2/oauth/*` is blocked), through the daemon SSRF-guarded
  fetch with redirects off, a 15 s timeout and a 1 MB response cap. Caller `Authorization` headers are
  dropped.
- **Disconnect.** Revokes the access token at `/v2/oauth/revoke/` (best effort), then deletes the
  encrypted record and the credential record.
- **Link pages.** `createNativeAwareLoginProvider` (`apps/daemon/src/linkpage/login.ts`) routes a native
  account id (`native-tiktok-<24 hex>`) to the native executor and every other id to Composio. The
  build's auto-resolution prefers a connected native account. The engine's `tiktok` connector is
  unchanged in shape. It asks for the fields below, degrades through smaller field sets when TikTok
  rejects some, and keeps the profile even if the video list fails. Any login failure still falls back
  to the public page with a warning.

Display API fields: user `open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,username,follower_count,likes_count,video_count`;
videos `id,title,cover_image_url,create_time` (`max_count` up to 20). The video URL is built from the
username and id when TikTok sends no `share_url`. Field names are partly unverified, which is why the
ladders exist (`native/tiktok.ts`, `packages/linkpage/src/connectors.ts`).

## Scopes

One constant: `TIKTOK_SCOPES` in `apps/daemon/src/connectors/native/tiktok.ts`
(`user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`). TikTok has announced a scope
migration. When it lands, edit that list, the tool `requiredScopes` in `native/definitions.ts`, and the
scopes approved in the developer portal.

## Owner setup (sandbox first)

1. At developers.tiktok.com create an app. Add **Login Kit** and **Display API**. Create a **sandbox**
   target and add your own TikTok account as a sandbox user.
2. In Login Kit add the redirect URI Mish will use. It must end in
   `/api/connectors/oauth/callback/tiktok` and TikTok needs it to be https (a tunnel or your real host).
3. Set, in the daemon environment: `OD_TIKTOK_CLIENT_KEY`, `OD_TIKTOK_CLIENT_SECRET`,
   `OD_TIKTOK_REDIRECT_URI`. The client key and secret may instead live in the vault as
   `tiktok_client_key` and `tiktok_client_secret` (`zsvault add <id>`).
4. Set `OD_CONNECTOR_TOKEN_KEY` (below), restart the daemon, open Settings, connect TikTok.
5. Optional: `OD_TIKTOK_PKCE=base64url` (default), `hex` or `off`. The challenge encoding is standard
   RFC 7636 by default; TikTok's own docs describe a hex digest for some clients. If the code exchange
   fails with a verifier error, try `hex`, then `off`.

When anything is missing, connecting answers `CONNECTOR_AUTH_CONFIG_REQUIRED` with these steps and the
names of the missing variables. It never includes a value.

## Token key and storage

- Tokens are in `<dataDir>/connectors/native-tokens.json`, AES-256-GCM, a fresh 12-byte nonce per write,
  AAD = `[connectorId, accountId, schemaVersion]`, the `keyId` in each record. Mode 0600, temp file then
  rename, all access through one queue.
- Key: `OD_CONNECTOR_TOKEN_KEY` (32 random bytes, base64 or hex; `openssl rand -base64 32`), else the
  vault entry `od_connector_token_key`. A malformed value is an error, not a reason to try the next
  source. With no key, connecting fails closed (`key_unavailable`) before the user is sent to TikTok.
- Rotation: put the new key in `OD_CONNECTOR_TOKEN_KEY` and the old one(s) in
  `OD_CONNECTOR_TOKEN_KEY_PREVIOUS` (comma separated) or the vault entry
  `od_connector_token_key_previous`. Old records still read by `keyId`; `EncryptedTokenStore.rotate()`
  re-encrypts them all under the new key (no route calls it yet). Drop the old key after that.
- Losing the key means reconnecting TikTok. Tokens are never returned to the browser, logged or put in
  error messages.

## Not done yet

- **Instagram stays on Composio.** Next slice.
- **Scheduled refresh job.** Only lazy refresh exists. Without use, a refresh token lapses after about
  180 days and the owner reconnects. A job should call `refreshIfNeeded` per connected account daily.
- **Production review.** TikTok must approve the app and each scope before anyone but sandbox users can
  connect. Not requested.
- **Orphaned tokens.** If an API call finds the grant dead, the connector is marked as needing a
  reconnect and the plaintext record is dropped; the encrypted record stays until a reconnect replaces
  it or Disconnect runs. Harmless (encrypted), but unswept.
- **A write that fails after a refresh.** If TikTok rotates the refresh token and the store write then
  fails, the new token is lost and the owner reconnects. It is rare and explicit (`store_failed`).
- **Single account per connector.** Credential records are keyed by connector id, as for Composio.
- Unverified against live TikTok: PKCE challenge encoding, exact Display API field names, the
  `user.info.profile` field `username`.
