import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

type LocalizedContentModule = {
  localizeDesignSystemCategory: (locale: string, category: string) => string;
  localizeDesignSystemSummary: (locale: string, system: DesignSystemResource) => string;
  localizeSkillDescription: (locale: string, skill: SkillResource) => string;
};

type SkillResource = { id: string; description: string };
type DesignSystemResource = { id: string; category: string; summary: string | null };

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const webContentModules = import.meta.glob<LocalizedContentModule>(
  '../../apps/web/src/i18n/content.ts',
  { eager: true },
);
const localizedContentModule = Object.values(webContentModules)[0];

if (localizedContentModule == null) {
  throw new Error('Failed to load apps/web localized content ids');
}

const {
  localizeDesignSystemCategory,
  localizeDesignSystemSummary,
  localizeSkillDescription,
} = localizedContentModule;
const COVERAGE_LOCALES = ["en"] as const;
const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return sorted(new Set(values));
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertResourceId(id: string, label: string): void {
  invariant(RESOURCE_ID_PATTERN.test(id), `${label} has malformed resource id: ${id}`);
}

async function assertDirectory(root: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    throw new Error(`${label} root is missing: ${root}`, { cause: error });
  }
  invariant(info.isDirectory(), `${label} root is not a directory: ${root}`);
}

async function readDirectoryNames(root: string): Promise<Set<string>> {
  const entries = await readdir(root, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractYamlScalar(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}:\\s*(.*?)\\s*$`);
  const keyIndex = lines.findIndex((line) => keyPattern.test(line));
  if (keyIndex === -1) return null;

  const keyLine = lines[keyIndex];
  invariant(keyLine, `YAML key ${key} is missing after lookup`);
  const rawValue = keyPattern.exec(keyLine)?.[1]?.trim() ?? '';
  invariant(
    !rawValue.startsWith('|') || /^([|])[-+]?$/.test(rawValue),
    `Skill frontmatter key ${key} has malformed block scalar marker: ${rawValue}`,
  );
  invariant(
    !rawValue.startsWith('>') || /^([>])[-+]?$/.test(rawValue),
    `Skill frontmatter key ${key} has malformed block scalar marker: ${rawValue}`,
  );
  const blockMarker = /^([|>])[-+]?$/.exec(rawValue)?.[1];
  if (blockMarker) {
    const blockLines: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
      if (/^\S/.test(line)) break;
      blockLines.push(line.replace(/^\s{2}/, ''));
    }
    const value = normalizeText(blockLines.join(blockMarker === '>' ? ' ' : '\n'));
    return value || null;
  }

  invariant(
    !rawValue.startsWith('"') || rawValue.endsWith('"'),
    `Skill frontmatter key ${key} has malformed quoted scalar`,
  );
  invariant(
    !rawValue.startsWith("'") || rawValue.endsWith("'"),
    `Skill frontmatter key ${key} has malformed quoted scalar`,
  );
  invariant(
    !rawValue.endsWith('"') || rawValue.startsWith('"'),
    `Skill frontmatter key ${key} has malformed quoted scalar`,
  );
  invariant(
    !rawValue.endsWith("'") || rawValue.startsWith("'"),
    `Skill frontmatter key ${key} has malformed quoted scalar`,
  );

  const value = unquoteYamlScalar(rawValue);
  return value ? normalizeText(value) : null;
}

function parseFrontmatter(filePath: string, src: string): string {
  const text = src.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  invariant(match?.[1], `Skill frontmatter is missing: ${filePath}`);
  return match[1];
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readSkillRootResources(rootName: 'skills' | 'design-templates'): Promise<SkillResource[]> {
  const skillsRoot = path.join(repoRoot, rootName);
  await assertDirectory(skillsRoot, rootName);

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const resources = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const filePath = path.join(skillsRoot, entry.name, 'SKILL.md');
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch (error) {
          throw new Error(`${rootName} resource is missing required file: ${filePath}`, { cause: error });
        }
        const frontmatter = parseFrontmatter(filePath, raw);
        const id = extractYamlScalar(frontmatter, 'name') ?? entry.name;
        assertResourceId(id, `${rootName} ${entry.name}`);
        const description = extractYamlScalar(frontmatter, 'description');
        invariant(
          description,
          `${rootName} ${id} is missing required English fallback field: description`,
        );
        return { id, description };
      }),
  );

  return resources.sort((a, b) => a.id.localeCompare(b.id));
}

async function readSkillResources(): Promise<SkillResource[]> {
  const [skills, designTemplates] = await Promise.all([
    readSkillRootResources('skills'),
    readSkillRootResources('design-templates'),
  ]);
  return [...skills, ...designTemplates].sort((a, b) => a.id.localeCompare(b.id));
}

async function readDesignSystemResources(): Promise<DesignSystemResource[]> {
  const systemsRoot = path.join(repoRoot, 'design-systems');
  await assertDirectory(systemsRoot, 'design systems');

  const entries = await readdir(systemsRoot, { withFileTypes: true });
  const resources = await Promise.all(
    entries
      // Skip meta-directories whose names begin with `_` (e.g. `_schema/`,
      // which holds the shared token contract — not a brand). This mirrors
      // the leading-underscore-is-meta convention used by Jekyll, Hugo,
      // SCSS partials, etc. The daemon's listDesignSystems already filters
      // these out implicitly (it requires DESIGN.md); doing the same here
      // keeps the localized-content guard aligned with the runtime registry.
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map(async (entry) => {
        assertResourceId(entry.name, `Design system directory ${entry.name}`);
        const filePath = path.join(systemsRoot, entry.name, 'DESIGN.md');
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch (error) {
          throw new Error(`Design system resource is missing required file: ${filePath}`, {
            cause: error,
          });
        }

        const category = normalizeText(/^>\s*Category:\s*(.+?)\s*$/im.exec(raw)?.[1] ?? '');
        invariant(
          category,
          `Design system ${entry.name} is missing required English fallback field: category`,
        );

        const summaryLine = raw
          .split(/\r?\n/)
          .find((line) => /^>\s*(?!Category:)(.+?)\s*$/i.test(line));
        const summary = summaryLine ? normalizeText(summaryLine.replace(/^>\s*/, '')) : null;

        invariant(
          summary || category,
          `Design system ${entry.name} is missing required English fallback field: summary or category fallback`,
        );

        return { id: entry.name, category, summary };
      }),
  );

  return resources.sort((a, b) => a.id.localeCompare(b.id));
}

describe('localized display content coverage', () => {
  it('[P2] derives displayable resources from discovered English fallback content', async () => {
    const [skills, designSystems] = await Promise.all([
      readSkillResources(),
      readDesignSystemResources(),
    ]);

    expect(uniqueSorted(skills.map((skill) => skill.id)), 'Expected discovered skills to be readable').not.toEqual([]);
    expect(
      uniqueSorted(designSystems.map((system) => system.id)),
      'Expected discovered design systems to be readable',
    ).not.toEqual([]);
    for (const locale of COVERAGE_LOCALES) {
      for (const skill of skills) {
        expect(
          normalizeText(localizeSkillDescription(locale, skill)),
          `${locale} should display a skill description for ${skill.id}`,
        ).not.toEqual('');
      }

      for (const system of designSystems) {
        expect(
          normalizeText(localizeDesignSystemSummary(locale, system)),
          `${locale} should display a design-system summary for ${system.id}`,
        ).not.toEqual('');
      }
    }
  });

  for (const locale of COVERAGE_LOCALES) {
    it(`[P2] falls back to source design-system metadata for ${locale} when dictionary entries are missing`, () => {
      const designSystem = {
        id: 'missing-design-system-translation',
        category: 'Untranslated Category',
        summary: ' English summary from source ',
      };

      expect(localizeDesignSystemCategory(locale, 'Untranslated Category')).toBe(
        'Untranslated Category',
      );
      expect(localizeDesignSystemSummary(locale, designSystem)).toBe(' English summary from source ');
    });
  }
});

describe('localized README clean-slate contract', () => {
  it('[P2] references only the shipped skill and renderable resource inventory', async () => {
    const localizedDocsRoot = path.join(repoRoot, 'docs', 'i18n');
    const readmeNames = (await readdir(localizedDocsRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }))
      .filter((name) => /^README\..+\.md$/.test(name))
      .sort((a, b) => a.localeCompare(b));
    const [designTemplates, examples] = await Promise.all([
      readDirectoryNames(path.join(repoRoot, 'design-templates')),
      readDirectoryNames(path.join(repoRoot, 'plugins', '_official', 'examples')),
    ]);
    const failures: string[] = [];

    expect(readmeNames, 'English is the only current README').toEqual([]);

    for (const readmeName of readmeNames) {
      const source = await readFile(path.join(localizedDocsRoot, readmeName), 'utf8');
      const lines = source.split(/\r?\n/);

      lines.forEach((line, index) => {
        if (/100/.test(line) && /skills?|スキル|스킬|مهار/iu.test(line)) {
          failures.push(`${readmeName}:${index + 1} advertises a stale 100+ functional-skill count`);
        }
      });

      for (const match of source.matchAll(/design-templates\/([a-z0-9][a-z0-9-]*)\//g)) {
        const id = match[1];
        invariant(id, `${readmeName} has an empty design-template reference`);
        if (!designTemplates.has(id)) {
          const line = source.slice(0, match.index).split(/\r?\n/).length;
          failures.push(`${readmeName}:${line} references absent design template ${id}`);
        }
      }

      for (const match of source.matchAll(/plugins\/_official\/examples\/([a-z0-9][a-z0-9-]*)\//g)) {
        const id = match[1];
        invariant(id, `${readmeName} has an empty example reference`);
        if (!examples.has(id)) {
          const line = source.slice(0, match.index).split(/\r?\n/).length;
          failures.push(`${readmeName}:${line} references absent bundled example ${id}`);
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
