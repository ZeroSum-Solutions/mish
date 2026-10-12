import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_KEYS,
  MISH_SIDECAR_CONTRACT,
  SIDECAR_DEFAULTS,
  SIDECAR_SOURCES,
} from "@mish/sidecar-proto";
import { bootstrapSidecarProcess, readCurrentSidecarStamp } from "@mish/sidecar";
import { releaseChannelFromNamespace } from "@mish/release";

import {
  PACKAGED_NAMESPACE_ENV,
  resolvePackagedAmrProfile,
  type PackagedConfig,
} from "./config.js";
import {
  parsePackagedHeadlessRequest,
  runPackagedHeadless,
} from "./headless-runtime.js";
import { resolvePackagedNamespacePaths } from "./paths.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function resolveHeadlessNamespaceBaseRoot(): string {
  const odDataDir = process.env.OD_DATA_DIR;
  if (odDataDir != null && odDataDir.length > 0) {
    return join(resolve(odDataDir.replace(/^~/, homedir())), "namespaces");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataBase =
    xdgDataHome != null && xdgDataHome.length > 0
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(dataBase, "mish", "namespaces");
}

function resolveHeadlessAmrProfile(): PackagedConfig["amrProfile"] {
  return resolvePackagedAmrProfile(process.env.MISH_AMR_PROFILE);
}

function resolveHeadlessConfig(): PackagedConfig {
  const namespace = MISH_SIDECAR_CONTRACT.normalizeNamespace(
    process.env[PACKAGED_NAMESPACE_ENV] ?? SIDECAR_DEFAULTS.namespace,
  );
  const namespaceBaseRoot = resolveHeadlessNamespaceBaseRoot();

  // OD_RESOURCE_ROOT may be set by a launcher script; otherwise default to a
  // sibling mish/ directory relative to the node_modules that contain
  // this file — the layout written by tools-pack linux headless-install.
  const resourceRoot =
    process.env.OD_RESOURCE_ROOT
    ?? join(__dirname, "..", "..", "..", "mish");

  return {
    amrProfile: resolveHeadlessAmrProfile(),
    appVersion: null,
    daemonCliEntry: null,
    daemonSidecarEntry: null,
    namespace,
    namespaceBaseRoot,
    nodeCommand: null,
    resourceRoot,
    telemetryRelayUrl:
      process.env.MISH_TELEMETRY_RELAY_URL?.trim() || null,
    updateMetadataUrl: process.env.OD_UPDATE_METADATA_URL?.trim() || null,
    posthogKey: process.env.POSTHOG_KEY?.trim() || null,
    posthogHost: process.env.POSTHOG_HOST?.trim() || null,
    velaWebUrl: process.env.OD_VELA_WEB_URL?.trim() || null,
    velaWebUrls: (() => {
      try {
        return JSON.parse(process.env.OD_VELA_WEB_URLS ?? '{}') as Record<string, string>;
      } catch {
        return {};
      }
    })(),
    webSidecarEntry: null,
    webStandaloneRoot: null,
    webOutputMode: "server",
  };
}

const headlessRequest = parsePackagedHeadlessRequest([
  "--headless",
  ...process.argv.slice(2),
]);

async function main(): Promise<void> {
  const config = resolveHeadlessConfig();
  const paths = resolvePackagedNamespacePaths(config, config.namespace, process.env);
  const currentStamp = (() => {
    try { return readCurrentSidecarStamp(); } catch { return null; }
  })();
  const stamp = currentStamp ?? {
    app: APP_KEYS.DESKTOP,
    channel: releaseChannelFromNamespace(config.namespace, "default") ?? "stable",
    mode: "headless",
    namespace: config.namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  };
  if (await bootstrapSidecarProcess(stamp, {
    dataRoot: paths.dataRoot,
    ownerPid: null,
    port: 0,
    runtimeRoot: paths.runtimeRoot,
  })) return;
  await runPackagedHeadless(config, headlessRequest, {
    mcpBootstrapLaunch: {
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), "--headless"],
    },
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `mish headless failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
