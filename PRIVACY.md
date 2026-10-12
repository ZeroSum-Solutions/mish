# Privacy

This page describes what data Mishh Mashh sends off your machine, and when. It covers the code in this repository as ZeroSum Solutions runs it. The controls are under **Settings → Privacy**.

## Summary

- Mishh Mashh is **local-first**. Projects, generated files and your API keys stay on your machine.
- **Telemetry is off.** The app sends product analytics and crash reports only when a telemetry key (`POSTHOG_KEY`) is set when the daemon starts or the desktop app is packaged. Neither `pnpm tools-dev` nor `scripts/team-setup.sh` sets one (`tools-dev` does load your own `.env` files, so a key in one of them would turn telemetry on), and this repository's workflows have no telemetry secrets. So the app sends no telemetry to ZeroSum Solutions or to anyone else.
- **Model calls go where you choose.** When you run an agent or a model, the app sends your prompt and context to that agent or provider (for example Claude Code, Codex, DeepSeek or Cerebras). Their privacy terms apply to that data.
- **Improve prompt** sends the prompt you are improving to one model lane: with **Settings → Labs → Faster Improve prompt** on and an OpenRouter key set, to OpenAI's GPT Terra through OpenRouter; otherwise to Claude through your signed-in Claude Code CLI.
- **Agency builds** send the brief to Jev (TypeSafe) for routing and fact checks, and to DeepSeek or Cerebras for the fill.
- **Vercel deploys** run only when you choose **Share → Vercel** or `od deploy`. The daemon uploads the page you deploy, and the files it needs, to Vercel with your Vercel token.

## Upstream services

Mishh Mashh is a fork of an upstream project. The upstream network calls are off by default. Each one runs only when an operator sets its URL:

| What | Opt-in variable |
|---|---|
| Quality-trace relay (Langfuse) | `MISH_TELEMETRY_RELAY_URL` |
| AMR entry and profile analytics mirror | `MISH_AMR_ANALYTICS_URL` |
| Download-attribution ledger | `OD_ATTRIBUTION_LEDGER_URL` |
| What's New card | `OD_WHATS_NEW_URL` |
| Desktop updater | `OD_UPDATE_METADATA_URL` |

Two upstream calls remain:

- **AMR.** If you choose AMR sign-in or AMR model routing, the app calls `amr-api.mish.invalid`. AMR is an upstream service, not a ZeroSum service. Its own terms apply.
- **Hosted preview images.** The visual-style picker and plugin previews load images from `repo-assets.mish.invalid`. The request shows your IP address to that host.

The full record is in [`docs/legal/LICENSE-COMPLIANCE.md`](docs/legal/LICENSE-COMPLIANCE.md), "Network defaults".

## If telemetry is turned on

If an operator sets `POSTHOG_KEY`, the upstream telemetry code runs as written:

- On first run a banner asks you to **Share** or **Don't share**. **Settings → Privacy** changes the choice at any time.
- **Anonymous metrics** (run counts, token use, errors, timing, masked session replay) and **conversation and tool content** (prompts, responses and tool data, truncated and scrubbed) are optional channels.
- **Safety and reliability reports** (crashes, startup failures, broken streams) are always sent while a key is set, with scrubbed paths and inputs.
- The app never sends generated file contents, API keys, tokens or other stored credentials.
- **Settings → Privacy → Delete my data** rotates the anonymous ID and turns off the optional channels.

Before anyone turns telemetry on for ZeroSum builds, update this page with the destination and the retention policy.

## Your API keys

Keys you add for agents and model providers are stored on your machine. The daemon uses them only to call the provider you chose. They are never telemetry fields.

## Questions

Ask Devin at ZeroSum Solutions. This page changes in the same pull request as any change to what the app sends.
