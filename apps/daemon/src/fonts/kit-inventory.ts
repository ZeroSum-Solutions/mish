import { FONT_KIT_REASONS, type FontKitDeclaration, type FontKitInventory, type ResourceCandidate } from '@open-design/contracts';
import { familyKey, type FontKitLoading, type KitFontDeclaration, type KitFontScan } from './kit-scan.js';

/**
 * AC-R11 preamble: map each kit/example-declared family to admitted local bytes where
 * they exist (by the kit's own self-hosted bytes first, then by family identity), and
 * otherwise flag it as undeclared with a named reason. A family is never substituted:
 * a declaration only ever resolves to its own family or to its own bytes.
 */
const SYSTEM_FONTS = new Set([
  'arial', 'arial black', 'arial narrow', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'courier', 'courier new', 'segoe ui', 'segoe ui emoji', 'segoe ui symbol', 'segoe ui variable', 'apple color emoji', '-apple-system', 'blinkmacsystemfont',
  'sf pro', 'sf pro display', 'sf pro text', 'sf pro rounded', 'sf mono', 'sfmono-regular', 'new york', 'menlo', 'monaco', 'consolas', 'liberation mono', 'liberation sans',
  'liberation serif', 'dejavu sans', 'dejavu sans mono', 'dejavu serif', 'lucida grande', 'lucida console', 'lucida sans unicode', 'palatino', 'palatino linotype',
  'book antiqua', 'garamond', 'baskerville', 'didot', 'optima', 'futura', 'gill sans', 'avenir', 'avenir next', 'hoefler text', 'iowan old style', 'charter',
  'bitstream charter', 'cambria', 'calibri', 'candara', 'constantia', 'corbel', 'franklin gothic medium', 'impact', 'comic sans ms', 'american typewriter', 'andale mono',
  'pingfang sc', 'hiragino sans', 'hiragino kaku gothic pro', 'microsoft yahei', 'yu gothic', 'meiryo', 'ms gothic', 'oxygen-sans', 'droid sans', 'droid sans mono', 'noto sans cjk sc',
]);
const LOADING_PHRASE: Record<FontKitLoading, string> = {
  'local-font-face': 'loads it from its own files', 'google-fonts-css': 'loads it from Google Fonts CSS', 'fontshare-css': 'loads it from Fontshare CSS', 'other-remote': 'loads it from a remote host', none: 'names it without loading it (installed fonts only)',
};
/** Files listed per declaration; `fileCount` keeps the full count. */
const FILES_SHOWN = 5;
const loadingPhrase = (loading: ReadonlySet<FontKitLoading>) => [...loading].map(entry => LOADING_PHRASE[entry]).join(' and ');
const isAvailable = (file: { state: string }) => file.state === 'available';

/** A kit alias (an @font-face name over admitted bytes) and the kit that defines it. */
interface KitAlias { owner: ResourceCandidate; shas: string[]; kit: string }

function resolve(declaration: KitFontDeclaration, byTitle: Map<string, ResourceCandidate>, bySha: Map<string, ResourceCandidate>, aliases: ReadonlyMap<string, KitAlias | null>): FontKitDeclaration {
  const base = {
    root: declaration.root, kit: declaration.kit, family: declaration.family.slice(0, 200), files: declaration.files.slice(0, FILES_SHOWN), fileCount: declaration.files.length,
    loading: [...declaration.loading], remoteHosts: [...declaration.remoteHosts].slice(0, 10),
  };
  const faceShas = declaration.faces.filter((sha): sha is string => sha !== null);
  const kitBytes = faceShas.length ? faceShas.some(sha => bySha.has(sha)) : null;
  const undeclared = (reason: typeof FONT_KIT_REASONS[number], message: string, item: ResourceCandidate | null): FontKitDeclaration =>
    ({ ...base, state: 'undeclared', reason, message, catalogueItemId: item?.ref.itemId ?? null, admittedFiles: [], kitBytesAdmitted: kitBytes });
  // 1. The kit self-hosts bytes that are admitted local files: map by digest (aliases included).
  const ownMatches = [...new Set(faceShas.filter(sha => bySha.has(sha)))];
  if (ownMatches.length) {
    const owner = bySha.get(ownMatches[0]!)!;
    return { ...base, state: 'mapped', reason: null, message: `${declaration.family} self-hosts admitted ${owner.title} bytes (${ownMatches.length} file${ownMatches.length === 1 ? '' : 's'}).`, catalogueItemId: owner.ref.itemId, admittedFiles: ownMatches.slice(0, 64), kitBytesAdmitted: true };
  }
  // 2. The family itself is a catalogued font: map to its admitted files, or say why there are none.
  const item = byTitle.get(declaration.key);
  if (item) {
    const licence = item.fontProfile?.licence.type ?? 'unknown';
    if (item.rightsStatus === 'restricted') return undeclared('rights-restricted', `${item.title} is ${licence}: its bytes are restricted, so nothing is admitted or served.`, item);
    const admitted = (item.fontProfile?.localFiles ?? []).filter(isAvailable).map(file => file.sha256);
    if (admitted.length) {
      return { ...base, state: 'mapped', reason: null, message: `${declaration.family} maps to ${admitted.length} admitted local file${admitted.length === 1 ? '' : 's'} of ${item.title}; the kit ${loadingPhrase(declaration.loading)}.`, catalogueItemId: item.ref.itemId, admittedFiles: admitted.slice(0, 64), kitBytesAdmitted: kitBytes };
    }
    if (item.rightsStatus === 'unknown') return undeclared('licence-unknown', `${item.title}'s licence (${licence}) is not recognised, so it stays reference-only and no local file is admitted.`, item);
    return undeclared('no-admitted-local-file', `${item.title} is listed (${licence}) but no local file is admitted; the kit ${loadingPhrase(declaration.loading)}.`, item);
  }
  if (faceShas.length) return undeclared('kit-bytes-not-admitted', `${declaration.family} self-hosts font bytes that are not admitted local files.`, null);
  // 3. A kit alias another bundled kit defines over admitted bytes is that alias, not a substitute.
  const alias = aliases.get(declaration.key);
  if (alias && !declaration.localAlias) {
    return { ...base, state: 'mapped', reason: null, message: `${declaration.family} is the ${alias.kit} alias of admitted ${alias.owner.title} bytes; this kit ${loadingPhrase(declaration.loading)}.`, catalogueItemId: alias.owner.ref.itemId, admittedFiles: alias.shas.slice(0, 64), kitBytesAdmitted: kitBytes };
  }
  if (declaration.localAlias) return undeclared('system-font', `${declaration.family} is an @font-face alias over installed platform fonts (local()); it is never admitted or redistributed.`, null);
  if (SYSTEM_FONTS.has(declaration.key)) return undeclared('system-font', `${declaration.family} is a platform font; it is never admitted or redistributed.`, null);
  return undeclared('not-in-catalogue', `${declaration.family} is not in any pinned font source; the kit ${loadingPhrase(declaration.loading)}.`, null);
}

/** Joins a kit scan with the current fonts-source items (and their verified local-file states). */
export function buildFontKitInventory(scan: KitFontScan, items: readonly ResourceCandidate[]): FontKitInventory {
  const byTitle = new Map<string, ResourceCandidate>();
  const bySha = new Map<string, ResourceCandidate>();
  for (const item of items) {
    if (!item.fontProfile) continue;
    // The first item with a title wins: curated and merged families precede source-only duplicates.
    const key = familyKey(item.title);
    if (!byTitle.has(key)) byTitle.set(key, item);
    if (item.rightsStatus === 'restricted') continue;
    for (const file of item.fontProfile.localFiles) if (isAvailable(file) && !bySha.has(file.sha256)) bySha.set(file.sha256, item);
  }
  // Aliases a kit defines over admitted bytes; an alias name two kits define differently is ambiguous (null).
  const aliases = new Map<string, KitAlias | null>();
  for (const declaration of scan.declarations) {
    if (byTitle.has(declaration.key)) continue;
    const shas = [...new Set(declaration.faces.filter((sha): sha is string => sha !== null && bySha.has(sha)))];
    if (!shas.length) continue;
    const owner = bySha.get(shas[0]!)!;
    const known = aliases.get(declaration.key);
    if (known === undefined) aliases.set(declaration.key, { owner, shas, kit: declaration.kit });
    else if (known && known.owner.ref.itemId === owner.ref.itemId) known.shas = [...new Set([...known.shas, ...shas])];
    else aliases.set(declaration.key, null);
  }
  const declarations = scan.declarations.slice(0, 4000).map(declaration => resolve(declaration, byTitle, bySha, aliases));
  const byReason = Object.fromEntries(FONT_KIT_REASONS.map(reason => [reason, declarations.filter(entry => entry.reason === reason).length])) as FontKitInventory['counts']['byReason'];
  return {
    schema: 'font-kit-inventory/1',
    scanned: { roots: scan.roots, kits: scan.kits, files: scan.files, truncated: scan.truncated || scan.declarations.length > 4000 },
    declarations,
    counts: { mapped: declarations.filter(entry => entry.state === 'mapped').length, undeclared: declarations.filter(entry => entry.state === 'undeclared').length, byReason },
  };
}
