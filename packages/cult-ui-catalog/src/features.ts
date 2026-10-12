/**
 * Runtime features and asset/link/interaction requirements, detected from dependencies, index
 * metadata and (once fetched) source text. Detection is evidence-only: a feature is listed when a
 * dependency or a source pattern shows it, never guessed from the item's name.
 */

import type { IndexItem } from './kit.ts';
import type { Interaction, Requirements, RuntimeFeature } from './types.ts';

const DEPENDENCY_FEATURES: ReadonlyArray<[RuntimeFeature, RegExp]> = [
  ['motion', /^(motion|framer-motion)$/],
  ['webgl', /^(three|@react-three\/.*|ogl|cobe|@paper-design\/shaders-react)$/],
  ['shaders', /^@paper-design\/shaders(-react)?$/],
  ['redis', /^(@upstash\/redis|redis|ioredis)$/],
  ['ai-sdk', /^(ai|@ai-sdk\/.*)$/],
  ['syntax-highlighting', /^shiki$/],
];

const SOURCE_FEATURES: ReadonlyArray<[RuntimeFeature, RegExp]> = [
  ['motion', /from ['"](motion|framer-motion)(\/[a-z]+)?['"]/],
  ['canvas', /<canvas\b|getContext\(\s*['"]2d['"]/],
  ['webgl', /getContext\(\s*['"](webgl2?|experimental-webgl)['"]|WebGL(2)?RenderingContext|\bTHREE\./],
  ['shaders', /gl_FragColor|gl_Position|precision (highp|mediump|lowp) float|fragmentShader/],
  ['server-actions', /^\s*['"]use server['"]/m],
  ['browser-apis', /IntersectionObserver|ResizeObserver|requestAnimationFrame|localStorage|matchMedia\(/],
];

const INTERACTION_EVIDENCE: ReadonlyArray<[Interaction, RegExp]> = [
  ['click', /\bonClick=/],
  ['drag', /\bonDrag|\bdrag(Constraints|Controls)?=|useDrag/],
  ['hover', /onMouseEnter|onPointerEnter|whileHover|onHoverStart/],
  ['input', /\bonChange=|<input\b|<textarea\b|<select\b/],
  ['keyboard', /onKey(Down|Up|Press)=/],
  ['scroll', /onScroll=|useScroll\(|whileInView/],
  ['state', /useState\(|useReducer\(/],
];

/** Hosts in namespace URIs are identifiers, not assets. */
const NAMESPACE_HOSTS = new Set(['www.w3.org', 'w3.org']);

export function runtimeFeatures(item: IndexItem, sourceText: string): RuntimeFeature[] {
  const found = new Set<RuntimeFeature>();
  for (const dep of item.dependencies) {
    for (const [feature, pattern] of DEPENDENCY_FEATURES) if (pattern.test(dep)) found.add(feature);
  }
  for (const [feature, pattern] of SOURCE_FEATURES) if (pattern.test(sourceText)) found.add(feature);
  if (item.files.some((f) => /(^|\/)api\/.*route\.tsx?$/.test(f.path))) found.add('api-routes');
  if (item.envCount > 0) found.add('env-secrets');
  if (item.externalServices.length > 0) found.add('external-services');
  return [...found].sort();
}

export function requirements(sourceText: string): Requirements {
  const hosts = new Set<string>();
  for (const match of sourceText.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = (match[1] ?? '').toLowerCase();
    if (!NAMESPACE_HOSTS.has(host)) hosts.add(host);
  }
  const interactions = INTERACTION_EVIDENCE.filter(([, p]) => p.test(sourceText)).map(([id]) => id);
  return {
    assetHosts: [...hosts].sort(),
    images: /<img\b|<Image\b|from ['"]next\/image['"]/.test(sourceText),
    interactions: interactions.sort(),
  };
}
