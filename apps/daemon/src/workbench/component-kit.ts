import { extractCustomProperties, classifyToken } from './token-evidence.js';
export const kitTokenNames = (css: string): string[] => [...new Set(extractCustomProperties(css).map(token => token.name))].sort();
/** Presence of declared kit tokens is a fact, not a claim that a component can consume them. */
export function kitTokenAxes(css: string): { color: boolean; radius: boolean; type: boolean } {
  const tokens = extractCustomProperties(css);
  const values = new Map(tokens.map(token => [token.name, token.value]));
  return {
    color: tokens.some(token => classifyToken(token.name, token.value, values) === 'color-palette'),
    radius: tokens.some(token => /(?:^|-)radius(?:-|$)/u.test(token.name) && !!token.value.trim()),
    type: tokens.some(token => classifyToken(token.name, token.value, values) === 'type-scale'),
  };
}
