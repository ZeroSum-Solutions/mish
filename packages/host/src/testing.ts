import {
  MISH_HOST_GLOBAL,
  MISH_HOST_VERSION,
  type MishHostBridge,
  type MishHostGlobalScope,
  type MishHostUpdaterStatusSnapshot,
} from "./index.js";

export type MockMishHost = Partial<Omit<MishHostBridge, "capture" | "client" | "pdf" | "pet" | "preview" | "project" | "shell" | "updater">> & {
  browser?: Partial<MishHostBridge["browser"]>;
  capture?: Partial<MishHostBridge["capture"]>;
  client?: Partial<MishHostBridge["client"]>;
  pdf?: Partial<MishHostBridge["pdf"]>;
  pet?: Partial<MishHostBridge["pet"]>;
  preview?: Partial<NonNullable<MishHostBridge["preview"]>>;
  project?: Partial<MishHostBridge["project"]>;
  shell?: Partial<MishHostBridge["shell"]>;
  updater?: Partial<MishHostBridge["updater"]>;
};

export type MockMishHostOptions = {
  host?: MockMishHost;
  scope?: MishHostGlobalScope;
};

function defaultHost(): MishHostBridge {
  const updaterStatus: MishHostUpdaterStatusSnapshot = {
    arch: "arm64",
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: "beta",
    currentVersion: "1.0.0-beta.0",
    enabled: true,
    mode: "package-launcher",
    platform: "darwin",
    state: "idle",
    supported: true,
  };
  return {
    version: MISH_HOST_VERSION,
    browser: {
      clearData: async () => ({ ok: true }),
    },
    capture: {
      page: async () => ({ ok: true, dataUrl: "data:image/png;base64,", h: 1, w: 1 }),
    },
    client: {
      type: "desktop",
      platform: "test",
    },
    shell: {
      openExternal: async () => ({ ok: true }),
      openPath: async () => ({ ok: true }),
    },
    project: {
      pickAndImport: async () => ({
        ok: true,
        projectId: "project-test",
        conversationId: "conversation-test",
        entryFile: "index.html",
      }),
      pickAndReplaceWorkingDir: async () => ({
        ok: true,
        baseDir: "/tmp/mish-test",
        entryFile: null,
      }),
    },
    pdf: {
      print: async () => ({ ok: true }),
    },
    pet: {
      setVisible: () => undefined,
    },
    preview: {
      getLatestNavigationFailure: () => null,
      subscribeNavigationFailure: () => () => undefined,
    },
    updater: {
      check: async () => updaterStatus,
      "clear-cache": async () => updaterStatus,
      download: async () => updaterStatus,
      install: async () => updaterStatus,
      quit: async () => ({ ok: true }),
      setMenuLabels: async () => ({ ok: true }),
      status: async () => updaterStatus,
      subscribe: () => () => undefined,
      subscribeOpenDialog: () => () => undefined,
    },
  };
}

export function createMockMishHost(overrides: MockMishHost = {}): MishHostBridge {
  const base = defaultHost();
  return {
    ...base,
    ...overrides,
    browser: { ...base.browser, ...overrides.browser },
    capture: { ...base.capture, ...overrides.capture },
    client: { ...base.client, ...overrides.client },
    shell: { ...base.shell, ...overrides.shell },
    project: { ...base.project, ...overrides.project },
    pdf: { ...base.pdf, ...overrides.pdf },
    pet: { ...base.pet, ...overrides.pet },
    preview: {
      getLatestNavigationFailure:
        overrides.preview?.getLatestNavigationFailure
        ?? base.preview!.getLatestNavigationFailure,
      subscribeNavigationFailure:
        overrides.preview?.subscribeNavigationFailure
        ?? base.preview!.subscribeNavigationFailure,
    },
    updater: { ...base.updater, ...overrides.updater },
  };
}

export function installMockMishHost(options: MockMishHostOptions = {}): () => void {
  const scope = (options.scope ?? globalThis) as MishHostGlobalScope;
  const host = createMockMishHost(options.host);
  const windowValue = scope.window;
  const targets = [
    scope,
    ...(typeof windowValue === "object" && windowValue != null && windowValue !== scope
      ? [windowValue as MishHostGlobalScope]
      : []),
  ];
  const previous = targets.map((target) => ({
    had: Object.prototype.hasOwnProperty.call(target, MISH_HOST_GLOBAL),
    target,
    value: target[MISH_HOST_GLOBAL],
  }));

  for (const target of targets) {
    Object.defineProperty(target, MISH_HOST_GLOBAL, {
      configurable: true,
      value: host,
      writable: true,
    });
  }

  return () => {
    for (const entry of previous) {
      if (entry.had) {
        Object.defineProperty(entry.target, MISH_HOST_GLOBAL, {
          configurable: true,
          value: entry.value,
          writable: true,
        });
      } else {
        delete entry.target[MISH_HOST_GLOBAL];
      }
    }
  };
}
