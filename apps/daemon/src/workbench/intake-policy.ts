import { FILE_UPLOAD_MAX_BYTES, type IntakeFileOutcome } from '@mish/contracts';

/**
 * AC-R01.3 intake policy, one source for the daemon and `od workbench intake`.
 *
 * Every intake destination (project or Library) uses this per-file limit; the
 * legacy inline Library upload limit never applies to the streamed intake
 * path. The shown limit is derived from the value that is enforced, so the two
 * cannot drift.
 */
export const INTAKE_FILE_MAX_BYTES = FILE_UPLOAD_MAX_BYTES;
export const INTAKE_SIZE_EXCEEDED_MESSAGE = `File exceeds the ${INTAKE_FILE_MAX_BYTES / (1024 * 1024)} MiB per-file limit`;

/** Contract wording for bytes we keep but that no model reads (stored kind `file`). */
export const OPAQUE_INTAKE_NOTICE = 'Stored; contents cannot be read by this model.';

/** The notice holds only for saved opaque bytes; unsaved or readable kinds carry none. */
export function intakeReadabilityNotice(file: Pick<IntakeFileOutcome, 'state' | 'stored'>): string | undefined {
  return file.state === 'stored' && file.stored?.kind === 'file' ? OPAQUE_INTAKE_NOTICE : undefined;
}

/** CLI JSON view of one outcome: the HTTP receipt plus `readabilityNotice` when the notice holds. */
export function withReadabilityNotice<T extends Pick<IntakeFileOutcome, 'state' | 'stored'>>(file: T): T & { readabilityNotice?: string } {
  const notice = intakeReadabilityNotice(file);
  return notice ? { ...file, readabilityNotice: notice } : file;
}
