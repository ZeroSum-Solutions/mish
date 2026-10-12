import type { CatalogueTargetReport, ResourceRef } from '@mish/contracts';

/** One project-relative file a catalogue item contributes, relative to the chosen target directory. */
export interface CatalogueMaterialFile {
  path: string;
  role: 'source' | 'asset' | 'style';
  bytes: Buffer;
}

/** A declared npm dependency; `range` is `*` when the source names no version. */
export interface CatalogueDependency { name: string; range: string }

/**
 * A module the item imports through a project alias (for example `cn` from
 * `@/lib/utils`) that its source does not ship. Apply writes the pinned bytes
 * only when the target project has no such module; an existing module is kept
 * and must provide the export, so a user's own helper is never replaced.
 */
export interface CatalogueHelper {
  /** Path relative to the target directory, as the alias resolves it. */
  path: string;
  /** Other files that already satisfy the same import (for example `lib/utils.js`). */
  alternatePaths: string[];
  /** The named export the item imports. */
  exportName: string;
  bytes: Buffer;
  /** npm packages the helper itself needs, checked only when it is written. */
  packageDependencies: CatalogueDependency[];
  /** Licence notice for the helper, added to the item notice when it is written. */
  notice: string;
}

/**
 * The exact bytes and rights record of one catalogue item at its current
 * revision. `files` includes permitted local dependencies (for example a
 * registry `utils` helper) so apply saves them into the project. npm packages
 * are never written: they are checked against the project manifest instead.
 */
export interface CatalogueMaterial {
  ref: ResourceRef;
  title: string;
  /** `owned`: the principal's own imported output (AC-R12.4). */
  origin: 'official' | 'adapted' | 'owned';
  rights: {
    /** Only `permitted` can be prepared. Everything else stays honestly reference-only. */
    status: 'permitted' | 'reference-only' | 'restricted';
    licence: string;
    /** Licence notice text written next to the applied files. Empty means the item cannot be applied. */
    notice: string;
    sourceUrl: string;
    packageName: string;
  };
  files: CatalogueMaterialFile[];
  packageDependencies: CatalogueDependency[];
  /**
   * G02: the target adapter the files are written for. `react-source/v1`
   * admits only a project whose manifest declares React 17+ and react-dom;
   * `html-artifact/v1` is a standalone unit for any project. Omitted: the
   * item's own files, checked only against its declared dependencies.
   */
  target?: CatalogueTargetReport['adapter'];
  /**
   * The licence notice for the exact files a plan writes (for example the
   * runtime files it ships and their hashes). Omitted: `rights.notice`.
   */
  noticeFor?(files: readonly { path: string; role: CatalogueMaterialFile['role']; bytes: Buffer }[]): string;
  /**
   * Sol B5/6: release minimums the units need (for GSAP recipes, the lower
   * bound of each declared range). Both the version installed under the
   * project and the lower bound of the project's declared range must reach
   * it, or prepare refuses 422 `dependency-below-minimum`. Not part of the
   * item revision.
   */
  dependencyMinimums?: readonly { name: string; minimum: string }[];
  /**
   * AC-R17: release majors a target receipt covers for a package (React95:
   * styled-components 5). The version installed under the gate's manifest
   * must resolve to one of them, or prepare refuses 422
   * `dependency-major-uncovered`: a declared range alone never proves it.
   * Not part of the item revision.
   */
  dependencyMajors?: readonly { name: string; majors: readonly number[] }[];
  /** Alias-imported modules supplied only when the project lacks them. */
  helpers?: CatalogueHelper[];
}

/** One write of a stored plan, as the apply-time re-check sees it. */
export interface CatalogueRecheckWrite { path: string; role: string; sha256: string }
/** Why a stored plan may no longer be applied; null from `recheck` means it may. */
export interface CatalogueRecheckRefusal { status: 404 | 409 | 422; reason: string; message: string }

/** An admitted catalogue source. A source without one stays reference-only for adoption. */
export interface CatalogueMaterialSource {
  readonly sourceId: ResourceRef['sourceId'];
  /** Resolves the item's current revision; null when the source does not carry the item
   * or, for a principal-scoped source, the requesting principal cannot see it. */
  materialize(itemId: string, context?: { principalId: string }): Promise<CatalogueMaterial | null>;
  /**
   * Apply-time re-check of a plan prepared earlier: the source still admits the item,
   * its rights still allow apply, and the planned bytes are still the admitted ones.
   * Runs without network. A source without it is re-checked by the route gate only.
   */
  recheck?(ref: ResourceRef, writes: readonly CatalogueRecheckWrite[]): Promise<CatalogueRecheckRefusal | null>;
  /**
   * Apply-time re-check of a plan that reuses a principal's saved unit: the source still
   * knows the item and its rights decision still allows `reuse-private-project`. The saved
   * bytes are the user's (possibly edited) copy, so they are never compared with the
   * assessed component. A source without it is re-checked by the route gate only.
   */
  recheckReuse?(ref: ResourceRef): Promise<CatalogueRecheckRefusal | null>;
}

/** Parses `name`, `name@range` and `@scope/name@range` dependency specs. */
export function parseDependencySpec(spec: string): CatalogueDependency {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return { name: trimmed, range: '*' };
  return { name: trimmed.slice(0, at), range: trimmed.slice(at + 1) || '*' };
}
