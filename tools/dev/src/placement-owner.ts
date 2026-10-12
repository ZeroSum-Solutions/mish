import path from "node:path";

/** Daemon constructor input keys for the explicit native placement owner selection. */
export const PLACEMENT_OWNER_ENV_KEYS = ["OD_PLACEMENT_OWNER_BINDING", "OD_PLACEMENT_OWNER_SHA256", "OD_PLACEMENT_OWNER_PROVENANCE"] as const;

export type PlacementOwnerOptions = {
  placementOwnerBinding?: string;
  placementOwnerSha256?: string;
  placementOwnerProvenance?: string;
};

/**
 * Explicit binding/provenance selection for the daemon. All three flags are
 * required together; no directory scan, newest-binary choice or build. The
 * daemon validates provenance itself; this only refuses obviously incomplete
 * input so a partial selection never silently becomes "no input".
 */
export function placementOwnerEnv(options: PlacementOwnerOptions): Record<string, string> {
  const values = [options.placementOwnerBinding, options.placementOwnerSha256, options.placementOwnerProvenance];
  if (values.every((value) => value == null)) return {};
  const [binding, sha256, provenance] = values;
  if (typeof binding !== "string" || typeof sha256 !== "string" || typeof provenance !== "string") {
    throw new Error("--placement-owner-binding, --placement-owner-sha256 and --placement-owner-provenance must be supplied together");
  }
  if (!path.isAbsolute(binding) || !path.isAbsolute(provenance)) {
    throw new Error("--placement-owner-binding and --placement-owner-provenance must be absolute paths");
  }
  return { OD_PLACEMENT_OWNER_BINDING: binding, OD_PLACEMENT_OWNER_SHA256: sha256, OD_PLACEMENT_OWNER_PROVENANCE: provenance };
}

/**
 * Ambient shell values never select a binding or open the adoption executor:
 * only explicit flags (`--placement-owner-*`, `--placement-adoption-executor`)
 * reach the daemon.
 */
export function withoutAmbientPlacementOwner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of PLACEMENT_OWNER_ENV_KEYS) delete next[key];
  delete next.OD_PLACEMENT_ADOPTION_EXECUTOR;
  return next;
}
