import type { IntakeFileOutcome } from '@open-design/contracts';

/** Staged transport follows the detected byte receipt, never a filename suffix. */
export function intakeAttachmentKind(clientFileId: string, outcomes: readonly IntakeFileOutcome[]): 'image' | 'file' {
  return outcomes.find(file => file.clientFileId === clientFileId)?.stored?.kind === 'image' ? 'image' : 'file';
}

/**
 * AC-R01.3: an attachment is opaque only when its own byte receipt says the
 * stored bytes are kind `file`. No receipt means unknown, never opaque.
 */
export function intakeOpaqueAttachment(clientFileId: string, outcomes: readonly IntakeFileOutcome[]): boolean {
  const outcome = outcomes.find(file => file.clientFileId === clientFileId);
  return outcome?.state === 'stored' && outcome.stored?.kind === 'file';
}
