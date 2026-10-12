import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseInstallIdentity,
} from "@mish/release";

const DEFAULT_WINDOW_TITLE = "Mishh Mashh";

export function resolvePackagedWindowTitle(config: { appVersion: string | null; namespace: string }): string {
  const channel =
    releaseChannelFromVersion(config.appVersion) ??
    releaseChannelFromNamespace(config.namespace);
  return channel == null
    ? DEFAULT_WINDOW_TITLE
    : releaseInstallIdentity(channel).productName.replace(/^Mish/, DEFAULT_WINDOW_TITLE);
}
