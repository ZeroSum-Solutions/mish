import type { CatalogueDependencyReport } from '@mish/contracts';
import type { CatalogueDependency } from './catalogue-material.js';

export interface DependencyCheck extends CatalogueDependencyReport {
  satisfied: { name: string; range: string; installed: string }[];
}
type Manifest = Record<string, unknown>;
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Installed specs from every manifest section; the first section that names a package wins. */
function installedSpecs(manifest: Manifest): Map<string, string> {
  const specs = new Map<string, string>();
  for (const section of SECTIONS) {
    const entries = manifest[section];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) if (typeof spec === 'string' && !specs.has(name)) specs.set(name, spec);
  }
  return specs;
}

/** Leading [major, minor] of a semver range, or null when the range is not a plain version range. */
function leadingVersion(range: string): [number, number] | null {
  const match = /^\s*(?:\^|~|>=|=|v)?\s*(\d+)(?:\.(\d+|x|\*))?/u.exec(range);
  if (!match) return null;
  const minor = match[2] === undefined || match[2] === 'x' || match[2] === '*' ? -1 : Number(match[2]);
  return [Number(match[1]), minor];
}

/**
 * Same release line by caret semantics: majors must match, and for 0.x the
 * minors must match too. Ranges this check cannot read (tags, workspace or
 * file protocols, `*`) are not called incompatible: the report never invents
 * a conflict it cannot show.
 */
export function rangesCompatible(required: string, installed: string): boolean {
  const want = leadingVersion(required), have = leadingVersion(installed);
  if (!want || !have) return true;
  if (want[0] !== have[0]) return false;
  return want[0] !== 0 || want[1] === -1 || have[1] === -1 || want[1] === have[1];
}

/**
 * AC-R04.3: classifies each declared npm dependency against the project's
 * package manifest. `manifest` null means the project has no package.json,
 * so every declared dependency is missing.
 */
export function checkDependencies(declared: readonly CatalogueDependency[], manifest: Manifest | null): DependencyCheck {
  const installed = manifest ? installedSpecs(manifest) : new Map<string, string>();
  const report: DependencyCheck = { missing: [], incompatible: [], satisfied: [] };
  const seen = new Set<string>();
  for (const dependency of declared) {
    if (seen.has(dependency.name)) continue;
    seen.add(dependency.name);
    const spec = installed.get(dependency.name);
    if (spec === undefined) report.missing.push({ name: dependency.name, range: dependency.range });
    else if (!rangesCompatible(dependency.range, spec)) report.incompatible.push({ name: dependency.name, required: dependency.range, installed: spec });
    else report.satisfied.push({ name: dependency.name, range: dependency.range, installed: spec });
  }
  return report;
}
