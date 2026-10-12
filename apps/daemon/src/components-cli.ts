import { parseComponentLedger, parseComponentLedgerReport } from '@mish/contracts';
import ledgerJson from './workbench/component-ledger.json' with { type: 'json' };
import { buildComponentLedgerReport } from './workbench/component-ledger-report.js';
import { isLoopbackHostname } from './http/local-daemon-request.js';
import { runWorkbenchCli, type WorkbenchCliOptions } from './workbench-cli.js';

export const COMPONENTS_USAGE = 'Usage: od components ledger [--json] [--core-only] [--daemon-url <url>]';
export async function runComponentsCli(args: string[], options: {
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });
  if (args.includes('--help') || args.includes('-h')) return out(0, `${COMPONENTS_USAGE}\n`);
  let daemonUrl: string | undefined;
  const flags = new Set<string>();
  if (args[0] !== 'ledger') return out(2, '', `${COMPONENTS_USAGE}\n`);
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--daemon-url' && args[index + 1] && !args[index + 1]!.startsWith('-')) daemonUrl = args[++index];
    else if (flag === '--json' || flag === '--core-only') flags.add(flag);
    else return out(2, '', `${COMPONENTS_USAGE}\n`);
  }
  try {
    let report;
    if (flags.has('--core-only')) report = buildComponentLedgerReport(parseComponentLedger(ledgerJson));
    else {
      const base = await options.resolveBaseUrl(daemonUrl);
      const url = new URL('/api/components/ledger', base);
      if (!isLoopbackHostname(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return out(2, '', 'Component ledger requires a local daemon URL.\n');
      }
      const response = await (options.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok) return out(1, '', `Component ledger request failed (${response.status})\n`);
      report = parseComponentLedgerReport(await response.json());
    }
    const stdout = flags.has('--json') ? JSON.stringify(report, null, 2) : Object.values(report.components)
      .map(row => [
        row.id, row.source,
        row.source === 'pack' ? row.rights.license : row.licensed ? 'licensed' : row.rights.license,
        row.built ? 'built' : 'tracked', row.installed === true ? 'installed' : 'core',
        row.verified ? `verified ${row.evidenceDate}` : 'unverified',
        row.errors.map(error => `${error.code} (${error.packId})`).join('; '),
      ].join('\t')).join('\n');
    return out(0, `${stdout}\n`);
  } catch {
    return out(1, '', 'Component ledger unavailable. Start the daemon or use --core-only for the public-core inventory.\n');
  }
}

export const COMPONENTS_SEARCH_HELP = 'od components rank|list --kit <id> [--kit-source <source>] [--project <id>] [--show-all] [--context on|off] [--prompt-file <path|->] [--limit <n>] [--cursor <cursor>] [--daemon-url <url>] [--workspace <id> --workspace-member <id>] --json';
/** The existing workbench transport and authority; one HTTP ranking contract for every surface. */
export async function runComponentsSearchCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? (value => console.log(typeof value === 'string' ? value : JSON.stringify(value)));
  if (!args.length || args.includes('--help') || args[0] === 'help') { write(COMPONENTS_SEARCH_HELP); return 0; }
  const [mode, ...rest] = args;
  if (mode !== 'rank' && mode !== 'list') { write({ error: { code: 'invalid-cli-input', message: COMPONENTS_SEARCH_HELP } }); return 2; }
  if (!rest.includes('--kit')) { write({ error: { code: 'invalid-cli-input', message: '--kit is required' } }); return 2; }
  return runWorkbenchCli(['search', ...rest], { ...options, componentsMode: mode });
}
