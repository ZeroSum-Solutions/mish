/**
 * R17 React95 kit record (`react95-kit/1`), generated from the exact requested
 * source archive by `tests/workbench/react95-kit-build.ts`. Every file carries
 * its git blob id (comparable with `git ls-tree` of the commit) and SHA-256.
 */
export interface React95KitFile { path: string; gitBlob: string; sha256: string; bytes: number }
export interface React95VendoredFile extends React95KitFile { text: string }

export interface React95InventoryComponent {
  /** Stable catalogue id (`window`, `menu-list`, `legacy-bar`). */
  id: string;
  name: string;
  /** The `export * from …` line of upstream `src/index.ts` this group follows. */
  exportPath: string;
  /** Upstream marks these exports deprecated. */
  legacy: boolean;
  files: React95KitFile[];
}

export interface React95Kit {
  schema: 'react95-kit/1';
  source: {
    repository: string;
    commit: string;
    /** The archive acquired once by a person; its pax header names the commit. */
    archive: { url: string; sha256: string; paxCommit: string };
    packageName: string;
    /** `0.0.0-development`: a semantic-release placeholder, not a release pin. */
    packageVersion: string;
    manifestLicense: string;
    /** What the upstream manifest links (a different repository); recorded, never substituted. */
    manifestRepository: string;
    peerDependencies: Record<string, string>;
    packageFiles: string[];
    packageJson: React95KitFile;
  };
  /** Everything the upstream package build ships, tracked per file. */
  inventory: {
    components: React95InventoryComponent[];
    /** Shipped shared modules (common helpers, hooks, types, entry points). */
    shared: React95KitFile[];
    themes: React95KitFile[];
    /** Font binaries and their notices: inventoried, never vendored. */
    fonts: React95KitFile[];
    images: React95KitFile[];
  };
  notices: {
    /** Upstream LICENSE (code). */
    code: React95VendoredFile;
    /** Per family: the FontStruct licence and readme texts, verbatim, and the font binaries they cover. */
    fonts: { family: string; licence: React95VendoredFile; readme: React95VendoredFile; files: React95KitFile[] }[];
  };
  /** Exact upstream bytes of the templates' source closure (plus src/index.ts for the inventory). */
  vendored: React95VendoredFile[];
  templates: { id: string; title: string; file: string; sha256: string; text: string; closure: string[] }[];
  /** Files authored by Mishh Mashh that every unit carries (the theme typing adapter). */
  adapters: { file: string; sha256: string; text: string }[];
  /**
   * Declared edits to vendored upstream files, relative to the exact upstream
   * text: relative import specifiers rewritten for the unit's flat layout
   * (the adoption executor writes into one existing directory), and the
   * type-only modifiers / `Buffer` read that let the unit type-check under the
   * recorded project profile. The upstream bytes stay recorded unchanged in
   * `vendored`.
   */
  patches: React95Patch[];
}

export type React95PatchReason = 'flat-layout' | 'TS1205' | 'TS1484' | 'TS2591';
export interface React95Edit { at: number; deleteCount: number; insert: string }
export interface React95Patch {
  path: string;
  upstreamSha256: string;
  patchedSha256: string;
  /** Why: `flat-layout` (import specifiers), `TS1205`/`TS1484` (type-only exports/imports), `TS2591` (the Node `Buffer` global). */
  reasons: React95PatchReason[];
  edits: React95Edit[];
}
