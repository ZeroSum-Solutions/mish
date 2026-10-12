import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDesignBriefPreview } from '@mish/contracts';
import { digest, type client } from './api.ts';
import type { BriefCase } from './types.ts';

/** `original` builds from the case request alone; every other writer is an Improve prompt lane. */
export const ORIGINAL = 'original';
/** Arm and writer names: safe as path segments, and never an outcome label or a build-mode prefix. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export function assertWriterName(name: string) {
  if (!NAME.test(name) || ['tie', 'unsettled'].includes(name) || /^(baseline|current)-/u.test(name)) throw new Error(`Invalid writer or arm name: ${JSON.stringify(name)}`);
}

/** A compare writer: its label in the report, and the daemon lane that writes its briefs (`label=lane`, or the label itself). */
export interface WriterSpec { label: string; lane: string }
export function parseWriters(specs: string[]): WriterSpec[] {
  const writers = specs.map(spec => { const [label = '', lane = label] = spec.split('='); return { label: label.trim(), lane: lane.trim() }; });
  for (const w of writers) { assertWriterName(w.label); assertWriterName(w.lane); if (w.label === ORIGINAL && w.lane !== ORIGINAL) throw new Error('original takes no lane'); }
  if (new Set(writers.map(w => w.label)).size !== writers.length) throw new Error('Writer labels must be distinct');
  return writers;
}

export interface BriefRecord {
  caseId: string; writer: string; lane: string; source: 'generated' | 'frozen';
  /** SHA-256 of the canonical preview JSON; arm packets record the same digest per case. */
  sha256: string;
  /**
   * Generated briefs only: wall time of the preview call. The preview response does not say which
   * model wrote the brief, so a lane that fell back to Claude is not visible here; the daemon log
   * (`[brief] … fell back`) is the only record.
   */
  transformMs: number | null;
}

/** A brief must be a valid preview the attach route will accept; `null` or a stray value never builds as "original". */
function validPreview(value: unknown, where: string): unknown {
  try { return parseDesignBriefPreview(value); } catch { throw new Error(`Invalid brief preview: ${where}`); }
}

/** Lanes this daemon offers: `claude`/`terra` on main, plus any `options[].lane` a newer status lists. */
export async function availableLanes(api: ReturnType<typeof client>): Promise<string[]> {
  const body = await api.json('/api/workbench/briefs/transformer') as { status?: { options?: Array<{ lane?: unknown; available?: unknown }> } };
  const options = body.status?.options;
  if (Array.isArray(options)) return options.filter(option => option.available !== false).map(option => String(option.lane)).filter(lane => NAME.test(lane));
  return ['claude', 'terra'];
}

const previewPath = (dir: string, caseId: string, writer: string) => join(dir, caseId, `${writer}.preview.json`);

/**
 * One brief per case and writer. With `frozenDir`, briefs are read from `<case>/<label>.preview.json`
 * there and no writer is called, so reruns compare designs rather than brief noise. Otherwise each
 * writer's lane is selected through `PUT /api/app-config` (an isolated runtime's global setting) and
 * `POST /api/workbench/briefs/preview` writes the brief. The saved setting is restored afterwards,
 * also on SIGINT/SIGTERM, and `writer-setting.json` records whether that happened. Every brief is
 * validated and saved under `out/briefs`, so this run can itself be frozen.
 */
export async function prepareBriefs(api: ReturnType<typeof client>, cases: BriefCase[], writers: WriterSpec[], out: string, frozenDir?: string, hooks: { kill?: (signal: NodeJS.Signals) => void; signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'> } = {}) {
  const lanes = writers.filter(writer => writer.label !== ORIGINAL);
  const previews = new Map<string, unknown>();
  const records: BriefRecord[] = [];
  const save = async (item: BriefCase, writer: WriterSpec, preview: unknown, record: Pick<BriefRecord, 'source' | 'transformMs'>) => {
    const sha256 = digest(JSON.stringify(preview));
    await mkdir(join(out, 'briefs', item.id), { recursive: true });
    await writeFile(previewPath(join(out, 'briefs'), item.id, writer.label), JSON.stringify(preview, null, 2), { flag: 'wx' });
    previews.set(`${item.id}/${writer.label}`, preview);
    records.push({ caseId: item.id, writer: writer.label, lane: writer.lane, sha256, ...record });
  };
  if (frozenDir) {
    for (const item of cases) for (const writer of lanes) {
      const preview = validPreview(JSON.parse(await readFile(previewPath(frozenDir, item.id, writer.label), 'utf8')), `${item.id}/${writer.label}`);
      await save(item, writer, preview, { source: 'frozen', transformMs: null });
    }
    return { previews, records };
  }
  if (!lanes.length) return { previews, records };
  const offered = await availableLanes(api);
  const missing = [...new Set(lanes.map(w => w.lane))].filter(lane => !offered.includes(lane));
  if (missing.length) throw new Error(`This daemon does not offer writer lane(s): ${missing.join(', ')}; it offers ${offered.join(', ')}`);
  const config = await api.json('/api/app-config') as { config?: Record<string, unknown> } & Record<string, unknown>;
  const saved = (config.config ?? config).improvePromptTransformer ?? null;
  const receipt = join(out, 'writer-setting.json');
  await writeFile(receipt, JSON.stringify({ saved, restored: false }, null, 2));
  // On SIGINT/SIGTERM the loop stops before its next step, the step in flight finishes, and only
  // then is the setting restored, so a late PUT can never land after the restore.
  let stopped: NodeJS.Signals | undefined;
  let current: Promise<unknown> = Promise.resolve();
  const step = <T>(work: () => Promise<T>): Promise<T> => {
    if (stopped) throw new Error(`Interrupted by ${stopped}`);
    const running = work(); current = running.catch(() => undefined); return running;
  };
  const restore = async () => {
    await current;
    await api.put('/api/app-config', { improvePromptTransformer: saved });
    await writeFile(receipt, JSON.stringify({ saved, restored: true }, null, 2));
  };
  let restoring: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals) => { stopped = signal; restoring ??= restore(); void restoring.finally(() => (hooks.kill ?? (s => process.kill(process.pid, s)))(signal)); };
  const signals = hooks.signals ?? process;
  signals.once('SIGINT', onSignal); signals.once('SIGTERM', onSignal);
  try {
    for (const writer of lanes) {
      await step(() => api.put('/api/app-config', { improvePromptTransformer: writer.lane }));
      for (const item of cases) {
        const started = performance.now();
        const preview = validPreview(await step(() => api.json('/api/workbench/briefs/preview', undefined, { originalText: item.brief })), `${item.id}/${writer.label}`);
        await save(item, writer, preview, { source: 'generated', transformMs: Math.round(performance.now() - started) });
      }
    }
  } finally {
    signals.off('SIGINT', onSignal); signals.off('SIGTERM', onSignal);
    await (restoring ??= restore());
  }
  return { previews, records };
}

/** Briefs a previous run of this output saved, checked against the digests it recorded (resume). */
export async function loadSavedBriefs(out: string, records: BriefRecord[]) {
  const previews = new Map<string, unknown>();
  for (const record of records) {
    const preview = validPreview(JSON.parse(await readFile(previewPath(join(out, 'briefs'), record.caseId, record.writer), 'utf8')), `${record.caseId}/${record.writer}`);
    if (digest(JSON.stringify(preview)) !== record.sha256) throw new Error(`Saved brief changed: ${record.caseId}/${record.writer}`);
    previews.set(`${record.caseId}/${record.writer}`, preview);
  }
  return previews;
}
