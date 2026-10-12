import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, readCsvSeed, readSeed, serialiseCatalog } from '../scripts/build-catalog.ts';
import { portReport } from '../scripts/report-ported.ts';
import { eligibleEntries, loadCatalog } from '../src/index.ts';
import { catalogIssues, catalogSchema, validateAgainstSchema, validateComponentMeta } from '../src/validate.ts';
import type { Catalog } from '../src/types.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');
const raw = JSON.parse(readFileSync(path.join(packageRoot, 'catalog.json'), 'utf8')) as Catalog;

/** RFC 4180 rows of a CSV file: quoted fields may hold commas, quotes ("") and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** The seed's id rule: kebab-case of the CSV Component name. */
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

describe('catalog.json', () => {
  it('validates against schema/catalog.schema.json', () => {
    expect(catalogIssues(raw)).toEqual([]);
    expect(loadCatalog().components).toHaveLength(raw.components.length);
  });

  it('has one entry per seed row, preserving the 57 CSV rows and seed order', () => {
    expect(readCsvSeed()).toHaveLength(57);
    expect(raw.components).toHaveLength(readSeed().length);
    expect(raw.components.map((entry) => entry.id)).toEqual(readSeed().map((row) => row.id));
  });

  it('records Cult UI Pro rows as licensed ports and the harvest as clean-room', () => {
    const cult = raw.components.filter((entry) => entry.source.name === 'cult-ui-pro');
    expect(cult.length).toBeGreaterThan(0);
    for (const entry of cult) {
      expect(entry.source.name, entry.id).toBe('cult-ui-pro');
      expect(entry.licenceDecision, entry.id).toBe('licensed');
      expect(entry.source.license, entry.id).toContain('docs/legal/cult-ui-pro-rights.md');
      expect(entry.sourceUrl, entry.id).toMatch(/^https:\/\/pro\.cult-ui\.com\/api\/registry\/[a-z0-9-]+$/);
    }
    expect(raw.components.filter((e) => e.licenceDecision === 'licensed').length).toBe(cult.length);
    const harvest = JSON.parse(readFileSync(path.join(packageRoot, 'data/harvest-seed.json'), 'utf8')) as { components: Array<{ id: string }> };
    for (const { id } of harvest.components) {
      const entry = raw.components.find((candidate) => candidate.id === id)!;
      expect(entry.licenceDecision).toBe('clean-room');
      expect(entry.status).toBe('ported');
      expect(entry.source.license).toContain('not assessed');
    }
  });

  it('matches the committed source CSV snapshot row for row: 57 rows, ids and License verbatim', () => {
    const [header, ...rows] = parseCsv(readFileSync(path.join(packageRoot, 'data/source-csv-snapshot.csv'), 'utf8'));
    const column = (name: string): number => {
      const index = header!.indexOf(name);
      expect(index, `CSV column ${name}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const [component, license, what, dependencies, category] = ['Component', 'License', 'What it does', 'Dependencies', 'Category'].map(column);
    expect(rows).toHaveLength(57);
    expect(readCsvSeed()).toHaveLength(rows.length);
    rows.forEach((row, index) => {
      const entry = raw.components[index]!;
      expect(row, `CSV row ${index + 2}`).toHaveLength(header!.length);
      expect(entry.id, `row ${index + 2}`).toBe(kebab(row[component!]!));
      expect(entry.source.component).toBe(row[component!]);
      expect(entry.source.license, `${entry.id} License`).toBe(row[license!]);
      expect(entry.source.description).toBe(row[what!]);
      expect(entry.source.dependencies).toBe(row[dependencies!]);
      expect(entry.source.category).toBe(row[category!]);
    });
  });

  it('records id, sourceUrl, verbatim licence evidence, verdict, rationale and licence decision on every row', () => {
    const seed = new Map(readSeed().map((row) => [row.id, row]));
    for (const entry of raw.components) {
      expect(entry.id).not.toBe('');
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
      expect(entry.source.license).toBe(seed.get(entry.id)?.source.License);
      expect(entry.verdict).not.toBe('');
      expect(entry.licenceDecision).not.toBe('');
      expect(entry.rationale).not.toBe('');
    }
  });

  it('is up to date with the seed and every meta.json', async () => {
    expect(serialiseCatalog(await buildCatalog())).toBe(readFileSync(path.join(packageRoot, 'catalog.json'), 'utf8'));
  });

  it('has the files of every ported component on disk', () => {
    for (const entry of raw.components.filter((candidate) => candidate.status === 'ported')) {
      for (const file of [entry.entry, entry.css, entry.demo]) {
        expect(file, `${entry.id} lists every file`).toBeTruthy();
        expect(existsSync(path.join(packageRoot, file!)), `${entry.id}: ${file}`).toBe(true);
      }
    }
  });

  it('reports eligible = keep and not cut', () => {
    const report = portReport(raw);
    expect(report.eligible).toBe(eligibleEntries(raw).length);
    expect(report.eligible).toBe(raw.components.filter((e) => e.verdict === 'keep' && e.licenceDecision !== 'cut').length);
    expect(report.ported + report.missing.length).toBe(report.eligible);
  });
});

describe('validator', () => {
  // A seed-only entry (planned, no meta.json fields), whichever components are ported by now.
  const entry = raw.components.find((candidate) => candidate.status === 'planned' && candidate.entry === undefined)!;

  it('rejects an unknown category, a missing field and an extra property', () => {
    const bad = { ...raw, components: [{ ...entry, category: 'widget', extra: 1 }] };
    const issues = catalogIssues(bad).map((issue) => issue.message);
    expect(issues.some((message) => message.includes('expected one of'))).toBe(true);
    expect(issues).toContain('unknown property "extra"');
    const { verdict: _verdict, ...withoutVerdict } = entry;
    expect(catalogIssues({ ...raw, components: [withoutVerdict] }).map((i) => i.message)).toContain('missing required property "verdict"');
  });

  it('requires the files, bytes and props of a ported entry', () => {
    const issues = catalogIssues({ ...raw, components: [{ ...entry, status: 'ported' }] }).map((i) => i.message);
    for (const key of ['entry', 'css', 'demo', 'bytes', 'props']) expect(issues).toContain(`missing required property "${key}"`);
  });

  it('rejects duplicate ids and a ported entry whose licence decision is cut', () => {
    expect(catalogIssues({ ...raw, components: [entry, entry] }).map((i) => i.message)).toContain(`duplicate id "${entry.id}"`);
    const cut = {
      ...entry, status: 'ported', licenceDecision: 'cut', kind: 'css-only',
      entry: `components/${entry.id}/index.ts`, css: `components/${entry.id}/styles.css`, demo: `components/${entry.id}/demo.html`,
      bytes: { js: 1, css: 1 }, props: { type: 'object', properties: {} }, a11y: [], reducedMotion: 'static',
    };
    expect(catalogIssues({ ...raw, components: [cut] }).some((i) => i.message.includes('licenceDecision is cut'))).toBe(true);
  });

  it('rejects a ported entry whose measured bytes exceed the 8192 B JS / 6144 B CSS budget (B1)', () => {
    const overBudget = {
      ...entry, status: 'ported', licenceDecision: 'clean-room', kind: 'css-only',
      entry: `components/${entry.id}/index.ts`, css: `components/${entry.id}/styles.css`, demo: `components/${entry.id}/demo.html`,
      bytes: { js: 8193, css: 6145 }, props: { type: 'object', properties: {} }, a11y: [], reducedMotion: 'static',
    };
    const messages = catalogIssues({ ...raw, components: [overBudget] }).map((i) => i.message);
    expect(messages).toContain('8193 B of JS exceeds the 8192 B budget');
    expect(messages).toContain('6145 B of CSS exceeds the 6144 B budget');

    const withinBudget = { ...overBudget, bytes: { js: 8192, css: 6144 } };
    expect(catalogIssues({ ...raw, components: [withinBudget] })).toEqual([]);
  });

  it('throws on a schema keyword it does not implement', () => {
    expect(() => validateAgainstSchema(1, { oneOf: [] }, catalogSchema)).toThrow(/Unsupported JSON Schema keyword/);
  });

  it('accepts the template meta.json', () => {
    const meta = JSON.parse(readFileSync(path.join(packageRoot, 'components/_template/meta.json'), 'utf8'));
    expect(validateComponentMeta(meta).id).toBe('glare-hover');
  });
});
