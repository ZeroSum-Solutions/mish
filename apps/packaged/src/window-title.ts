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
  if (channel == null) return DEFAULT_WINDOW_TITLE;
  const productName = releaseInstallIdentity(channel).productName;
  // The beta name is already complete; other channels swap the "Mish" prefix.
  return channel === "beta" ? productName : productName.replace(/^Mish/, DEFAULT_WINDOW_TITLE);
}
