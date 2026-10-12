// The AG-UI event shapes this package emits for an agency build, named as the AG-UI spec names
// them (docs.ag-ui.com/concepts/events): the discriminant is `type`, not the `kind` the legacy
// OD-kind shapes in `./types.ts` use. Only the subset a build stream sends is modelled here.
//
// The legacy `./types.ts` union and `encodeOdEventForAgui` stay as they are; this is a second,
// spec-shaped vocabulary beside them, not a replacement.

/** One RFC 6902 operation. Only the three ops this package emits and applies. */
export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

interface AguiBase {
  /** Milliseconds since the epoch. */
  timestamp?: number;
}

export interface AguiRunStartedEvent extends AguiBase {
  type: 'RUN_STARTED';
  threadId: string;
  runId: string;
}

export interface AguiRunFinishedEvent extends AguiBase {
  type: 'RUN_FINISHED';
  threadId: string;
  runId: string;
  result?: unknown;
}

export interface AguiRunErrorEvent extends AguiBase {
  type: 'RUN_ERROR';
  message: string;
  code?: string;
}

export interface AguiStepStartedEvent extends AguiBase {
  type: 'STEP_STARTED';
  stepName: string;
}

export interface AguiStepFinishedEvent extends AguiBase {
  type: 'STEP_FINISHED';
  stepName: string;
}

export interface AguiStateSnapshotEvent<S = unknown> extends AguiBase {
  type: 'STATE_SNAPSHOT';
  snapshot: S;
}

export interface AguiStateDeltaEvent extends AguiBase {
  type: 'STATE_DELTA';
  delta: JsonPatchOp[];
}

export interface AguiCustomEvent extends AguiBase {
  type: 'CUSTOM';
  name: string;
  value: unknown;
}

export type AguiEvent<S = unknown> =
  | AguiRunStartedEvent
  | AguiRunFinishedEvent
  | AguiRunErrorEvent
  | AguiStepStartedEvent
  | AguiStepFinishedEvent
  | AguiStateSnapshotEvent<S>
  | AguiStateDeltaEvent
  | AguiCustomEvent;

export type AguiEventType = AguiEvent['type'];
