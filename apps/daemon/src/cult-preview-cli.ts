/**
 * `od cult preview <slug> [--theme light|dark] [--html] [--json]` — the CLI side of the Catalog
 * tab's live preview modal. It reads the same routes the modal does:
 *
 *   GET /api/cult/preview/:id          whether the row previews live, how, and why not
 *   GET /api/cult/preview/:id/frame    the page the modal frames (with --html)
 *
 * Without --html it prints `Key\tValue` lines: Id, Live, Mode, Dark theme, and the frame URL (open
 * it in a browser on this machine; the response's CSP sandboxes it in an opaque origin) or the
 * reason it cannot preview live. A row that needed the harness's deterministic mocks (a secret env
 * var or a key-bound server SDK anywhere in its kit directory) still previews live and adds a
 * `Demo data` line naming why, instead of refusing. With --html it prints the frame page itself.
 * Both routes answer this machine only. `cli.ts` owns the process effects through the same result
 * shape as `od cult add|show`.
 */

import { cultPreviewFrameUrl, cultPreviewInfoUrl, parseCultPreviewInfoResponse, type CultPreviewTheme } from '@mish/contracts';

import type { CultAddCliOptions, CultAddCliResult } from './cult-add-cli.js';

export const CULT_PREVIEW_USAGE = 'Usage: od cult preview <slug> [--theme light|dark] [--html] [--json]';

const ID = /^(?:cult:)?([a-z0-9][a-z0-9-]{0,127})$/;

/** Daemon text on one tab-safe line. */
function field(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function runCultPreviewCli(args: string[], options: Pick<CultAddCliOptions, 'resolveBaseUrl' | 'fetchImpl'>): Promise<CultAddCliResult> {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help', code: 0 };
  let json = false;
  let html = false;
  let theme: CultPreviewTheme = 'light';
  let daemonUrl: string | undefined;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === '--json') json = true;
    else if (name === '--html') html = true;
    else if (name === '--theme' || name === '--daemon-url') {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (!value) return { kind: 'usage', stderr: [`${name} needs a value`, CULT_PREVIEW_USAGE] };
      if (name === '--daemon-url') daemonUrl = value;
      else if (value === 'light' || value === 'dark') theme = value;
      else return { kind: 'usage', stderr: ['--theme must be light or dark', CULT_PREVIEW_USAGE] };
    } else if (arg.startsWith('-')) return { kind: 'usage', stderr: [`unknown flag: ${arg}`, CULT_PREVIEW_USAGE] };
    else ids.push(arg);
  }
  if (ids.length !== 1) return { kind: 'usage', stderr: [CULT_PREVIEW_USAGE] };
  const match = ID.exec(ids[0]!);
  if (!match) return { kind: 'usage', stderr: [`not a catalog id: ${ids[0]}`] };
  const id = `cult:${match[1]}`;
  const base = (await options.resolveBaseUrl(daemonUrl)).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(`${base}${cultPreviewInfoUrl(id)}`);
  if (!response.ok) return { kind: 'http-failure', response };
  let info;
  try {
    info = parseCultPreviewInfoResponse(await response.json()).preview;
  } catch (err) {
    return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] malformed response from /api/cult/preview: ${(err as Error).message}`] };
  }
  const frameUrl = `${base}${cultPreviewFrameUrl(id, theme)}`;

  if (html) {
    if (!info.live) return { kind: 'done', code: 1, stdout: '', stderr: [`[cult] can't preview live: ${field(info.reason)}`] };
    const frame = await fetchImpl(frameUrl);
    if (!frame.ok) return { kind: 'http-failure', response: frame };
    return { kind: 'done', code: 0, stdout: await frame.text(), stderr: [] };
  }
  if (json) {
    const body = info.live ? { preview: info, frameUrl } : { preview: info };
    return { kind: 'done', code: 0, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: [] };
  }
  const lines = [`Id\t${id}`, `Live\t${info.live ? 'yes' : 'no'}`, `Mode\t${info.mode}`];
  if (info.live) {
    lines.push(`Dark theme\t${info.supportsDark ? 'yes' : 'no'}`, `Frame\t${frameUrl}`);
    if (info.mockNote) lines.push(`Demo data\t${field(info.mockNote)}`);
  } else {
    lines.push(`Reason\tcan't preview live: ${field(info.reason)}`);
  }
  return { kind: 'done', code: 0, stdout: `${lines.join('\n')}\n`, stderr: [] };
}
