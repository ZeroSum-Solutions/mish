// P1-1 spec 1 and the re-critique JSON Schema parity spec: the `mishh-pack@1`
// manifest contract.
//
// Every fixture is synthetic and built in this file; nothing here is a real
// pack.json (the P1-9 licence guard keys on committed `pack.json` files).

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LICENSED_PACK_SOURCE,
  PACK_CONTENT_SCHEMAS,
  PACK_EXTRACTED_MAX_BYTES,
  PACK_FILE_MAX_BYTES,
  PACK_FORMAT,
  canonicalPackManifestJson,
  classifyPackSource,
  comparePackVersions,
  packManifestJsonSchema,
  packPluginSource,
  packProvides,
  parsePackManifest,
  parsePackPluginSource,
  type InstalledPackSummary,
} from '../src/api/packs.js';

const SHA = 'a'.repeat(64);

type Json = Record<string, unknown>;

function minimal(): Json {
  return {
    format: 'mishh-pack@1',
    id: 'synthetic-pack',
    version: '2026.10.7',
    title: 'Synthetic pack',
    licence: { scope: 'Synthetic test fixture, no licensed content', evidence: [] },
    contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo' }],
    files: [{ path: 'kits/demo/manifest.json', bytes: 2, sha256: SHA }],
  };
}

function full(): Json {
  return {
    ...minimal(),
    licence: { scope: 'Synthetic', holder: 'Example holder', evidence: ['docs/LICENSING.md'] },
    contents: [
      { kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo' },
      { kind: 'cult-catalog', schema: 'od-cult-pack/1', id: 'demo-kit', path: 'cult', snapshotId: 'snap-2026.10.07' },
      { kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'genui' },
      { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'plugins', ids: ['alpha', 'beta-two'] },
    ],
    files: [
      { path: 'kits/demo/manifest.json', bytes: 2, sha256: SHA },
      { path: 'cult/catalog.json', bytes: 10, sha256: SHA },
      { path: 'cult/adapters/index.json', bytes: 10, sha256: SHA },
      { path: 'cult/adapters/hero.mjs', bytes: 10, sha256: SHA },
      { path: 'genui/entries.json', bytes: 3, sha256: SHA },
      { path: 'plugins/alpha/open-design.json', bytes: 4, sha256: SHA },
      { path: 'plugins/beta-two/open-design.json', bytes: 4, sha256: SHA },
    ],
  };
}

function withFile(path: string, extra: Partial<{ bytes: number; sha256: string }> = {}): Json {
  const base = minimal();
  return { ...base, files: [...(base.files as Json[]), { path, bytes: 1, sha256: SHA, ...extra }] };
}

function withContent(entry: Json, files: Json[] = []): Json {
  const base = minimal();
  return {
    ...base,
    contents: [...(base.contents as Json[]), entry],
    files: [...(base.files as Json[]), ...files],
  };
}

function patch(change: Json): Json {
  return { ...minimal(), ...change };
}

interface Fixture {
  name: string;
  value: unknown;
  valid: boolean;
  /**
   * Cross-field rules that a JSON Schema cannot express (uniqueness by a
   * property, case folding, coverage, sums). For these `parsePackManifest`
   * rejects and `packManifestJsonSchema` accepts; the schema docblock says so.
   */
  crossField?: true;
}

const FIXTURES: Fixture[] = [
  { name: 'minimal manifest', value: minimal(), valid: true },
  { name: 'all four kinds', value: full(), valid: true },
  { name: 'version 0.0.0', value: patch({ version: '0.0.0' }), valid: true },
  { name: 'non-ASCII path', value: withFile('kits/demo/caf\u00e9.json'), valid: true },

  { name: 'not an object', value: 'pack', valid: false },
  { name: 'wrong format', value: patch({ format: 'mishh-pack@2' }), valid: false },
  { name: 'missing format', value: (() => { const { format: _f, ...rest } = minimal(); return rest; })(), valid: false },
  { name: 'unknown top-level key', value: patch({ minAppVersion: '1.0.0' }), valid: false },
  { name: 'uppercase id', value: patch({ id: 'Synthetic' }), valid: false },
  { name: 'dotted id', value: patch({ id: 'synthetic.pack' }), valid: false },
  { name: 'id starting with a dash', value: patch({ id: '-pack' }), valid: false },
  { name: 'id .staging', value: patch({ id: '.staging' }), valid: false },
  { name: 'id over 64 characters', value: patch({ id: `a${'b'.repeat(64)}` }), valid: false },
  { name: 'id with a slash', value: patch({ id: 'a/b' }), valid: false },
  { name: 'version with leading zero (2026.10.07)', value: patch({ version: '2026.10.07' }), valid: false },
  { name: 'version with two parts', value: patch({ version: '1.0' }), valid: false },
  { name: 'version with prerelease', value: patch({ version: '1.0.0-beta' }), valid: false },
  { name: 'empty title', value: patch({ title: '' }), valid: false },
  { name: 'licence without scope', value: patch({ licence: { evidence: [] } }), valid: false },
  { name: 'empty contents', value: patch({ contents: [] }), valid: false },
  { name: 'empty files', value: patch({ files: [] }), valid: false },
  {
    name: 'unknown kind',
    value: withContent({ kind: 'section-entries', schema: 'od-sections/1', path: 'kits/demo' }),
    valid: false,
  },
  {
    name: 'dropped kind genui-components',
    value: withContent({ kind: 'genui-components', schema: 'od-genui/1', path: 'kits/demo' }),
    valid: false,
  },
  {
    name: 'unknown schema version for a known kind',
    value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/2', id: 'demo-kit', path: 'kits/demo' }] }),
    valid: false,
  },
  {
    name: 'content entry without schema',
    value: patch({ contents: [{ kind: 'component-kit', id: 'demo-kit', path: 'kits/demo' }] }),
    valid: false,
  },
  {
    name: 'content entry with an extra key',
    value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo', extra: 1 }] }),
    valid: false,
  },
  {
    name: 'cult-catalog without snapshotId',
    value: withContent({ kind: 'cult-catalog', schema: 'od-cult-pack/1', id: 'demo-kit', path: 'kits/demo' }),
    valid: false,
  },
  {
    name: 'plugins with no ids',
    value: withContent({ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: [] }),
    valid: false,
  },
  {
    name: 'plugins with a duplicate id',
    value: withContent({ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: ['alpha', 'alpha'] }),
    valid: false,
  },
  {
    name: 'plugins with an unsafe id',
    value: withContent({ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: ['../alpha'] }),
    valid: false,
  },
  { name: 'absolute file path', value: withFile('/etc/passwd'), valid: false },
  { name: 'traversal file path', value: withFile('kits/../../escape.json'), valid: false },
  { name: 'leading .. segment', value: withFile('../escape.json'), valid: false },
  { name: 'dot segment', value: withFile('kits/./demo.json'), valid: false },
  { name: 'empty segment', value: withFile('kits//demo.json'), valid: false },
  { name: 'trailing slash', value: withFile('kits/demo/'), valid: false },
  { name: 'backslash path', value: withFile('kits\\demo.json'), valid: false },
  { name: 'NUL in path', value: withFile('kits/demo\u0000.json'), valid: false },
  { name: 'control character in path', value: withFile('kits/demo\n.json'), valid: false },
  { name: 'path over 512 characters', value: withFile(`kits/${'a'.repeat(510)}`), valid: false },
  { name: 'pack.json listed in files', value: withFile('pack.json'), valid: false },
  { name: 'uppercase sha256', value: withFile('kits/demo/b.json', { sha256: 'A'.repeat(64) }), valid: false },
  { name: 'short sha256', value: withFile('kits/demo/b.json', { sha256: 'a'.repeat(63) }), valid: false },
  { name: 'negative bytes', value: withFile('kits/demo/b.json', { bytes: -1 }), valid: false },
  { name: 'fractional bytes', value: withFile('kits/demo/b.json', { bytes: 1.5 }), valid: false },
  { name: 'file over the per-file cap', value: withFile('kits/demo/b.json', { bytes: PACK_FILE_MAX_BYTES + 1 }), valid: false },
  { name: 'content path absolute', value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: '/kits/demo' }] }), valid: false },

  // Lane round N2/N3: well-formed Unicode, Windows-unsafe names, more control characters.
  { name: 'lone surrogate in a path', value: withFile('kits/demo/\ud800.json'), valid: false },
  { name: 'lone surrogate in the title', value: patch({ title: 'bad \udc00 title' }), valid: false },
  { name: 'emoji title of 120 code points', value: patch({ title: '\u{1F600}'.repeat(120) }), valid: true },
  { name: 'emoji title of 121 code points', value: patch({ title: '\u{1F600}'.repeat(121) }), valid: false },
  { name: 'C1 control character in a path', value: withFile('kits/demo/a\u0085b.json'), valid: false },
  { name: 'Pack.json listed (case folds to pack.json)', value: withFile('Pack.json'), valid: false },
  { name: 'PACK.JSON with a Kelvin sign k', value: withFile('PAC\u212a.JSON'), valid: false },
  { name: 'pack.json inside a folder is an ordinary file', value: withFile('kits/demo/pack.json'), valid: true },
  { name: 'reserved Windows id con', value: patch({ id: 'con' }), valid: false },
  { name: 'reserved Windows id lpt1', value: patch({ id: 'lpt1' }), valid: false },
  { name: 'id that only starts like a reserved name', value: patch({ id: 'console' }), valid: true },
  { name: 'reserved Windows basename with an extension', value: withFile('kits/demo/aux.js'), valid: false },
  { name: 'reserved Windows folder name', value: withFile('kits/NUL/a.json'), valid: false },
  { name: 'reserved name in a longer basename is fine', value: withFile('kits/demo/auxiliary.js'), valid: true },
  { name: 'segment ending in a dot', value: withFile('kits/demo/x.'), valid: false },
  { name: 'segment of three dots', value: withFile('kits/.../x.json'), valid: false },
  { name: 'segment ending in a space', value: withFile('kits/demo /x.json'), valid: false },
  { name: 'colon in a path', value: withFile('kits/demo/a:b.json'), valid: false },
  {
    name: 'reserved plugin id',
    value: withContent({ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: ['com3'] }),
    valid: false,
  },
  {
    name: 'plugin id ending in a dot',
    value: withContent({ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: ['alpha.'] }),
    valid: false,
  },
  { name: 'reserved content id', value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'prn', path: 'kits/demo' }] }), valid: false },
  { name: 'version over 64 characters', value: patch({ version: `1.0.${'1'.repeat(70)}` }), valid: false },
  { name: 'licence holder null', value: patch({ licence: { scope: 's', evidence: [], holder: null } }), valid: false },

  // Cross-field rules: parsePackManifest only.
  { name: 'duplicate file path', value: withFile('kits/demo/manifest.json'), valid: false, crossField: true },
  { name: 'case-colliding file paths', value: withFile('kits/demo/Manifest.json'), valid: false, crossField: true },
  {
    name: 'NFC/NFD-colliding file paths',
    value: (() => {
      const base = withFile('kits/demo/caf\u00e9.json');
      return { ...base, files: [...(base.files as Json[]), { path: 'kits/demo/cafe\u0301.json', bytes: 1, sha256: SHA }] };
    })(),
    valid: false,
    crossField: true,
  },
  { name: 'file shadowing a listed directory', value: withFile('kits/demo'), valid: false, crossField: true },
  {
    name: 'content path not covered by files[]',
    value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/other' }] }),
    valid: false,
    crossField: true,
  },
  {
    name: 'content path that is only a string prefix of a file',
    value: patch({ contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/de' }] }),
    valid: false,
    crossField: true,
  },
  {
    name: 'duplicate component-kit id',
    value: withContent({ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo' }),
    valid: false,
    crossField: true,
  },
  {
    name: 'two genui-overlay entries',
    value: (() => {
      const entry = { kind: 'genui-overlay', schema: 'od-genui-overlay/1', path: 'kits/demo' };
      return patch({ contents: [entry, entry] });
    })(),
    valid: false,
    crossField: true,
  },
  {
    name: 'plugin id listed by two plugins entries',
    value: patch({
      contents: [
        { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits/demo', ids: ['alpha'] },
        { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'kits', ids: ['alpha'] },
      ],
    }),
    valid: false,
    crossField: true,
  },
  {
    name: 'two folders that differ only by case',
    value: withFile('Kits/other.json'),
    valid: false,
    crossField: true,
  },
  {
    name: 'total bytes over the extracted cap',
    value: patch({
      files: Array.from({ length: Math.ceil(PACK_EXTRACTED_MAX_BYTES / PACK_FILE_MAX_BYTES) + 1 }, (_, i) => ({
        path: `kits/demo/part-${i}.bin`,
        bytes: PACK_FILE_MAX_BYTES,
        sha256: SHA,
      })),
    }),
    valid: false,
    crossField: true,
  },
];

describe('mishh-pack@1 manifest (P1-1 spec 1)', () => {
  it('parsePackManifest accepts a minimal manifest and rejects unsafe ids, absolute or traversal paths, unknown kinds, unknown schema versions, leading-zero versions, duplicate and case-colliding paths, and content paths not covered by files[]', () => {
    const wrong: string[] = [];
    for (const fixture of FIXTURES) {
      const result = parsePackManifest(fixture.value);
      if (result.ok !== fixture.valid) wrong.push(`${fixture.name}: expected ${fixture.valid ? 'valid' : 'invalid'}`);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.length).toBeLessThanOrEqual(20);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('returns a typed manifest with every content kind and its schema', () => {
    const result = parsePackManifest(full());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.format).toBe(PACK_FORMAT);
    expect(result.manifest.contents.map((entry) => `${entry.kind}:${entry.schema}`)).toEqual([
      `component-kit:${PACK_CONTENT_SCHEMAS['component-kit']}`,
      `cult-catalog:${PACK_CONTENT_SCHEMAS['cult-catalog']}`,
      `genui-overlay:${PACK_CONTENT_SCHEMAS['genui-overlay']}`,
      `plugins:${PACK_CONTENT_SCHEMAS.plugins}`,
    ]);
  });

  it('packManifestJsonSchema accepts and rejects the same fixtures as parsePackManifest', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(packManifestJsonSchema);
    const mismatches: string[] = [];
    for (const fixture of FIXTURES) {
      const zodOk = parsePackManifest(fixture.value).ok;
      const schemaOk = validate(fixture.value) === true;
      expect(zodOk).toBe(fixture.valid);
      // A cross-field fixture is the one documented gap: the JSON Schema
      // accepts it and only parsePackManifest refuses it.
      const expectedSchemaOk = fixture.crossField ? true : zodOk;
      if (schemaOk !== expectedSchemaOk) mismatches.push(`${fixture.name}: schema ${schemaOk}, zod ${zodOk}`);
    }
    expect(mismatches).toEqual([]);
    expect(packManifestJsonSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('packManifestJsonSchema is a plain JSON literal', () => {
    expect(JSON.parse(JSON.stringify(packManifestJsonSchema))).toEqual(packManifestJsonSchema);
  });
});

describe('manifest issue text (lane round N5)', () => {
  it('reports an unknown key as a fixed "unknown field" text and strips control characters from echoed text', () => {
    const result = parsePackManifest({ ...minimal(), ['\u001b[2J\u001b[31mevil']: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.issues.join('\n');
    expect(text).toContain('unknown field');
    expect(text).not.toContain('evil');
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe('pack versions, digests and DTO helpers', () => {
  it('compares versions numerically', () => {
    expect(comparePackVersions('2026.10.7', '2026.9.30')).toBe(1);
    expect(comparePackVersions('1.0.0', '1.0.0')).toBe(0);
    expect(comparePackVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(comparePackVersions('10.0.0', '9.99.99')).toBe(1);
    expect(comparePackVersions('123456789012345678901.0.0', '123456789012345678902.0.0')).toBe(-1);
  });

  it('canonicalises a manifest independent of key and files[] order', () => {
    const a = parsePackManifest(full());
    const shuffled = full();
    shuffled.files = [...(shuffled.files as Json[])].reverse();
    const b = parsePackManifest(Object.fromEntries(Object.entries(shuffled).reverse()));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalPackManifestJson(a.manifest)).toBe(canonicalPackManifestJson(b.manifest));
    const changed = parsePackManifest({ ...full(), title: 'Other title' });
    if (!changed.ok) throw new Error('fixture');
    expect(canonicalPackManifestJson(changed.manifest)).not.toBe(canonicalPackManifestJson(a.manifest));
  });

  it('packProvides reads ready and degraded packs and ignores damaged ones', () => {
    const summary = (status: InstalledPackSummary['status']): InstalledPackSummary => ({
      id: 'synthetic-pack',
      version: '1.0.0',
      title: 'Synthetic',
      licenceScope: 'Synthetic',
      contents: [
        { kind: 'component-kit', id: 'demo-kit', count: 1 },
        { kind: 'plugins', count: 2 },
      ],
      status,
      digest: SHA,
      source: 'local:synthetic.tgz',
      installedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(packProvides([summary('ready')], 'component-kit', 'demo-kit')).toBe(true);
    expect(packProvides([summary('degraded')], 'component-kit', 'demo-kit')).toBe(true);
    expect(packProvides([summary('damaged')], 'component-kit', 'demo-kit')).toBe(false);
    expect(packProvides([summary('ready')], 'component-kit', 'other')).toBe(false);
    expect(packProvides([summary('ready')], 'plugins')).toBe(true);
    expect(packProvides([summary('ready')], 'genui-overlay')).toBe(false);
    expect(packProvides([], 'component-kit')).toBe(false);
  });

  it('classifies install sources and names the default pack source', () => {
    expect(DEFAULT_LICENSED_PACK_SOURCE).toBe('github:ZeroSum-Solutions/mishh-licensed');
    expect(classifyPackSource(DEFAULT_LICENSED_PACK_SOURCE)).toBe('github');
    expect(classifyPackSource('github:acme/pack@1.2.3')).toBe('github');
    expect(classifyPackSource('/tmp/pack.tgz')).toBe('path');
    expect(classifyPackSource('C:\\packs\\pack.tgz')).toBe('path');
    expect(classifyPackSource('relative/pack.tgz')).toBeNull();
    expect(classifyPackSource('https://example.com/pack.tgz')).toBeNull();
  });

  it('round-trips the pack:<id>@<version> plugin source and rejects anything else (P1-5)', () => {
    expect(packPluginSource('synthetic-pack', '1.2.3')).toBe('pack:synthetic-pack@1.2.3');
    expect(parsePackPluginSource('pack:synthetic-pack@1.2.3')).toEqual({ packId: 'synthetic-pack', version: '1.2.3' });
    expect(parsePackPluginSource('pack:synthetic-pack')).toBeNull();
    expect(parsePackPluginSource('pack:Bad_Id@1.0.0')).toBeNull();
    expect(parsePackPluginSource('pack:ok@1.0')).toBeNull();
    expect(parsePackPluginSource('pack:ok@1.0.0@2')).toBeNull();
    expect(parsePackPluginSource('github:acme/pack')).toBeNull();
    expect(parsePackPluginSource('/tmp/pack:ok@1.0.0')).toBeNull();
    expect(parsePackPluginSource(undefined)).toBeNull();
  });
});
