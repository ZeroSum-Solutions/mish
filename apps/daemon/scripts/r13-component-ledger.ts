/**
 * AC-R13.1 component ledger refresh and check.
 *
 *   pnpm exec tsx apps/daemon/scripts/r13-component-ledger.ts --check   # print gate findings, exit 1 on any
 *   pnpm exec tsx apps/daemon/scripts/r13-component-ledger.ts --write   # regenerate apps/daemon/src/workbench/component-ledger.json
 *
 * --write keeps curated fields for unchanged source versions and re-stamps frozenAt only when
 * the content changes. Review the diff: a new row starts repair-pending and owned by C1.
 */
import { writeFileSync } from 'node:fs';
import { summarizeComponentLedger } from '@mish/contracts';
import { checkComponentLedger, collectComponentInventory, componentLedgerPath, readComponentLedger, refreshComponentLedger } from '../src/workbench/component-ledger.js';

const mode = process.argv.includes('--write') ? 'write' : 'check';
const file = componentLedgerPath();
const existing = readComponentLedger(file);
const inventory = collectComponentInventory();

if (mode === 'check') {
  if (!existing) {
    console.error(`No ledger at ${file}; run with --write`);
    process.exit(1);
  }
  const findings = checkComponentLedger(existing, inventory);
  for (const finding of findings) console.log(`${finding.kind}\t${finding.id}`);
  console.log(JSON.stringify(summarizeComponentLedger(existing)));
  process.exit(findings.length ? 1 : 0);
}

const unchanged = existing ? refreshComponentLedger(existing, inventory, existing.frozenAt) : null;
const same = existing !== null && JSON.stringify(unchanged) === JSON.stringify(existing);
const ledger = same ? existing! : refreshComponentLedger(existing, inventory, new Date().toISOString());
writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`${same ? 'unchanged' : 'written'}: ${file}`);
console.log(JSON.stringify(summarizeComponentLedger(ledger)));
