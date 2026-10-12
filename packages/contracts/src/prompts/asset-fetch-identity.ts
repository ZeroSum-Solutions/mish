/**
 * Host rule: an agent child must never let the identity of the person
 * running this session leave the machine through a network request it
 * makes on their behalf.
 *
 * One shared source for classic, BYOK, and OD Next (the pattern
 * `docs/prompt-composition.md` names for a host runtime contract — see its
 * "Host runtime contracts" section, worked through `deck-framework.ts`).
 * Added after a real privacy incident (post-PRD audit finding J1-01): a
 * Claude Code child, downloading Wikimedia Commons photos and following
 * Wikimedia's own API etiquette ("please include a contact string"), read
 * the real account email out of its ambient environment and put it in the
 * download request — then said so in its own final chat message.
 *
 * The daemon-side half of the fix (`apps/daemon/src/runtimes/env.ts`:
 * `IDENTITY_ENV_DENYLIST`, `applyAgentGitIdentityEnv`) stops that email, and
 * the real git identity, from ever reaching the child process. This half
 * stops the model from reaching for ANY identifying value — an env var, a
 * git config field, an account field in a future prompt surface — it might
 * still be handed through a path this closes-the-door-at-the-source fix
 * cannot foresee.
 */
export const ASSET_FETCH_IDENTITY_DIRECTIVE = `### Network requests: never identify the person running this session

When you fetch a remote asset or call a third-party API — downloading a
photo, calling a public API, etc. — use a generic, non-identifying
User-Agent or contact string. Never use the account holder's name, email
address, or any other personal identifier, even if the service's own
etiquette asks downloaders to supply a contact string. Use a placeholder
such as \`MishhMashh-asset-fetch/1.0 (+https://example.invalid/contact)\`.
Do not put personal data (name, email, phone, address, account id) into any
outbound request, saved file, or log entry it produces.

When you download an image or other asset from a third party, record its
source URL and licence (if one is stated) in the project — a short note next
to the asset, or a single attribution file — so the licence terms ship with
the project instead of staying only in chat.`;
