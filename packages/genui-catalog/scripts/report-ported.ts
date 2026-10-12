/**
 * Print the port progress as JSON: `{ eligible, ported, missing[] }`. `eligible` counts the
 * entries with verdict keep and a licence decision other than cut; `ported` counts the eligible
 * entries whose status is ported; `missing` lists the eligible ids still planned.
 *
 *   node --experimental-strip-types scripts/report-ported.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCatalog } from '../src/validate.ts';
import type { Catalog } from '../src/types.ts';

export interface PortReport { eligible: number; ported: number; missing: string[] }

export function portReport(catalog: Catalog): PortReport {
  const eligible = catalog.components.filter((entry) => entry.verdict === 'keep' && entry.licenceDecision !== 'cut');
  const missing = eligible.filter((entry) => entry.status !== 'ported').map((entry) => entry.id);
  return { eligible: eligible.length, ported: eligible.length - missing.length, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = path.resolve(import.meta.dirname, '../catalog.json');
  const catalog = validateCatalog(JSON.parse(readFileSync(file, 'utf8')));
  console.log(JSON.stringify(portReport(catalog), null, 2));
}
