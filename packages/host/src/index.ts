/**
 * @module host
 *
 * Public barrel for `@mish/host` — the Mishh Mashh renderer host-bridge
 * protocol. Re-exports the exact prior flat surface from the cohesive sibling
 * modules: the wire protocol (constants + types), bridge detection/validation,
 * adapter-result normalizers, and the renderer-facing action wrappers. This
 * file contains no logic.
 */

// --- protocol: constant registries + wire types ---
export {
  MISH_HOST_GLOBAL,
  MISH_HOST_VERSION,
  MISH_HOST_APPEARANCE_THEMES,
  MISH_HOST_CLIENT_TYPES,
  MISH_HOST_UPDATER_ACTIONS,
  MISH_HOST_UPDATER_STATES,
} from "./protocol.js";
export type {
  MishHostClientType,
  MishHostDroppedDirectoryListing,
  MishHostDroppedDirectoryRefusal,
  MishHostClient,
  MishHostFailure,
  MishHostActionResult,
  MishHostWorkspaceContext,
  MishHostProjectImportInit,
  MishHostProjectImportSuccess,
  MishHostProjectImportResult,
  MishHostProjectReplaceWorkingDirSuccess,
  MishHostProjectReplaceWorkingDirResult,
  MishHostPickWorkingDirSuccess,
  MishHostPickWorkingDirResult,
  MishHostPdfPrintOptions,
  MishHostCaptureClip,
  MishHostCaptureOptions,
  MishHostCaptureSuccess,
  MishHostCaptureResult,
  MishHostPreviewNavigationFailure,
  MishHostPreviewNavigationFailureListener,
  MishHostAppearanceTheme,
  MishHostBrowserClearDataOptions,
  MishHostUpdaterAction,
  MishHostUpdaterState,
  MishHostUpdaterMode,
  MishHostUpdaterChannel,
  MishHostUpdaterActionOptions,
  MishHostUpdaterCapabilitySet,
  MishHostUpdaterPathSnapshot,
  MishHostUpdaterChecksumSnapshot,
  MishHostUpdaterArtifactSnapshot,
  MishHostUpdaterProgressSnapshot,
  MishHostUpdaterErrorSnapshot,
  MishHostUpdaterInstallResult,
  MishHostUpdaterReleaseSnapshot,
  MishHostUpdaterIncomingSnapshot,
  MishHostUpdaterCacheLifecycleTrigger,
  MishHostUpdaterReleaseLifecycleState,
  MishHostUpdaterCacheLifecycleSummary,
  MishHostUpdaterCacheSnapshot,
  MishHostUpdaterReinstallReason,
  MishHostUpdaterReinstallSnapshot,
  MishHostUpdaterStatusSnapshot,
  MishHostUpdaterResult,
  MishHostUpdaterStatusListener,
  MishHostUpdaterMenuLabels,
  MishHostUpdaterOpenDialogRequest,
  MishHostUpdaterOpenDialogListener,
  MishHostBridge,
  MishHostGlobalScope,
} from "./protocol.js";

// --- detection: locate + validate the injected bridge ---
export {
  isMishHostBridge,
  getMishHost,
  isMishHostAvailable,
  detectMishHostClientType,
} from "./detection.js";

// --- normalize: adapter result -> renderer contract ---
export {
  normalizeMishHostProjectImportResult,
  normalizeMishHostProjectReplaceWorkingDirResult,
  normalizeMishHostPickWorkingDirResult,
} from "./normalize.js";

// --- actions: renderer-facing host action wrappers ---
export {
  openHostExternalUrl,
  openHostProjectPath,
  clearHostBrowserData,
  captureHostPage,
  pickAndImportHostProject,
  pickAndReplaceHostProjectWorkingDir,
  pickHostWorkingDir,
  printHostPdf,
  setHostPetVisible,
  getHostUpdaterStatus,
  checkHostUpdater,
  clearHostUpdaterCache,
  downloadHostUpdater,
  installHostUpdater,
  quitHostAfterUpdaterInstallerOpen,
  getLatestHostPreviewNavigationFailure,
  subscribeHostUpdater,
  subscribeHostUpdaterOpenDialog,
  subscribeHostPreviewNavigationFailure,
  setHostUpdaterMenuLabels,
} from "./actions.js";
