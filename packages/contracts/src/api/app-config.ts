import type { OdNextRolloutMode } from './strategy-rollout.js';
import type { BriefTransformerLane } from './workbench-brief.js';

export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
  serviceTier?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;
export type AgentCliEnvIntentPrefs = Record<string, { apiKeyOverride?: boolean }>;

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface OrbitConfigPrefs {
  enabled: boolean;
  /** Local 24-hour clock time in HH:mm format. Defaults to 08:00. */
  time: string;
  /** Optional skill id from the examples gallery where scenario === "orbit". */
  templateSkillId?: string | null;
  /**
   * Workspace selected in the tab that configured Orbit. The daemon verifies
   * this pair when saving and again before every unattended run.
   */
  workspaceScope?: AutomationWorkspaceScope | null;
}

export interface AutomationWorkspaceScope {
  workspaceId: string;
  workspaceMemberId: string;
}

export interface ProjectLocationPrefs {
  id: string;
  name: string;
  path: string;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  agentCliEnvIntent?: AgentCliEnvIntentPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  /**
   * Unix-millis timestamp of when the user resolved the first-run privacy
   * consent surface (Share or Decline). Set on first decision and on
   * subsequent toggles in Settings → Privacy. Independent of
   * installationId so that "Delete my data" can rotate the id without
   * re-popping the consent banner.
   */
  privacyDecisionAt?: number | null;
  allowSilentUpdates?: boolean;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  /** External project library roots. The daemon adds its built-in .od/projects location at read time. */
  projectLocations?: ProjectLocationPrefs[];
  /** Project location id used for new projects when the create request does not choose one explicitly. */
  defaultProjectLocationId?: string | null;
  /**
   * Which mode this installation runs the OD Next design strategy in.
   *
   * OD Next is opt-in (decision D14): an installation that never chose runs the
   * ordinary route, so absent (and `null`) mean `off`. Setting this to
   * `'active'` is the whole opt-in step, and `'off'` opts out again — the next
   * run takes the chosen route without
   * restarting the daemon, because the run route reads this field per request
   * rather than latching it at boot.
   *
   * A packaged install has no other control: the packaged child environment
   * allowlist carries no `OD_NEXT_*` key, so this field is what the Labs
   * switch writes and the only thing standing between an opted-out user and
   * the default.
   *
   * `OD_NEXT_STRATEGY_ROLLOUT` still outranks this when it is set, so an
   * operator, a packaged smoke run, or a test can pin a mode for one process
   * without overwriting what the user saved.
   */
  odNextStrategyMode?: OdNextRolloutMode | null;
  /**
   * Most-recently-used local working directories the user granted the agent
   * read access to (via the Home composer's working-directory picker). These
   * become a new project's `metadata.linkedDirs` — the agent perceives them
   * through `--add-dir`; they are NOT imported into Design Files. Stored
   * most-recent-first and capped by the daemon.
   */
  recentLinkedDirs?: string[];
  /**
   * Settings → Labs switch for the workbench adoption executor (B4-1).
   * Absent means off. It is the user half of a two-part opt-in: the executor
   * opens only when the daemon process also runs with
   * `OD_PLACEMENT_ADOPTION_EXECUTOR=1` and a verified helper. The daemon reads
   * it per request, so the switch takes effect without a restart.
   */
  placementAdoptionExecutor?: boolean;
  /**
   * Opt-in staged drafting: a fast model drafts, then the main model finishes
   * over the same project files. Absent and `null` mean off. The daemon reads
   * it per run, so the switch takes effect on the next turn.
   */
  stagedDrafting?: boolean | null;
  /**
   * Settings → Labs: which model writes Improve prompt briefs. Absent and
   * `null` mean `terra` (D28.4), which sends the prompt to OpenAI through
   * OpenRouter and falls back to `claude` on any failure; `claude` opts out.
   * A damaged saved value reads as `claude`. Read per request.
   */
  improvePromptTransformer?: BriefTransformerLane | null;
}

export interface AppConfigResponse {
  config: AppConfigPrefs;
}

export type UpdateAppConfigRequest = Partial<AppConfigPrefs>;

/** Response body for `GET /api/recent-dirs` — recent working directories
 *  pruned to those that still exist on disk, most-recent-first. */
export interface RecentLinkedDirsResponse {
  dirs: string[];
}

/** A deadline or inaccessible mount cannot establish that a folder is missing. */
export type DirectoryExistsResponse =
  | { exists: boolean }
  | { exists: null; status: 'unknown'; reason: 'timeout' | 'unavailable' };
