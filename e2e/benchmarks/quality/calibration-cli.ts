import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { assertPrivateOutput } from './calibration-privacy.ts';
import { renderBlindSheet } from './calibration-sheet.ts';
import { validateCalibrationSet, freezeCalibration, type CalibrationResolution } from './calibration-session.ts';
import { judgeCalibration, verifyCalibrationEvidence, verifyCompletedCalibration } from './calibration-judge.ts';
import { writeJsonAtomic } from './storage.ts';
const help = 'Usage: calibration-cli.ts sheet --set FILE --out HTML [--image-base PREFIX] | judge --set FILE --evidence-root DIR --human FILE (repeatable) --out NEW_DIR [--stub] | freeze --out SESSION_DIR --review JSON';
const load = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { set: { type: 'string' }, out: { type: 'string' }, human: { type: 'string', multiple: true }, 'evidence-root': { type: 'string' }, 'image-base': { type: 'string', default: '' }, review: { type: 'string' }, stub: { type: 'boolean' }, 'timeout-ms': { type: 'string', default: '600000' }, help: { type: 'boolean' } } });
  if (v.help) { console.log(help); return; }
  if (positionals.length !== 1 || !v.out) throw new Error(help);
  const out = resolve(v.out);
  await assertPrivateOutput(out);
  if (positionals[0] === 'freeze') {
    if (!v.review) throw new Error('Freeze requires explicit reviewed dispositions');
    const { set, model, report } = await verifyCompletedCalibration(out);
    const frozen = freezeCalibration(set, model, report, await load(resolve(v.review)) as CalibrationResolution);
    await writeJsonAtomic(join(out, 'calibration-freeze.json'), frozen, true);
    console.log('Saved immutable calibration-freeze.json. Grades remain advisory.'); return;
  }
  if (!v.set) throw new Error(help);
  const set = validateCalibrationSet(await load(resolve(v.set)));
  const evidenceRoot = resolve(v['evidence-root'] ?? dirname(resolve(v.set)));
  if (positionals[0] === 'sheet') {
    await verifyCalibrationEvidence(evidenceRoot, set);
    await writeFile(out, renderBlindSheet(set, v['image-base']), { flag: 'wx', mode: 0o600 });
    console.log(`Saved ${set.items.length} blind pages; no judges run.`); return;
  }
  if (positionals[0] !== 'judge' || !v.human?.length) throw new Error('Judge requires explicit --human submitted JSON before any model call');
  const human = await Promise.all(v.human.map(file => load(resolve(file))));
  const result = await judgeCalibration({ set, human, evidenceRoot, out, stub: !!v.stub, timeoutMs: Number(v['timeout-ms']) });
  console.log(`Saved ${result.model.mode} calibration report. Two-letter gaps: ${result.agreement.investigationRequired}. No draft is accepted.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Calibration failed'); process.exitCode = 1; });
