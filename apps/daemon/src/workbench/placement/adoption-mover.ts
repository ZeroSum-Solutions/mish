import path from 'node:path';
import { inspectPlacementParents, prepareExclusiveMove, type Helper, type MoveResult } from './driver.js';
import type { ParentIdentity } from './protocol.js';

/** One prepared exclusive regular-file movement, executed once after a durable intent. */
export interface PreparedAdoptionMove {
  execute(afterDurableIntent: () => Promise<void>): Promise<MoveResult>;
  close(): Promise<void>;
}
export type AdoptionMovePreparation =
  | { kind: 'ready'; move: PreparedAdoptionMove }
  | { kind: 'unsupported' | 'conflict'; reason: string };
/**
 * The executor's only movement capability. Implementations never fall back to
 * a plain rename: the native driver is the qualified implementation.
 */
export interface AdoptionMover {
  /** Qualified parent identity (device/inode/volume) of an existing directory. */
  inspectDirectory(directory: string): Promise<{ kind: 'qualified'; identity: ParentIdentity } | { kind: 'unsupported' | 'conflict'; reason: string }>;
  prepare(input: { source: string; destination: string; expected: { device: string; inode: string } }): Promise<AdoptionMovePreparation>;
}

/** Native exclusive movement (`renameatx_np(RENAME_EXCL | RENAME_NOFOLLOW_ANY)`) through the qualified helper. */
export function createNativeAdoptionMover(helper: Helper): AdoptionMover {
  const pinned: Helper = Object.freeze({ path: helper.path, sha256: helper.sha256 });
  const mover: AdoptionMover = {
    async inspectDirectory(directory: string) {
      const inspected = await inspectPlacementParents({ helper: pinned, sourceParentPath: directory, targetParentPath: directory });
      return inspected.kind === 'qualified' ? { kind: 'qualified' as const, identity: inspected.sourceParent } : { kind: inspected.kind, reason: inspected.reason };
    },
    async prepare({ source, destination, expected }): Promise<AdoptionMovePreparation> {
      const parents = await inspectPlacementParents({ helper: pinned, sourceParentPath: path.dirname(source), targetParentPath: path.dirname(destination) });
      if (parents.kind !== 'qualified') return { kind: parents.kind, reason: parents.reason };
      const ready = await prepareExclusiveMove({
        helper: pinned,
        source: { parent: { path: path.dirname(source), identity: parents.sourceParent }, name: path.basename(source) },
        target: { parent: { path: path.dirname(destination), identity: parents.targetParent }, name: path.basename(destination) },
        expectedSource: { device: expected.device, inode: expected.inode, kind: 'file' },
      });
      if (ready.kind !== 'ready') return { kind: ready.kind, reason: ready.reason };
      return { kind: 'ready', move: { execute: intent => ready.execute(async () => intent()), close: () => ready.close() } };
    },
  };
  return Object.freeze(mover);
}
