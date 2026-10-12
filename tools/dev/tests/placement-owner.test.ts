import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placementOwnerEnv, withoutAmbientPlacementOwner } from "../src/placement-owner.js";

describe("tools-dev explicit placement owner input", () => {
  it("passes nothing without flags and strips ambient selections", () => {
    assert.deepEqual(placementOwnerEnv({}), {});
    assert.deepEqual(
      withoutAmbientPlacementOwner({ OD_PLACEMENT_OWNER_BINDING: "/x/owner.node", OD_PLACEMENT_OWNER_SHA256: "a", OD_PLACEMENT_OWNER_PROVENANCE: "/x/p.json", KEEP: "1" }),
      { KEEP: "1" },
    );
  });
  it("forwards a complete explicit selection and refuses partial or relative input", () => {
    assert.deepEqual(
      placementOwnerEnv({ placementOwnerBinding: "/x/owner.node", placementOwnerSha256: "a".repeat(64), placementOwnerProvenance: "/x/p.json" }),
      { OD_PLACEMENT_OWNER_BINDING: "/x/owner.node", OD_PLACEMENT_OWNER_SHA256: "a".repeat(64), OD_PLACEMENT_OWNER_PROVENANCE: "/x/p.json" },
    );
    assert.throws(() => placementOwnerEnv({ placementOwnerBinding: "/x/owner.node" }), /supplied together/);
    assert.throws(() => placementOwnerEnv({ placementOwnerBinding: "owner.node", placementOwnerSha256: "a", placementOwnerProvenance: "/x/p.json" }), /absolute/);
  });
});
