# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue or pull request.

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and the steps to reproduce it.

This opens a private GitHub Security Advisory that only the maintainers can see. We aim to reply within a few working days and will keep you informed until the fix ships. We credit reporters in the advisory unless you ask us not to.

## Supported versions

Only the latest release receives security fixes. Please check that the problem still occurs on the latest release before you report it.

## Scope

Mish is a local-first desktop app. The daemon (`apps/daemon`) listens on a loopback address by default and serves the desktop shell, the web UI and the `od` CLI on the same machine. It can run agents and shell tools and fetch URLs on the user's behalf.

In scope:

- A web page, another site, or another user on the network that can make the daemon or the web sidecar act for it (for example cross-site requests, DNS rebinding, request forgery, or command injection).
- Ways to read or change project files, credentials or settings without the local user's consent.
- Problems in a deployment that sets `OD_BIND_HOST` with `OD_API_TOKEN`, as documented.

Out of scope:

- Actions that the local user starts on purpose, such as running an agent or a shell tool they chose, or pointing a provider at a URL they chose.
- Attacks that need code execution as the local user, or physical access to the machine.
- Deployments that disable the documented protections (for example `OD_DISABLE_API_AUTH=1` without an authenticating proxy).
