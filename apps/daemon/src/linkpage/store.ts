/**
 * File store for saved link pages, under `<data root>/linkpages/<slug>/`. The data root is the
 * daemon's resolved, namespace-scoped `RUNTIME_DATA_DIR`, so pages never land in the repository.
 *
 *   page.json     the LinkPageRecord (spec, connected-account ids, timestamps)
 *   assets/<name> pictures that ship with the page (`assets/avatar.png` in the spec)
 *
 * Every entry point takes a slug and refuses anything but a valid slug before it builds a path, so a
 * request cannot name a file outside its own folder. Writes go to a temporary file and are renamed.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLinkPageSlug } from '@mish/contracts';
import type { LinkPageConnectedAccounts, LinkPageRecord, LinkPageSpec, LinkPageSummary } from '@mish/contracts';

export const LINKPAGES_DIRNAME = 'linkpages';
const ASSET_NAME = /^[\w.-]{1,100}$/;

export interface LinkPageAsset {
  name: string;
  bytes: Buffer;
}

export interface LinkPageStore {
  list(): Promise<LinkPageSummary[]>;
  get(slug: string): Promise<LinkPageRecord | null>;
  put(input: { spec: LinkPageSpec; connectedAccounts?: LinkPageConnectedAccounts; warnings?: string[] }): Promise<LinkPageRecord>;
  delete(slug: string): Promise<boolean>;
  assets(slug: string): Promise<LinkPageAsset[]>;
}

function assertSlug(slug: string): void {
  if (!isLinkPageSlug(slug)) throw new Error('invalid link page slug');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordShape(value: unknown): value is LinkPageRecord {
  return isRecord(value) && typeof value.slug === 'string' && isRecord(value.spec) && typeof value.updatedAt === 'string';
}

export function createLinkPageStore(dataRoot: string): LinkPageStore {
  const root = path.resolve(dataRoot, LINKPAGES_DIRNAME);

  function dirOf(slug: string): string {
    assertSlug(slug);
    const dir = path.resolve(root, slug);
    if (path.dirname(dir) !== root) throw new Error('invalid link page slug');
    return dir;
  }

  async function read(slug: string): Promise<LinkPageRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dirOf(slug), 'page.json'), 'utf8'));
      return isRecordShape(parsed) && parsed.slug === slug ? parsed : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  return {
    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const pages: LinkPageSummary[] = [];
      for (const name of names.filter(isLinkPageSlug)) {
        const record = await read(name);
        if (record) pages.push({ slug: record.slug, name: record.spec.profile.name, headline: record.spec.profile.headline, updatedAt: record.updatedAt });
      }
      return pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug));
    },

    get: read,

    async put({ spec, connectedAccounts, warnings }) {
      const dir = dirOf(spec.slug);
      const existing = await read(spec.slug);
      const now = new Date().toISOString();
      const record: LinkPageRecord = {
        slug: spec.slug,
        spec,
        connectedAccounts: connectedAccounts ?? existing?.connectedAccounts ?? {},
        warnings: warnings ?? existing?.warnings ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await mkdir(dir, { recursive: true });
      const temp = path.join(dir, `.page-${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await rename(temp, path.join(dir, 'page.json'));
      return record;
    },

    async delete(slug) {
      const dir = dirOf(slug);
      if (!(await read(slug))) return false;
      await rm(dir, { recursive: true, force: true });
      return true;
    },

    async assets(slug) {
      const dir = path.join(dirOf(slug), 'assets');
      let names: string[];
      try {
        names = await readdir(dir, { withFileTypes: true }).then((entries) => entries.filter((e) => e.isFile()).map((e) => e.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const out: LinkPageAsset[] = [];
      for (const name of names.filter((n) => ASSET_NAME.test(n)).sort()) out.push({ name, bytes: await readFile(path.join(dir, name)) });
      return out;
    },
  };
}
