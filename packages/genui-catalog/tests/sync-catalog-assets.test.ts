import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_FOLDER, DECLARATION, familyPackages, syncCatalogAssets, syncTargets } from '../scripts/sync-catalog-assets.ts';

/** Component ids present under one compiler copy's catalog folder. */
function copiedComponents(scriptsDir: string): string[] {
  const dir = path.join(scriptsDir, 'catalog/components');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Union of the ids declared by every family module a compiler copy carries. */
function declaredComponents(scriptsDir: string): string[] {
  const families = path.join(scriptsDir, 'families');
  const ids = new Set<string>();
  for (const family of readdirSync(families, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const file = path.join(families, family.name, DECLARATION);
    if (!existsSync(file)) continue;
    for (const id of (JSON.parse(readFileSync(file, 'utf8')) as { catalogComponents: string[] }).catalogComponents) ids.add(id);
  }
  return [...ids].sort();
}

describe('sync-catalog-assets --check', () => {
  it('finds every compiler copy in sync with its declarations and the HyperUI kind CSS', () => {
    const report = syncCatalogAssets({ check: true });
    expect(report.errors).toEqual([]);
    expect(report.drift).toEqual([]);
    expect(report.targets.length).toBe(familyPackages().length + 1);
    expect(report.targets).toContain('design-templates/agency-site');
  });

  it('copies exactly the components the carried families declare, and nothing else', () => {
    for (const target of syncTargets()) {
      expect(copiedComponents(target.scriptsDir), target.label).toEqual(declaredComponents(target.scriptsDir));
      for (const id of copiedComponents(target.scriptsDir)) {
        expect(readdirSync(path.join(target.scriptsDir, 'catalog/components', id)).sort(), `${target.label} ${id}`).toEqual(['auto.js', 'styles.css']);
      }
    }
  });

  it('every owned family declares, and the consumer families declare what they render', () => {
    for (const dir of familyPackages()) {
      const family = path.basename(dir).slice('agency-'.length);
      expect(existsSync(path.join(dir, 'compiler/scripts/families', family, DECLARATION)), family).toBe(true);
    }
    const byName = (name: string) => syncTargets().find((target) => target.label.endsWith(name))!;
    expect(copiedComponents(byName('agency-marketing-site').scriptsDir)).toEqual(['glare-hover', 'glass-surface', 'masked-heading', 'scroll-reveal', 'shiny-text', 'split-text']);
    // agency-watson also carries the emmpo module, whose effect placements allow two surface components.
    expect(copiedComponents(byName('agency-watson').scriptsDir)).toEqual(['glare-hover', 'scroll-reveal', 'spotlight-card']);
    // The template carries the watson and emmpo modules (the daemon imports them directly), so it needs their copies too.
    expect(copiedComponents(byName('design-templates/agency-site').scriptsDir)).toEqual(['glare-hover', 'scroll-reveal', 'spotlight-card']);
    expect(copiedComponents(byName('agency-app-shell').scriptsDir)).toEqual(['glass-surface']);
    expect(copiedComponents(byName('agency-crm-dashboard').scriptsDir)).toEqual(['glass-surface']);
  });

  it('records each copied component\'s kind, and every effect-allowed id is declared and copied', () => {
    const catalog = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../catalog.json'), 'utf8')) as { components: Array<{ id: string; kind: string }> };
    const kindOf = new Map(catalog.components.map((entry) => [entry.id, entry.kind]));
    for (const target of syncTargets()) {
      const ids = copiedComponents(target.scriptsDir);
      if (ids.length === 0) continue;
      const manifest = JSON.parse(readFileSync(path.join(target.scriptsDir, 'catalog/CATALOG.json'), 'utf8')) as { components: Record<string, { kind: string }> };
      expect(Object.keys(manifest.components), target.label).toEqual(ids);
      for (const id of ids) expect(manifest.components[id]!.kind, `${target.label} ${id}`).toBe(kindOf.get(id));
    }
    for (const dir of familyPackages()) {
      const family = path.basename(dir).slice('agency-'.length);
      const declaration = JSON.parse(readFileSync(path.join(dir, 'compiler/scripts/families', family, DECLARATION), 'utf8')) as {
        catalogComponents: string[]; effects?: { placements: Record<string, { allow: string[] }> };
      };
      for (const entry of Object.values(declaration.effects?.placements ?? {})) {
        for (const id of entry.allow) expect(declaration.catalogComponents, `${family} ${id}`).toContain(id);
      }
    }
  });

  it('gives each HyperUI kind package its own copy of the kind CSS', () => {
    for (const kind of ['app-shell', 'crm-dashboard', 'marketing-site']) {
      const dir = familyPackages().find((candidate) => path.basename(candidate) === `agency-${kind}`);
      expect(dir, kind).toBeTruthy();
      expect(existsSync(path.join(dir!, CATALOG_FOLDER, 'hyperui', `${kind}.css`))).toBe(true);
    }
  });
});
