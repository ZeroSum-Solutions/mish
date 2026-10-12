/**
 * `validateAdapterFill`'s link validation
 * (`plugins/_official/shared/agency-compiler/scripts/section-adapter.ts`) — NIT 8, delta audit:
 * a link's `href` is fixed at adapter-author time; the model may never supply a URL. Loaded by
 * path (not a workspace import) for the same reason `section-overlay.ts` loads it that way — see
 * that file's module boundary note.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sharedCompilerDir = path.resolve(import.meta.dirname, '../../../plugins/_official/shared/agency-compiler/scripts');
const importFrom = (file: string) => import(pathToFileURL(file).href);

const { validateAdapterFill } = await importFrom(path.join(sharedCompilerDir, 'section-adapter.ts'));

type TestAdapter = {
  id: string;
  version: string;
  sourceBlockId: string;
  sourceSha256: string;
  roles: readonly string[];
  text: ReadonlyArray<{ name: string; max: number }>;
  links: ReadonlyArray<{ name: string; href: string; label?: string }>;
  css: string;
  render: (fill: unknown) => string;
};

function testAdapter(): TestAdapter {
  return {
    id: 'test:fixture/1',
    version: '1.0.0',
    sourceBlockId: 'fixture/1',
    sourceSha256: 'x'.repeat(64),
    roles: ['accent'],
    text: [{ name: 'cta', max: 32 }],
    links: [{ name: 'action', href: '#contact', label: 'cta' }],
    css: '',
    render: () => '',
  };
}

test('validateAdapterFill: an unknown link slot is rejected', () => {
  const adapter = testAdapter();
  const errors = validateAdapterFill(adapter, { text: { cta: 'Book a call' }, links: { nope: '#contact' } });
  assert.ok(errors.some((e: { slot: string; reason: string }) => e.slot === 'nope' && e.reason === 'unknown link slot'));
});

test('validateAdapterFill: a link value matching the adapter-declared href is accepted', () => {
  const adapter = testAdapter();
  const errors = validateAdapterFill(adapter, { text: { cta: 'Book a call' }, links: { action: '#contact' } });
  assert.deepEqual(errors, []);
});

test('validateAdapterFill: a link value that does not match the adapter-declared href is refused, never trusted as a model-supplied URL', () => {
  const adapter = testAdapter();
  const errors = validateAdapterFill(adapter, { text: { cta: 'Book a call' }, links: { action: 'https://evil.example/phish' } });
  assert.ok(errors.some((e: { slot: string; reason: string }) => e.slot === 'action' && /adapter-declared href/.test(e.reason)));
});
