/** Prebuilt licensed previews: no external harness, toolchain or writable app bundle. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { CultPreviewTheme } from '@open-design/contracts';
import type { HarnessInfo, HarnessPage } from '../cult-live-preview.js';

interface Entry { name: string; live: boolean; supportsDark?: boolean; mockNote?: string | null; reason?: string; light?: string; dark?: string }
export class BundledCultPreviews {
  private readonly entries: Map<string, Entry>;
  private readonly hashes: Map<string, string>;
  constructor(private readonly kitDir: string) {
    const manifest = JSON.parse(readFileSync(path.join(kitDir, 'manifest.json'), 'utf8'));
    const previews = JSON.parse(readFileSync(path.join(kitDir, 'previews', 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || previews.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(previews.items)) throw new Error('Invalid bundled component manifest');
    this.entries = new Map(previews.items.map((entry: Entry) => [entry.name, entry]));
    this.hashes = new Map(manifest.files.map((file: {file: string; sha256: string}) => [file.file, file.sha256]));
  }
  static installed(kitDir: string | null): boolean {
    return kitDir !== null && existsSync(path.join(kitDir, 'previews', 'manifest.json'));
  }
  async info(name: string): Promise<HarnessInfo> {
    const entry = this.entries.get(name);
    return entry?.live ? { live: true, supportsDark: entry.supportsDark === true, mockNote: entry.mockNote ?? null }
      : { live: false, reason: entry?.reason ?? 'This component has no bundled live preview.' };
  }
  async page(name: string, theme: CultPreviewTheme): Promise<HarnessPage> {
    const entry = this.entries.get(name);
    const file = theme === 'dark' ? entry?.dark : entry?.light;
    if (!entry?.live || !file) return { status: 422, reason: entry?.reason ?? 'This component has no bundled live preview.' };
    if (file !== `previews/${name}.${theme}.html.gz` || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) throw new Error('Invalid bundled preview path');
    const bytes = readFileSync(path.join(this.kitDir, file));
    if (createHash('sha256').update(bytes).digest('hex') !== this.hashes.get(file)) throw new Error('Bundled preview checksum mismatch');
    return { status: 200, html: gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8') };
  }
}
