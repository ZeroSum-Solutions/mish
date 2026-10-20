export const PRODUCT_NAME = "Mish";
export const DESKTOP_LOG_ECHO_ENV = "OD_DESKTOP_LOG_ECHO";
export const WEB_STANDALONE_HOOK_CONFIG_ENV = "OD_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
export const WEB_STANDALONE_RESOURCE_NAME = "mish-web-standalone";
export const ELECTRON_BUILDER_ASAR = false;
export const ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE = false;
export const ELECTRON_BUILDER_NODE_GYP_REBUILD = false;
export const ELECTRON_BUILDER_NPM_REBUILD = false;
export const ELECTRON_REBUILD_MODE = "sequential" as const;
export const ELECTRON_REBUILD_NATIVE_MODULES = ["better-sqlite3"] as const;
export const ELECTRON_BUILDER_FILE_PATTERNS = [
  "**/*",
  "!**/node_modules/.bin",
  "!**/node_modules/electron{,/**/*}",
  "!**/*.map",
  "!**/*.tsbuildinfo",
  "!**/.next/cache",
  "!**/.next/cache/**",
  "!**/node_modules/better-sqlite3/build/Release/obj",
  "!**/node_modules/better-sqlite3/build/Release/obj/**",
  "!**/node_modules/better-sqlite3/deps",
  "!**/node_modules/better-sqlite3/deps/**",
] as const;
export const NSIS_INSTALLER_LANGUAGE_BY_WEB_LOCALE = {
  en: "en_US",

} as const;
export const INTERNAL_PACKAGES = [
  { directory: "packages/release", name: "@mish/release" },
  { directory: "packages/components", name: "@mish/components" },
  { directory: "packages/contracts", name: "@mish/contracts" },
  { directory: "packages/registry-protocol", name: "@mish/registry-protocol" },
  { directory: "packages/sidecar-proto", name: "@mish/sidecar-proto" },
  { directory: "packages/launcher-proto", name: "@mish/launcher-proto" },
  { directory: "packages/platform", name: "@mish/platform" },
  { directory: "packages/sidecar", name: "@mish/sidecar" },
  { directory: "packages/download", name: "@mish/download" },
  { directory: "packages/host", name: "@mish/host" },
  { directory: "packages/agui-adapter", name: "@mish/agui-adapter" },
  { directory: "packages/plugin-runtime", name: "@mish/plugin-runtime" },
  { directory: "packages/diagnostics", name: "@mish/diagnostics" },
  { directory: "packages/cult-ui-catalog", name: "@mish/cult-ui-catalog" },
  { directory: "packages/21st-catalog", name: "@mish/21st-catalog" },
  { directory: "packages/publisher", name: "@mish/publisher" },
  { directory: "packages/agency-fast-lane", name: "@mish/agency-fast-lane" },
  { directory: "packages/genui-catalog", name: "@mish/genui-catalog" },
  { directory: "packages/section-catalog", name: "@mish/section-catalog" },
  { directory: "apps/daemon", name: "@mish/daemon" },
  { directory: "apps/web", name: "@mish/web" },
  { directory: "apps/desktop", name: "@mish/desktop" },
  { directory: "apps/packaged", name: "@mish/packaged" },
] as const;
