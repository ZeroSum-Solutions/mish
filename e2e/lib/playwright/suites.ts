export type UiPlaywrightGroup = {
  files: readonly string[];
  fullyParallel?: boolean;
  grep: string;
  workers?: number;
};

export type UiP0CiMatrixEntry = {
  name: string;
  shard: string;
};

export type VisualCiMatrixEntry = {
  files: string;
  name: string;
};

export const uiP0Groups = {
  "critical-extras": {
    grep: "@merge-extra",
    workers: 1,
    files: ["ui/app.test.ts"],
  },
  "workspace-restoration": {
    fullyParallel: true,
    grep: String.raw`\[P0\]`,
    files: ["ui/app-restoration.test.ts", "ui/critical-smoke.test.ts"],
  },
  // The entry domain is split in two (2026-10-10): as one job it was the CI
  // critical path at about 26 minutes on one worker. File timings from three
  // hosted runs put "entry-onboarding" at about 12.7 minutes and
  // "entry-settings" at about 13.5 minutes.
  "entry-onboarding": {
    grep: String.raw`\[P0\]`,
    files: [
      "ui/amr-onboarding.test.ts",
      "ui/entry-chrome-flows.test.ts",
      "ui/entry-configuration-flows.test.ts",
      "ui/home-hero-rail.test.ts",
      "ui/home-deck-preview-layout.test.ts",
      "ui/api-empty-response.test.ts",
      "ui/settings-connectors-auth-happy-path.test.ts",
      "ui/settings-connectors-auth-recovery.test.ts",
    ],
  },
  "entry-settings": {
    grep: String.raw`\[P0\]`,
    files: [
      "ui/model-picker-mode-roundtrip.test.ts",
      // AC-R02 Home/canvas next-turn binding journey; owns its own cluster
      // runtime (restarted mid-test), like the picker roundtrip above.
      "ui/workbench-session-model-binding.test.ts",
      "ui/settings-api-protocol.test.ts",
      "ui/workspace-team-interactions.test.ts",
    ],
  },
  "project-workspace": {
    grep: String.raw`\[P0\]`,
    workers: 1,
    files: [
      "ui/app.test.ts",
      "ui/fork-note-ellipsis.test.ts",
      "ui/project-management-flows.test.ts",
      "ui/workspace-keyboard-flows.test.ts",
      "ui/workbench-resource-preview.test.ts",
      "ui/workbench-file-intake.test.ts",
    ],
  },
  // Keep editor-heavy files on a separate single-worker runtime. Running the
  // whole workspace domain serially took 11.6 minutes on CI, while enabling a
  // second worker in one job is unsafe because these flows share Workspace
  // authority state outside the worker-local daemon. Runner-isolated jobs
  // preserve that boundary and balance the historical file timings.
  "project-workspace-editor": {
    grep: String.raw`\[P0\]`,
    workers: 1,
    files: ["ui/app-design-files.test.ts", "ui/app-manual-edit.test.ts"],
  },
  "project-workspace-design-system": {
    grep: String.raw`\[P0\]`,
    workers: 1,
    files: ["ui/workspace-team-design-system-picker.test.ts"],
  },
  // Split out of "project-workspace" (2026-08-04): the two multi-client collab
  // specs alone accounted for ~10 of that group's ~26min single-worker wall
  // time (workspace-multi-client-collab.test.ts spins up two isolated
  // client/daemon runtimes per case). Keep this shard limited to the cluster-
  // owned spec so it does not also boot the default worker runtime needed by
  // ordinary UI files.
  "project-collab-health": {
    grep: String.raw`\[P0\] strict SSE health suppresses authority reads and bounds event storms per account`,
    workers: 1,
    files: ["ui/workspace-multi-client-collab.test.ts"],
  },
  "project-collab": {
    grep: String.raw`\[P0\](?! strict SSE health suppresses authority reads and bounds event storms per account)`,
    workers: 1,
    files: ["ui/workspace-multi-client-collab.test.ts"],
  },
  "project-runtime": {
    grep: String.raw`\[P0\]`,
    workers: 1,
    files: [
      "ui/real-daemon-run.test.ts",
      "ui/amr-run-failure-recovery.test.ts",
      "ui/amr-logout-requires-relogin.test.ts",
      "ui/settings-local-cli-codex-fallback.test.ts",
    ],
  },
} as const satisfies Record<string, UiPlaywrightGroup>;

export type UiP0GroupName = keyof typeof uiP0Groups;

// A shared file is allowed only when its complete shard membership is declared
// here. The two complementary grep contracts partition this file's P0 tests;
// every other duplicate assignment remains an error.
export const uiP0SharedFilePartitions = {
  "ui/workspace-multi-client-collab.test.ts": ["project-collab-health", "project-collab"],
} as const satisfies Record<string, readonly UiP0GroupName[]>;

export const uiP0CiMatrix = [
  { name: "entry-onboarding", shard: "entry-onboarding" },
  { name: "entry-settings", shard: "entry-settings" },
  { name: "project-workspace", shard: "project-workspace" },
  { name: "project-workspace-editor", shard: "project-workspace-editor" },
  { name: "project-workspace-design-system", shard: "project-workspace-design-system" },
  { name: "project-collab-health", shard: "project-collab-health" },
  { name: "project-collab", shard: "project-collab" },
  { name: "project-runtime", shard: "project-runtime" },
  { name: "workspace-restoration", shard: "workspace-restoration" },
] as const satisfies readonly UiP0CiMatrixEntry[];

export const visualCiMatrix = [
  { name: "entry-navigation", files: "ui/visual-entry.test.ts ui/visual-navigation.test.ts" },
  { name: "settings-workspace", files: "ui/visual-settings.test.ts ui/visual-workspace.test.ts" },
] as const satisfies readonly VisualCiMatrixEntry[];

const uiP0CoverageFiles = [
  "ui/amr-logout-requires-relogin.test.ts",
  "ui/amr-onboarding.test.ts",
  "ui/amr-run-failure-recovery.test.ts",
  "ui/api-empty-response.test.ts",
  "ui/app-design-files.test.ts",
  "ui/app-manual-edit.test.ts",
  "ui/app-restoration.test.ts",
  "ui/app.test.ts",
  "ui/critical-smoke.test.ts",
  "ui/entry-chrome-flows.test.ts",
  "ui/entry-configuration-flows.test.ts",
  "ui/fork-note-ellipsis.test.ts",
  "ui/home-deck-preview-layout.test.ts",
  "ui/home-hero-rail.test.ts",
  "ui/model-picker-mode-roundtrip.test.ts",
  "ui/project-management-flows.test.ts",
  "ui/real-daemon-run.test.ts",
  "ui/settings-api-protocol.test.ts",
  "ui/settings-connectors-auth-happy-path.test.ts",
  "ui/settings-connectors-auth-recovery.test.ts",
  "ui/settings-local-cli-codex-fallback.test.ts",
  "ui/workspace-team-interactions.test.ts",
  "ui/workspace-multi-client-collab.test.ts",
  "ui/workspace-team-design-system-picker.test.ts",
  "ui/workspace-keyboard-flows.test.ts",
  "ui/workbench-resource-preview.test.ts",
  "ui/workbench-file-intake.test.ts",
  "ui/workbench-session-model-binding.test.ts",
] as const;

export function getUiP0Group(name: string): UiPlaywrightGroup | undefined {
  return uiP0Groups[name as UiP0GroupName];
}

export function listUiP0GroupNames(): string[] {
  return Object.keys(uiP0Groups).sort();
}

export function validatePlaywrightSuiteTopology(): string[] {
  const errors: string[] = [];
  const knownGroups = new Set(Object.keys(uiP0Groups));
  const coverageFiles = sortedUnique(uiP0CoverageFiles);
  const ciFileAssignments = uiP0CiMatrix.flatMap((entry) =>
    (uiP0Groups[entry.shard as UiP0GroupName]?.files ?? []).map((file) => ({
      file,
      shard: entry.shard,
    })),
  );
  const ciFiles = sortedUnique(ciFileAssignments.map((assignment) => assignment.file));

  for (const entry of uiP0CiMatrix) {
    if (!knownGroups.has(entry.shard)) {
      errors.push(`UI P0 CI matrix references unknown group ${entry.shard}`);
    }
  }

  for (const file of difference(coverageFiles, ciFiles)) {
    errors.push(`UI P0 CI matrix does not cover ${file}`);
  }

  for (const file of difference(ciFiles, coverageFiles)) {
    errors.push(`UI P0 CI matrix unexpectedly covers ${file}`);
  }

  const shardsByFile = new Map<string, string[]>();
  for (const assignment of ciFileAssignments) {
    const shards = shardsByFile.get(assignment.file) ?? [];
    shards.push(assignment.shard);
    shardsByFile.set(assignment.file, shards);
  }

  for (const [file, shards] of shardsByFile) {
    if (shards.length > 1 && !(file in uiP0SharedFilePartitions)) {
      errors.push(`UI P0 CI matrix covers ${file} more than once`);
    }
  }

  for (const [file, expectedShards] of Object.entries(uiP0SharedFilePartitions)) {
    const actualShards = shardsByFile.get(file) ?? [];
    if (!sameValues(actualShards, expectedShards)) {
      errors.push(
        `UI P0 CI matrix partition for ${file} must be exactly ${expectedShards.join(", ")}; received ${actualShards.join(", ") || "none"}`,
      );
    }
  }

  for (const entry of visualCiMatrix) {
    if (entry.files.trim().length === 0) {
      errors.push(`Visual CI matrix entry ${entry.name} has no files`);
    }
  }

  return errors;
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
