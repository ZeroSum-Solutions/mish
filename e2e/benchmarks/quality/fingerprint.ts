import { digest, type client } from './api.ts';
import { CAPTURE_SETTINGS } from './settings.ts';
import type { BenchmarkRun, BuilderIdentity, CaseRun, CaseFingerprint, FileReceipt, Identity } from './types.ts';
export const unavailable = (reason: string): Identity<never> => ({ status: 'unavailable', reason });
const available = <T>(value: T, source: string): Identity<T> => ({ status: 'available', value, source });
const FONT = /\.(woff2?|ttf|otf)$/iu;

/** build-on-brand keeps the pre-builder fingerprint shape, so existing packets and baselines still verify. */
export function initialFingerprint(fixtureDigest: string, builder?: BuilderIdentity): BenchmarkRun['fingerprint'] {
  const content = { fixtureDigest, captureSettings: CAPTURE_SETTINGS, cases: [], ...(builder && builder.id !== 'build-on-brand' ? { builder } : {}) };
  return { ...content, digest: digest(JSON.stringify(content)) };
}
export function fingerprintDigest(fingerprint: BenchmarkRun['fingerprint']) {
  const { digest: _digest, ...content } = fingerprint;
  return digest(JSON.stringify(content));
}
/** Public kit inventory + public static bytes; no daemon filesystem discovery. */
export async function kitFingerprint(api: ReturnType<typeof client>, kitId: string): Promise<CaseFingerprint['kit']> {
  const base = `/api/design-systems/${encodeURIComponent(kitId)}`;
  try {
    const listing = await api.json(`${base}/files`) as { files?: Array<{ path: string; kind: string }> };
    if (!Array.isArray(listing.files) || !listing.files.length) throw new Error('No public kit file inventory');
    const files: FileReceipt[] = [];
    for (const file of listing.files.filter(file => !['folder', 'directory', 'dir'].includes(file.kind)).sort((a, b) => a.path.localeCompare(b.path))) {
      if (typeof file.path !== 'string') throw new Error('Invalid public kit inventory');
      const bytes = await api.bytes(`${base}/static?path=${encodeURIComponent(file.path)}`);
      files.push({ name: file.path, bytes: bytes.length, sha256: digest(bytes) });
    }
    if (!files.length || new Set(files.map(file => file.name)).size !== files.length) throw new Error('Empty or duplicate public kit inventory');
    return { id: kitId, contentHash: available(digest(JSON.stringify(files)), 'public kit file inventory and static bytes'), files: available(files, 'public kit file inventory and static bytes') };
  } catch (error) {
    const reason = `Complete kit bytes unavailable through public APIs: ${error instanceof Error ? error.message : 'read failed'}`;
    return { id: kitId, contentHash: unavailable(reason), files: unavailable(reason) };
  }
}
export function caseFingerprint(item: CaseRun, kit: CaseFingerprint['kit']): CaseFingerprint {
  const fonts = item.files.filter(file => FONT.test(file.name));
  const assets = item.files.filter(file => !/\.html?$/iu.test(file.name));
  const metadata = item.run;
  return {
    caseId: item.caseId, kit,
    fontFiles: fonts.length ? available(fonts, 'saved project inventory; final bytes') : unavailable('No font files in saved inventory; remote and system fonts have no local file hash'),
    stagedAssets: item.files.length ? available(assets, 'saved project inventory; final non-HTML bytes, staging origin not exposed') : unavailable('Saved inventory unavailable'),
    promptVariant: metadata?.strategyRolloutDecision && typeof metadata.strategyRolloutDecision === 'object'
      ? available(JSON.stringify({ strategyRolloutDecision: metadata.strategyRolloutDecision, pluginId: metadata.pluginId ?? null, appliedPluginSnapshotId: metadata.appliedPluginSnapshotId ?? null }), 'public run strategy rollout metadata')
      : unavailable('Public run metadata does not expose the resolved prompt variant; no variant inferred from requested agent or local config'),
    builder: typeof metadata?.agentId === 'string' && typeof metadata.model === 'string'
      ? available({ agent: metadata.agentId, model: metadata.model }, 'public terminal run metadata')
      : unavailable('Public terminal run metadata lacks actual agent/model identity; requested settings are saved separately'),
    ...(item.input ? { input: { writer: item.input.writer, previewSha256: item.input.previewSha256 } } : {}),
  };
}
