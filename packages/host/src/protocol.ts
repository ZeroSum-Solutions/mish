import type { ReleaseChannel } from "@mish/release";

/**
 * @module protocol
 *
 * The Mishh Mashh renderer host-bridge wire contract: the injected-global name
 * and version, client/updater constant registries, and every request/result
 * type that crosses the host bridge — including the {@link MishHostBridge}
 * shape itself. Pure declarations only; depends on nothing else in the package.
 */

export const MISH_HOST_GLOBAL = "__od__";
export const MISH_HOST_VERSION = 2;

export const MISH_HOST_CLIENT_TYPES = Object.freeze({
  DESKTOP: "desktop",
} as const);

export type MishHostClientType =
  (typeof MISH_HOST_CLIENT_TYPES)[keyof typeof MISH_HOST_CLIENT_TYPES];

export type MishHostClient = {
  // BCP-47 locale string (e.g. "zh-CN", "pt-BR") the host process read from
  // the OS at startup. The renderer uses this so the packaged desktop app
  // can follow the OS language even when Chromium's built-in
  // `navigator.language` would have defaulted to en-US.
  osLocale?: string;
  platform?: string;
  type: MishHostClientType;
};

export type MishHostFailure = {
  details?: unknown;
  ok: false;
  reason: string;
};

export type MishHostActionResult =
  | { ok: true }
  | MishHostFailure;

/**
 * The workspace attribution the renderer gives the host so a folder import
 * lands in the caller's current workspace instead of the host's ambient one.
 *
 * This is a deliberate structural subset of the daemon/web
 * `WorkspaceCollabContext`, redeclared here rather than imported: this package
 * is the renderer host-bridge wire contract and must stay independent of the
 * daemon/web contracts package (enforced by the "stays independent from
 * daemon/web contracts" test). A full `WorkspaceCollabContext` is structurally
 * assignable to this type, so callers pass theirs unchanged.
 *
 * Only the fields the host actually forwards are modelled, and the enum-like
 * fields stay `string` because the host treats them as opaque pass-through
 * values — the daemon remains the authority that parses and validates them.
 * Deliberately no index signature: an interface never satisfies one, so adding
 * it would reject the very `WorkspaceCollabContext` callers pass. Callers hand
 * over a variable, not a fresh literal, so the extra fields ride along fine.
 */
export type MishHostWorkspaceContext = {
  lifecycleState: string;
  memberStatus: string;
  permissions: {
    canShareProjects: boolean;
    canWriteSyncedFiles: boolean;
  };
  role: string;
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: string;
};

export type MishHostProjectImportInit = {
  designSystemId?: string | null;
  name?: string;
  skillId?: string | null;
  workspaceContext?: MishHostWorkspaceContext | null;
};

export type MishHostProjectImportSuccess = {
  conversationId: string;
  entryFile: string | null;
  ok: true;
  projectId: string;
};

export type MishHostProjectImportResult =
  | MishHostProjectImportSuccess
  | {
      canceled: true;
      ok: false;
    }
  | MishHostFailure;

export type MishHostProjectReplaceWorkingDirSuccess = {
  baseDir: string;
  entryFile: string | null;
  ok: true;
};

export type MishHostProjectReplaceWorkingDirResult =
  | MishHostProjectReplaceWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | MishHostFailure;

export type MishHostPickWorkingDirSuccess = {
  baseDir: string;
  ok: true;
  // Single-use HMAC token (minted by the host main process for `baseDir`)
  // that the renderer threads into POST /api/projects/:id/working-dir once
  // the project exists. Lets the Home flow pick a folder before the project
  // is created without exposing the daemon's desktop-auth gate.
  token: string;
};

export type MishHostPickWorkingDirResult =
  | MishHostPickWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | MishHostFailure;

export type MishHostPdfPrintOptions = {
  deck?: boolean;
};

export type MishHostCaptureClip = { x: number; y: number; width: number; height: number };
export type MishHostCaptureOptions = { clip?: MishHostCaptureClip };
export type MishHostCaptureSuccess = { dataUrl: string; h: number; ok: true; w: number };
export type MishHostCaptureResult = MishHostCaptureSuccess | MishHostFailure;

export type MishHostPreviewNavigationFailure = {
  errorCode: number;
  eventId: number;
  frameName?: string;
  occurredAtMs: number;
  validatedUrl: string;
};

export type MishHostPreviewNavigationFailureListener = (
  failure: MishHostPreviewNavigationFailure,
) => void;

export type MishHostBrowserClearDataOptions = {
  cookies?: boolean;
  storage?: boolean;
};

/**
 * App theme values the renderer may pin the host window appearance to.
 * `light`/`dark` force the native window material (macOS under-window
 * vibrancy glass follows the OS appearance by default, which reads as a
 * muddy gray when the OS is dark but the app theme is explicitly light);
 * `system` restores following the OS.
 */
export const MISH_HOST_APPEARANCE_THEMES = Object.freeze({
  DARK: "dark",
  LIGHT: "light",
  SYSTEM: "system",
} as const);

export type MishHostAppearanceTheme =
  (typeof MISH_HOST_APPEARANCE_THEMES)[keyof typeof MISH_HOST_APPEARANCE_THEMES];

export const MISH_HOST_UPDATER_ACTIONS = Object.freeze({
  CHECK: "check",
  CLEAR_CACHE: "clear-cache",
  DOWNLOAD: "download",
  INSTALL: "install",
  QUIT: "quit",
  STATUS: "status",
} as const);

export type MishHostUpdaterAction =
  (typeof MISH_HOST_UPDATER_ACTIONS)[keyof typeof MISH_HOST_UPDATER_ACTIONS];

/** @internal Updater actions that return a status snapshot (every action except `quit`). */
export type MishHostUpdaterStatusAction = Exclude<
  MishHostUpdaterAction,
  typeof MISH_HOST_UPDATER_ACTIONS.QUIT
>;

export const MISH_HOST_UPDATER_STATES = Object.freeze({
  AVAILABLE: "available",
  CHECKING: "checking",
  DOWNLOADED: "downloaded",
  DOWNLOADING: "downloading",
  ERROR: "error",
  IDLE: "idle",
  INSTALLING: "installing",
  NOT_AVAILABLE: "not-available",
  UNSUPPORTED: "unsupported",
} as const);

export type MishHostUpdaterState =
  (typeof MISH_HOST_UPDATER_STATES)[keyof typeof MISH_HOST_UPDATER_STATES];

export type MishHostUpdaterMode = "js-incremental" | "package-launcher";
export type MishHostUpdaterChannel = ReleaseChannel;

export type MishHostUpdaterActionOptions = {
  payload?: Record<string, unknown>;
};

export type MishHostUpdaterCapabilitySet = {
  canApplyInPlace: boolean;
  canDownload: boolean;
  canOpenInstaller: boolean;
  requiresManualInstall: boolean;
};

export type MishHostUpdaterPathSnapshot = {
  downloadRoot?: string;
  manifestPath?: string;
};

export type MishHostUpdaterChecksumSnapshot = {
  algorithm: "sha256" | "sha512";
  url?: string;
  value?: string;
};

export type MishHostUpdaterArtifactSnapshot = {
  name?: string;
  platformKey?: string;
  size?: number;
  type?: string;
  url: string;
};

export type MishHostUpdaterProgressSnapshot = {
  receivedBytes: number;
  totalBytes?: number;
};

export type MishHostUpdaterErrorSnapshot = {
  code: string;
  details?: unknown;
  message: string;
};

export type MishHostUpdaterInstallResult = {
  activeVersion?: string;
  artifactPath?: string;
  dryRun?: boolean;
  helperLogPath?: string;
  launcherRuntimePath?: string;
  launchPath?: string;
  openedAt: string;
  path: string;
};

export type MishHostUpdaterReleaseSnapshot = {
  arch: string;
  artifact: MishHostUpdaterArtifactSnapshot;
  checksum: MishHostUpdaterChecksumSnapshot;
  channel: MishHostUpdaterChannel;
  downloadedAt: string;
  key: string;
  metadata?: Record<string, unknown>;
  path: string;
  platformKey: string;
  version: string;
};

export type MishHostUpdaterIncomingSnapshot = {
  arch: string;
  artifact: MishHostUpdaterArtifactSnapshot;
  channel: MishHostUpdaterChannel;
  key?: string;
  metadata?: Record<string, unknown>;
  progress?: MishHostUpdaterProgressSnapshot;
  startedAt: string;
  version: string;
};

export type MishHostUpdaterCacheLifecycleTrigger = "cold-start" | "manual" | "next-version-ready";

export type MishHostUpdaterReleaseLifecycleState =
  | "cleanup-deferred"
  | "cleanup-removed"
  | "deprecated"
  | "retained"
  | "unknown";

export type MishHostUpdaterCacheLifecycleSummary = {
  lastRunAt?: string;
  lastTrigger?: MishHostUpdaterCacheLifecycleTrigger;
  platform: string;
  releases: {
    cleanupDeferred: number;
    cleanupRemoved: number;
    deprecated: number;
    errors: number;
    retained: number;
    total: number;
    unknown: number;
  };
};

export type MishHostUpdaterCacheSnapshot = {
  lifecycle?: MishHostUpdaterCacheLifecycleSummary;
};

export type MishHostUpdaterReinstallReason =
  | "launcher-schema"
  | "outer-below-min"
  | "outer-version-unreadable";

/**
 * Present when the release feed requires a full installer reinstall instead of
 * an in-place payload update. `installedVersion` is the physically installed
 * outer package version; `url` is an optional operator-supplied explanation
 * link.
 */
export type MishHostUpdaterReinstallSnapshot = {
  installedVersion?: string;
  minVersion?: string;
  reason: MishHostUpdaterReinstallReason;
  url?: string;
};

export type MishHostUpdaterStatusSnapshot = {
  active?: MishHostUpdaterReleaseSnapshot;
  arch: string;
  artifact?: MishHostUpdaterArtifactSnapshot;
  artifactUrl?: string;
  availableVersion?: string;
  cache?: MishHostUpdaterCacheSnapshot;
  capabilities: MishHostUpdaterCapabilitySet;
  channel: MishHostUpdaterChannel;
  checksum?: MishHostUpdaterChecksumSnapshot;
  currentVersion: string;
  downloadPath?: string;
  enabled: boolean;
  error?: MishHostUpdaterErrorSnapshot;
  incoming?: MishHostUpdaterIncomingSnapshot;
  installResult?: MishHostUpdaterInstallResult;
  lastCheckedAt?: string;
  metadata?: Record<string, unknown>;
  mode: MishHostUpdaterMode;
  paths?: MishHostUpdaterPathSnapshot;
  platform: string;
  progress?: MishHostUpdaterProgressSnapshot;
  reinstall?: MishHostUpdaterReinstallSnapshot;
  state: MishHostUpdaterState;
  supported: boolean;
};

export type MishHostUpdaterResult =
  | { ok: true; status: MishHostUpdaterStatusSnapshot }
  | MishHostFailure;

export type MishHostUpdaterStatusListener = (status: MishHostUpdaterStatusSnapshot) => void;

export type MishHostUpdaterMenuLabels = {
  check: string;
  checking: string;
  downloading: string;
  install: string;
  installing: string;
  restart: string;
};

export type MishHostUpdaterOpenDialogRequest = {
  source: string;
};

export type MishHostUpdaterOpenDialogListener = (request: MishHostUpdaterOpenDialogRequest) => void;

/**
 * Native folder-drop listing (AC-R01.1). Tree-relative paths only: absolute
 * native paths never cross into the page. `refused` reports every entry that
 * will not be uploaded; `relativePath: ""` denotes the dropped root itself.
 */
export type MishHostDroppedDirectoryRefusal =
  | "symlink-outside-tree"
  | "symlink-directory"
  | "bundle"
  | "permission"
  | "unsupported";

export type MishHostDroppedDirectoryListing = {
  rootName: string;
  files: Array<{ relativePath: string; size: number }>;
  refused: Array<{ relativePath: string; reason: MishHostDroppedDirectoryRefusal }>;
  truncated: boolean;
};

export type MishHostBridge = {
  // Optional so older host builds still satisfy the bridge shape; callers
  // must feature-detect before invoking.
  appearance?: {
    setTheme(theme: MishHostAppearanceTheme): void;
  };
  browser: {
    clearData(options?: MishHostBrowserClearDataOptions): Promise<MishHostActionResult>;
  };
  capture: {
    page(options?: MishHostCaptureOptions): Promise<MishHostCaptureResult>;
  };
  client: MishHostClient;
  pdf: {
    print(html: string, nonce?: string, options?: MishHostPdfPrintOptions): Promise<MishHostActionResult>;
  };
  pet: {
    setVisible(visible: boolean): void;
  };
  // Optional so web builds and older desktop hosts keep the same contract.
  // Native folder drops (AC-R01.1). `listDroppedDirectory` accepts only a
  // `File` from a drop gesture (typed `unknown` because this package has no
  // DOM lib) and resolves `null` when the File has no native path.
  intake?: {
    listDroppedDirectory(file: unknown): Promise<MishHostDroppedDirectoryListing | null>;
  };
  // Optional so web builds and older desktop hosts keep the same contract.
  // Electron is the only layer that can observe a compositor-affecting
  // subframe navigation failure after the iframe DOM remains healthy.
  preview?: {
    getLatestNavigationFailure(): MishHostPreviewNavigationFailure | null;
    subscribeNavigationFailure(listener: MishHostPreviewNavigationFailureListener): () => void;
  };
  project: {
    pickAndImport(init?: MishHostProjectImportInit): Promise<MishHostProjectImportResult>;
    pickAndReplaceWorkingDir(projectId: string): Promise<MishHostProjectReplaceWorkingDirResult>;
    // Optional so older host builds still satisfy the bridge shape; callers
    // must feature-detect before invoking.
    pickWorkingDir?(): Promise<MishHostPickWorkingDirResult>;
  };
  shell: {
    openExternal(url: string): Promise<MishHostActionResult>;
    openPath(projectId: string): Promise<MishHostActionResult>;
  };
  updater: {
    check(options?: MishHostUpdaterActionOptions): Promise<MishHostUpdaterStatusSnapshot>;
    "clear-cache"(options?: MishHostUpdaterActionOptions): Promise<MishHostUpdaterStatusSnapshot>;
    download(options?: MishHostUpdaterActionOptions): Promise<MishHostUpdaterStatusSnapshot>;
    install(options?: MishHostUpdaterActionOptions): Promise<MishHostUpdaterStatusSnapshot>;
    quit(options?: MishHostUpdaterActionOptions): Promise<MishHostActionResult>;
    setMenuLabels(labels: MishHostUpdaterMenuLabels): Promise<MishHostActionResult>;
    status(options?: MishHostUpdaterActionOptions): Promise<MishHostUpdaterStatusSnapshot>;
    subscribe(listener: MishHostUpdaterStatusListener): () => void;
    subscribeOpenDialog(listener: MishHostUpdaterOpenDialogListener): () => void;
  };
  version: typeof MISH_HOST_VERSION;
};

export type MishHostGlobalScope = Record<string, unknown> & {
  window?: unknown;
};
