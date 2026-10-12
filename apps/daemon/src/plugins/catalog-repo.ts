// The GitHub repository that owns the Mishh Mashh plugin catalog. Plugin
// publish, yank and PR flows, and the default marketplace registry, point here
// instead of at the upstream project. It is the public repository: the
// official plugins ship from its plugins/_official tree, so every user can
// read and install them.
export const MISHH_MASHH_PLUGIN_REPO = 'ZeroSum-Solutions/mish';

// Repositories that earlier releases wrote into saved marketplace URLs. The
// first is the private working repository the catalog used to point at; public
// users get 404s from it, so registry URLs naming it are migrated to the
// current catalog repository instead of being fetched as-is.
export const LEGACY_PLUGIN_CATALOG_REPOS: readonly string[] = ['ZeroSum-Solutions/Mishh-Mashh-2'];
