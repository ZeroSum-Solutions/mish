/**
 * Pure logic in scripts/thumbnail-harness.ts's client-render stub plugin (G12 Addendum 4): which
 * imports become a live-returning hook shim vs. a bare stub value, which lower-camelCase names
 * fall back to an empty array (webgl data exports) or a factory call that returns a real inert
 * value instead of `null` (server-stubbed factory functions), and which bare specifiers resolve
 * through this package's own dependencies instead of an inert stub. No kit, no browser, no
 * network — these fixes turned 17 of the original 20 blank Cult thumbnails into real renders.
 */

import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';

import { HOOK_NAME, STUB_EXPORTS, workspaceResolve } from '../scripts/thumbnail-harness.ts';

test('HOOK_NAME matches a leading use-hook name and a prefixed one, not an unrelated identifier', () => {
  assert.equal(HOOK_NAME.test('useState'), true);
  assert.equal(HOOK_NAME.test('useChat'), true);
  // The AI SDK's naming convention that a plain /^use[A-Z]/ check misses.
  assert.equal(HOOK_NAME.test('experimental_useObject'), true);
  assert.equal(HOOK_NAME.test('experimental_useAssistant'), true);
  assert.equal(HOOK_NAME.test('z'), false);
  assert.equal(HOOK_NAME.test('Redis'), false);
  assert.equal(HOOK_NAME.test('useless'), false); // "use" not followed by an uppercase letter
});

test('STUB_EXPORTS re-exports a hook name as a call that RETURNS an inert value, not the inert value itself', () => {
  const code = STUB_EXPORTS(['experimental_useObject', 'z', 'Redis'], 'Stub');
  assert.match(code, /export const experimental_useObject = \(\) => inert\(\);/);
  // A non-hook export is bound to the stub component/value directly, so `z.string` etc. still
  // chains through the inert Proxy rather than crashing on `undefined`.
  assert.match(code, /export const z = Stub;/);
  assert.match(code, /export const Redis = Stub;/);
});

test('workspaceResolve finds a real package this package depends on (zod), for real schema behaviour instead of an inert stub', () => {
  const resolved = workspaceResolve('zod');
  assert.ok(resolved, 'zod must resolve: it is declared in package.json so an AI-block\'s `import { z } from "zod"` renders for real');
  assert.ok(isAbsolute(resolved!));
});

test('workspaceResolve refuses a Node built-in: it resolves to its own bare specifier, not a file path esbuild can use', () => {
  assert.equal(workspaceResolve('fs/promises'), null);
  assert.equal(workspaceResolve('node:fs'), null);
});

test('workspaceResolve returns null for a package this package does not depend on (falls through to the stub, unchanged)', () => {
  assert.equal(workspaceResolve('this-package-does-not-exist-anywhere-xyz'), null);
});

test('STUB_EXPORTS with dataFallback binds a lower-camelCase name to an empty array, not the component value', () => {
  // `flutedGlassPresets` from `@paper-design/shaders-react` (a webgl package the harness always
  // stubs to a bare <canvas>): binding it to the canvas component made `.map()` on it throw.
  const code = STUB_EXPORTS(['flutedGlassPresets', 'FlutedGlass'], 'C', true);
  assert.match(code, /export const flutedGlassPresets = \[\];/);
  // A PascalCase name is still treated as a component.
  assert.match(code, /export const FlutedGlass = C;/);
});

test('STUB_EXPORTS with factoryFallback binds a lower-camelCase name to a call that returns inert(), not the stub component', () => {
  // `tool` from `ai` (fully server-stubbed): bound to the default Stub value, `tool({...})`
  // called Stub's own `apply` trap, which returns a bare `null` (correct for a stubbed React
  // component rendering nothing, wrong for a factory function) — `tools.someTool.execute` then
  // threw on `null.execute`. A local `() => inert()` wrapper always returns a chainable value.
  const code = STUB_EXPORTS(['tool', 'Redis'], 'Stub', false, true);
  assert.match(code, /export const tool = \(\) => inert\(\);/);
  assert.match(code, /export const Redis = Stub;/);
});
