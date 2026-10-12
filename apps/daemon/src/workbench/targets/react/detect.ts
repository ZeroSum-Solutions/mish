import { createHash } from 'node:crypto';
import type { CatalogueTargetRefusal } from '@mish/contracts';
import type { InstalledPackage } from '../../adoption/installed-packages.js';

type Manifest = Record<string, unknown>;
export type ProjectFramework = 'react' | 'next' | 'remix' | 'preact' | 'vue' | 'nuxt' | 'svelte' | 'sveltekit' | 'angular' | 'solid' | 'astro' | 'none';

/** What the project's own package.json says about its UI runtime. Nothing is inferred from the project kind. */
export interface ProjectTargetProfile {
  framework: ProjectFramework;
  reactMajor: number | null;
  reactDomMajor: number | null;
  typescript: boolean;
  styleRuntime: 'css' | 'tailwind4' | 'styled-components' | 'unknown';
  /** Digest of the declared dependency sections, so a receipt names the exact graph it checked. */
  dependencyDigest: string;
}

export type ReactTargetCheck =
  | { ok: true; profile: ProjectTargetProfile }
  | { ok: false; reason: CatalogueTargetRefusal['targetReason']; profile: ProjectTargetProfile; message: string };

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
/** First React major this adapter's units support (`@gsap/react` declares `react >=17`). */
export const MINIMUM_REACT_MAJOR = 17;

function declared(manifest: Manifest | null): Map<string, string> {
  const specs = new Map<string, string>();
  if (!manifest) return specs;
  for (const section of SECTIONS) {
    const entries = manifest[section];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) if (typeof spec === 'string' && !specs.has(name)) specs.set(name, spec);
  }
  return specs;
}

/** Leading major of a plain semver range (`18.3.1`, `^18.0.0`, `~19.1`, `>=17`); null for tags, protocols and `*`. */
export function leadingMajor(spec: string | undefined): number | null {
  if (spec === undefined) return null;
  const match = /^\s*(?:\^|~|>=|=|v)?\s*(\d+)(?:\.|\s*$)/u.exec(spec);
  return match ? Number(match[1]) : null;
}

function frameworkOf(specs: ReadonlyMap<string, string>): ProjectFramework {
  if (specs.has('next')) return 'next';
  if (specs.has('@remix-run/react')) return 'remix';
  if (specs.has('nuxt')) return 'nuxt';
  if (specs.has('@sveltejs/kit')) return 'sveltekit';
  if (specs.has('@angular/core')) return 'angular';
  if (specs.has('astro')) return 'astro';
  if (specs.has('react')) return 'react';
  if (specs.has('preact')) return 'preact';
  if (specs.has('vue')) return 'vue';
  if (specs.has('svelte')) return 'svelte';
  if (specs.has('solid-js')) return 'solid';
  return 'none';
}

function styleRuntimeOf(specs: ReadonlyMap<string, string>): ProjectTargetProfile['styleRuntime'] {
  if (specs.has('styled-components')) return 'styled-components';
  const tailwind = leadingMajor(specs.get('tailwindcss') ?? specs.get('@tailwindcss/vite') ?? specs.get('@tailwindcss/postcss'));
  if (tailwind !== null && tailwind >= 4) return 'tailwind4';
  return specs.size ? 'css' : 'unknown';
}

/** Other UI runtimes that make a manifest declaring React ambiguous as a React target. */
const OTHER_UI_RUNTIMES = ['vue', 'svelte', 'solid-js', 'preact', '@angular/core'] as const;

export interface ProjectTargetContext {
  /** A `tsconfig.json` sits next to the manifest (TypeScript without a declared `typescript` package). */
  tsconfig?: boolean;
  /**
   * What the project resolves for react and react-dom from the manifest's
   * directory (installed-packages.ts). The React adapter admits only these
   * resolved majors; without them it refuses `react-version-unresolved`.
   */
  installed?: { react: InstalledPackage; reactDom: InstalledPackage };
}

/** G02: classifies a project from its package.json (null when it has none). */
export function detectProjectTarget(manifest: Manifest | null, context: ProjectTargetContext = {}): ProjectTargetProfile {
  const specs = declared(manifest);
  const sorted = [...specs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    framework: frameworkOf(specs),
    reactMajor: leadingMajor(specs.get('react')),
    reactDomMajor: leadingMajor(specs.get('react-dom')),
    typescript: specs.has('typescript') || context.tsconfig === true,
    styleRuntime: manifest ? styleRuntimeOf(specs) : 'unknown',
    dependencyDigest: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
  };
}

/**
 * G02 `react-source/v1` admission: a TSX unit lands only in a project whose
 * own (nearest) manifest declares React (major ≥ 17), react-dom of the same
 * major, TypeScript (a `typescript` package or a tsconfig.json) and no second
 * UI runtime. Every other project gets a typed reason naming what was
 * detected. The adapter never converts a unit to another framework or to
 * JavaScript, and never installs or upgrades anything. Compound ranges such
 * as `>=17 <19` or `17 || 18` are not read as one release line and stay
 * refused (`react-version-unreadable`): fail closed.
 *
 * Sol B5/6 BLOCK: a declared range only says what may be installed (`>=18.0.0`
 * can resolve React 19). The majors the adapter reports, and the receipt gate
 * checks, are the resolved react and react-dom versions installed under the
 * project root; when either cannot be resolved there the target is refused
 * `react-version-unresolved`.
 */
export function checkReactTarget(manifest: Manifest | null, context: ProjectTargetContext = {}): ReactTargetCheck {
  const profile = detectProjectTarget(manifest, context);
  const specs = declared(manifest);
  const refuse = (reason: CatalogueTargetRefusal['targetReason'], detail: string): ReactTargetCheck =>
    ({ ok: false, reason, profile, message: `${detail}; nothing was converted or written` });
  if (!manifest) return refuse('package-manifest-missing', 'This React unit needs a project package.json that declares react and react-dom');
  if (!specs.has('react')) return refuse('target-not-react', `This project is ${profile.framework === 'none' ? 'not a framework project' : `a ${profile.framework} project`}, not a React target; use the HTML artifact of this recipe instead`);
  if (profile.reactMajor === null) return refuse('react-version-unreadable', `The declared react version "${specs.get('react')}" cannot be read as a release; pin a React ${MINIMUM_REACT_MAJOR}+ version`);
  if (profile.reactMajor < MINIMUM_REACT_MAJOR) return refuse('react-version-unsupported', `React ${profile.reactMajor} is older than the supported React ${MINIMUM_REACT_MAJOR}+`);
  const other = OTHER_UI_RUNTIMES.find(name => specs.has(name));
  if (other) return refuse('target-ambiguous', `This project declares both react and ${other}; choose the target explicitly by applying in a package that declares only one UI runtime`);
  if (!specs.has('react-dom')) return refuse('react-dom-missing', 'This project declares react without react-dom');
  if (profile.reactDomMajor !== profile.reactMajor) return refuse('react-dom-mismatch', `react ${profile.reactMajor} and react-dom ${profile.reactDomMajor ?? specs.get('react-dom')} are different majors`);
  const react = context.installed?.react, reactDom = context.installed?.reactDom;
  if (react?.state !== 'resolved' || reactDom?.state !== 'resolved') {
    const [name, state] = react?.state !== 'resolved' ? ['react', react?.state] : ['react-dom', reactDom?.state];
    const why = state === undefined ? 'it was not read' : state === 'absent' ? 'it is not installed' : 'it is unreadable or resolves outside the project root';
    return refuse('react-version-unresolved', `The installed ${name} version could not be resolved inside the project (${why}); install the project's dependencies, then apply again`);
  }
  const resolvedProfile: ProjectTargetProfile = { ...profile, reactMajor: react.major, reactDomMajor: reactDom.major };
  const refuseResolved = (reason: CatalogueTargetRefusal['targetReason'], detail: string): ReactTargetCheck =>
    ({ ok: false, reason, profile: resolvedProfile, message: `${detail}; nothing was converted or written` });
  if (react.major < MINIMUM_REACT_MAJOR) return refuseResolved('react-version-unsupported', `The installed React ${react.version} is older than the supported React ${MINIMUM_REACT_MAJOR}+`);
  if (reactDom.major !== react.major) return refuseResolved('react-dom-mismatch', `The installed react ${react.version} and react-dom ${reactDom.version} are different majors`);
  if (!profile.typescript) return refuseResolved('typescript-missing', 'This unit is TypeScript (TSX) and the project declares no TypeScript; add typescript or a tsconfig.json, or use the HTML artifact of this recipe');
  return { ok: true, profile: resolvedProfile };
}
