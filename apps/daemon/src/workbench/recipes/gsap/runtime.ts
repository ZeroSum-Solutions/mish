import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * AC-R08.5 pins (candidate 40, `motion-and-checklist-policy.md`). The daemon
 * ships the runtime from its own pinned `gsap` dependency: HTML exports and
 * previews carry these exact bytes, never a CDN reference.
 */
export const GSAP_PIN = Object.freeze({
  packageName: 'gsap', version: '3.15.0',
  repository: 'https://github.com/greensock/GSAP', commit: '13e2b790546426a1a2e0e9b409f3f8dc6d6611f2',
  licence: "GSAP Standard 'no charge' License", licenceUrl: 'https://gsap.com/standard-license',
});
/** React companion, declared to React projects as a dependency; the daemon never installs it. */
export const GSAP_REACT_PIN = Object.freeze({ packageName: '@gsap/react', version: '2.1.2', range: '^2.1.2' });
export const GSAP_RANGE = '^3.15.0';

/** Only these files are shipped. No `gsap/all`, no unselected plugins. */
export const GSAP_RUNTIME_FILES = ['gsap', 'ScrollTrigger', 'Flip'] as const;
export type GsapRuntimeFile = typeof GSAP_RUNTIME_FILES[number];

export interface GsapRuntime {
  version: string;
  files: Record<GsapRuntimeFile, { bytes: Buffer; sha256: string; name: string }>;
}

export class GsapRuntimeError extends Error {
  constructor(readonly reason: 'gsap-runtime-missing' | 'gsap-runtime-version-mismatch', message: string) {
    super(message);
    this.name = 'GsapRuntimeError';
  }
}

/**
 * The licence record (official standard licence and FAQ, effective 2025-04-30,
 * audited 2026-10-02 in `evidence/candidate-gsap.md`). It summarizes the terms
 * that govern this lane, points to the full text and lists exactly the runtime
 * files this unit ships (none for a React unit, whose project declares the
 * packages). It does not claim MIT or invent a special grant.
 */
export function gsapNotice(shipped: readonly { path: string; sha256: string }[]): string {
  return [
    `GSAP ${GSAP_PIN.version} is used under the ${GSAP_PIN.licence}: ${GSAP_PIN.licenceUrl}`,
    '',
    'Copyright GreenSock (Webflow). All rights reserved. GSAP has its own custom terms, not an open-source licence.',
    'The standard licence permits use in websites, web applications and digital interfaces, including',
    'commercial projects, at no charge. Keep the copyright notices in the runtime files intact.',
    '',
    'Restriction: using GSAP inside a tool that lets people build animations visually without code, in a',
    "way that competes with Webflow's visual animation building, needs prior written consent from",
    'GreenSock/Webflow. The licence FAQ accepts AI-generated GSAP code, and a playback preview alone does',
    'not establish that restricted use; any visual animation-authoring mode needs its own assessment',
    'against the terms. Reusable-source redistribution is assessed separately and is not granted here.',
    '',
    `Source: ${GSAP_PIN.repository} at ${GSAP_PIN.commit} (package ${GSAP_PIN.packageName}@${GSAP_PIN.version}).`,
    ...(shipped.length
      ? ['Runtime files shipped with this unit and their SHA-256:', ...shipped.map(file => `- ${file.path}: ${file.sha256}`)]
      : [`No GSAP runtime files are shipped with this unit: the project declares ${GSAP_PIN.packageName} ${GSAP_RANGE} and ${GSAP_REACT_PIN.packageName} ${GSAP_REACT_PIN.range}, installed by its own package manager.`]),
    '',
  ].join('\n');
}

/** Only an absent package or file means "missing"; any other failure (permissions, I/O) is a real error. */
const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '');

const defaultPackageDir = () => path.dirname(createRequire(import.meta.url).resolve('gsap/package.json'));

/**
 * Reads the pinned runtime files from the daemon's `gsap` package. A missing
 * package or a different version fails closed with a typed reason; nothing is
 * fetched from the network as a fallback.
 */
export function loadGsapRuntime(packageDir: () => string = defaultPackageDir): GsapRuntime {
  let dir: string;
  let version: unknown;
  try {
    dir = packageDir();
    version = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new GsapRuntimeError('gsap-runtime-missing', `The pinned gsap ${GSAP_PIN.version} package is not installed with the daemon`);
  }
  if (version !== GSAP_PIN.version) throw new GsapRuntimeError('gsap-runtime-version-mismatch', `Expected gsap ${GSAP_PIN.version}, found ${String(version)}`);
  const files = {} as GsapRuntime['files'];
  try {
    for (const file of GSAP_RUNTIME_FILES) {
      const bytes = readFileSync(path.join(dir, 'dist', `${file}.min.js`));
      files[file] = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), name: `${file}.min.js` };
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new GsapRuntimeError('gsap-runtime-missing', `The pinned gsap ${GSAP_PIN.version} package is missing its dist runtime files`);
  }
  return { version: GSAP_PIN.version, files };
}
