import { SIDECAR_DEFAULTS } from "@mish/sidecar-proto";
import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseChannelDescriptor,
  releaseInstallIdentity,
} from "@mish/release";

import type { ToolPackConfig } from "../config/index.js";
import { MAC_PRODUCT_DISPLAY_NAME } from "./constants.js";

export type MacInstallIdentity = {
  appId: string;
  executableName: string;
  installerTitle: string;
  productName: string;
  publicAppBundleName: string;
  systemAppBundleName: string;
};

function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function resolveMacInstallIdentity(config: Pick<ToolPackConfig, "namespace" | "appVersion">): MacInstallIdentity {
  const namespaceToken = sanitizeNamespace(config.namespace);
  const channel = releaseChannelFromVersion(config.appVersion)
    ?? releaseChannelFromNamespace(config.namespace, SIDECAR_DEFAULTS.namespace);
  const legacyIdentity = channel == null
    ? { appId: "io.mish.desktop" }
    : releaseInstallIdentity(channel);
  const productName = channel == null || channel === "stable"
    ? MAC_PRODUCT_DISPLAY_NAME
    : `${MAC_PRODUCT_DISPLAY_NAME} ${releaseChannelDescriptor(channel).displayLabel}`;
  const channelIdentity = { appId: legacyIdentity.appId, productName };
  const publicAppBundleName = `${channelIdentity.productName}.app`;
  const systemAppBundleName = channel != null
    ? publicAppBundleName
    : `${MAC_PRODUCT_DISPLAY_NAME}.${namespaceToken}.app`;

  return {
    ...channelIdentity,
    executableName: channelIdentity.productName,
    installerTitle: channel == null ? `${MAC_PRODUCT_DISPLAY_NAME}-${namespaceToken}` : channelIdentity.productName,
    publicAppBundleName,
    systemAppBundleName,
  };
}
