import path from 'node:path';
import { reusableUnitManifestSchema, unitInsertReceiptSchema } from '@mish/contracts';

// The insertion producer carries this subset of the saved manifest. This is
// trusted local provenance, not a licence signature or a grant to publish.
const manifestObject = reusableUnitManifestSchema.innerType();
const manifest = manifestObject.shape;
const receiptObject = unitInsertReceiptSchema.innerType();
const lineageFieldsSchema = receiptObject.pick({
  insertId: true, files: true, dependenciesInstalled: true, actionVerification: true,
}).extend({
  source: manifestObject.pick({ unitId: true, revision: true }).extend({
    projectRef: receiptObject.shape.files.element.shape.sha256.optional(),
    captureId: manifest.provenance.shape.captureId.unwrap().nullable(),
    draftRevisionId: manifest.provenance.shape.draftRevisionId.unwrap().nullable(),
  }).strict(),
  dependencies: manifest.dependencies,
  actions: manifest.actions,
  // unit-insert deliberately hashes private evidence references before copying
  // lineage into the project. Validate the carried digests, not store-only refs.
  rights: manifest.rights.pick({ status: true, basis: true, notices: true }).extend({
    evidenceDigests: receiptObject.shape.files.element.shape.sha256.array().max(20),
  }),
}).strict();

export class PublicationRightsError extends Error {
  constructor(readonly code: 'PUBLICATION_RIGHTS_BLOCKED' | 'PUBLICATION_RIGHTS_UNVERIFIED') {
    super(code === 'PUBLICATION_RIGHTS_BLOCKED'
      ? 'Private-use content cannot be published. Use content with public-use permission.'
      : 'Publication rights could not be verified. Restore valid insertion provenance before publishing.');
  }
}

type ProjectFileReader = (relativePath: string) => Promise<{ name: string; buffer: Buffer }>;

/** Check actual publication paths only; unrelated private units stay private. */
export async function assertInsertedUnitPublicationRights(paths: Iterable<string>, readProjectFile: ProjectFileReader): Promise<void> {
  const markers = new Set<string>();
  for (const file of paths) {
    // Callers supply normalized project paths after their own containment and
    // reserved-file checks. Rights lookup must not add Workbench admission
    // limits to ordinary owned filenames (Unicode format characters included).
    if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\')
      || file.startsWith('/') || /^[A-Za-z]:/u.test(file)
      || file.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    }
    let directory = path.posix.dirname(file);
    while (true) {
      markers.add(directory === '.' ? 'unit-lineage.json' : `${directory}/unit-lineage.json`);
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  for (const marker of markers) {
    let file;
    try {
      file = await readProjectFile(marker);
    } catch (error) {
      // No marker is normal for user-owned content. Directory names do not
      // establish provenance; deleting/copying it is outside this local-writer boundary.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    }
    if (file.buffer.length > 1024 * 1024) throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    let raw: unknown;
    try { raw = JSON.parse(file.buffer.toString('utf8')); }
    catch { throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    const { schema, ...fields } = raw as Record<string, unknown>;
    if (schema !== 'unit-insert-lineage/1') throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    const lineage = lineageFieldsSchema.safeParse(fields);
    if (!lineage.success) throw new PublicationRightsError('PUBLICATION_RIGHTS_UNVERIFIED');
    if (['private-use-only', 'reference-only', 'unknown'].includes(lineage.data.rights.status)) {
      throw new PublicationRightsError('PUBLICATION_RIGHTS_BLOCKED');
    }
  }
}
