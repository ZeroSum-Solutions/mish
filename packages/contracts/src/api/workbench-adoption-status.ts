import { z } from 'zod';

// B4-1 (phase A): adoption-executor provisioning status, read by `GET /api/workbench/adoption/status`,
// `od workbench adoption status --json` and the Settings → Labs row. The executor opens only when
// the process-level opt-in, the Labs switch, a verified helper on a supported host and coordinated
// placement mode all hold; otherwise `gates` names every reason it is closed.

/** Process-level opt-in. Only the exact value `1` opts in; the daemon removes it before spawning children. */
export const WORKBENCH_ADOPTION_EXECUTOR_ENV = 'OD_PLACEMENT_ADOPTION_EXECUTOR';
/** Schema of the helper's build-time record (written by the development build, verified by the daemon). */
export const WORKBENCH_ADOPTION_HELPER_RECORD_SCHEMA = 'mishmash.placement-adoption-helper/v1';
/**
 * Path segments under the resolved daemon data root (root AGENTS.md, "Daemon
 * data directory contract", sanctioned exception for the dev-built helper).
 * The daemon reads this constant; tools-dev keeps a pinned copy
 * (e2e/tests/workbench/placement-adoption-layout.test.ts).
 */
/**
 * The record tools-dev leaves when it creates the data root itself (before the
 * coordinated bootstrap). Bootstrap counts such a root as created by its own
 * boot only while the root still holds nothing but this record and the helper
 * tree, then consumes the record.
 */
export const WORKBENCH_ADOPTION_ROOT_RECORD = Object.freeze({
  name: '.placement-root-created.json',
  schema: 'mishmash.placement-root-created/v1',
});
/**
 * B4-1b: why a restarted data root's predecessor is unproven. A restarted
 * coordinated daemon trusts its predecessor only through the clean-shutdown
 * seal that predecessor left; otherwise one of these reasons joins
 * `legacy-predecessor-unproven` in the closed gate list (and the 422 refusal).
 * - `predecessor-seal-absent`: no seal (a crash, an ordinary stop, or a boot
 *   that could not seal).
 * - `predecessor-seal-invalid`: the seal is not a private regular file of the
 *   closed shape, or its MAC does not verify.
 * - `predecessor-seal-root-changed`: the root or a root-level entry changed
 *   after the seal (another daemon opened the database, or a hand edit).
 * - `predecessor-seal-unrecognized`: the database does not confirm the seal
 *   (unknown nonce, not the latest generation or incarnation, already used).
 * - `predecessor-seal-unverifiable`: the boot could not check the seal within
 *   its bounds (the database is over the size cap, or no room for the bounded
 *   snapshot). The seal is left in place.
 */
export const WORKBENCH_ADOPTION_PREDECESSOR_GATES = Object.freeze([
  'predecessor-seal-absent', 'predecessor-seal-invalid', 'predecessor-seal-root-changed', 'predecessor-seal-unrecognized',
  'predecessor-seal-unverifiable',
] as const);
export type WorkbenchAdoptionPredecessorGate = (typeof WORKBENCH_ADOPTION_PREDECESSOR_GATES)[number];
export const WORKBENCH_ADOPTION_HELPER_LAYOUT = Object.freeze({
  toolDir: Object.freeze(['placement', 'adoption-helper'] as const),
  binary: 'placement-helper',
  record: 'helper.json',
  workRoot: Object.freeze(['placement', 'adoption-work'] as const),
});

const gate = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const statusSchema = z.object({
  status: z.object({
    executor: z.enum(['provisioned', 'closed']),
    placementMode: z.enum(['ordinary-uncoordinated', 'coordinated-closed', 'coordinated-open']),
    optIn: z.object({ env: z.boolean(), labs: z.boolean() }).strict(),
    host: z.object({ platform: z.string().min(1).max(40), arch: z.string().min(1).max(40), supported: z.boolean() }).strict(),
    gates: z.array(gate).max(64),
  }).strict(),
}).strict();
export type WorkbenchAdoptionStatusResponse = z.infer<typeof statusSchema>;
export type WorkbenchAdoptionStatus = WorkbenchAdoptionStatusResponse['status'];
export const parseWorkbenchAdoptionStatusResponse = (input: unknown): WorkbenchAdoptionStatusResponse => statusSchema.parse(input);

/**
 * `error.details` of the 422 `unsupported-capability` refusal every adoption
 * route returns while the executor is closed. `gates` names every reason.
 */
const refusalDetailsSchema = z.object({
  kind: z.literal('placement'),
  reason: z.string().min(1).max(200),
  gates: z.array(gate).max(64),
}).strict();
export type WorkbenchAdoptionRefusalDetails = z.infer<typeof refusalDetailsSchema>;
export const parseWorkbenchAdoptionRefusalDetails = (input: unknown): WorkbenchAdoptionRefusalDetails => refusalDetailsSchema.parse(input);
