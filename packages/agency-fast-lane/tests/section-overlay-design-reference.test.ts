/**
 * The `designReference` boundary, end to end (BLOCK 1, delta audit:
 * <private-notes>/mishh-genui-production/audits/sections-B-real-delta-deepseek.md,
 * sections-B-c-code-deepseek.md, sections-B-c-tests-deepseek.md).
 *
 * `sol-design.md` §2 requires `designReference` to reach the section's own fill prompt as
 * untrusted guidance and NOTHING ELSE: not `verify`, not `RunReport`, not a build record, not a
 * debug dir, not `onCall`. `section-overlay.test.ts` already proves the `verify`/report half at
 * the `fillSectionAdapter` level; this file is the standing proof for the WHOLE boundary, run
 * through `runFastLane` exactly as a real build would.
 *
 * Two things this file must prove precisely, not just plausibly (the re-audit's own findings):
 *   - the sentinel reaches the MODEL TRANSPORT for the section unit specifically (label
 *     `section:<adapterId>`), and no other unit's prompt ever carries it -- not merely "some"
 *     prompt among every unit this run fills;
 *   - the `--debug-dir` half exercises the REAL writer (`cli.ts`'s `createDebugDirOnCall`), not a
 *     copy of its logic -- a copy proves the copy is clean, not the writer.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDebugDirOnCall, type CliOnCall } from '../src/cli.ts';
import type { ModelCall } from '../src/deepseek.ts';
import { loadFamilyPackage } from '../src/family.ts';
import { runFastLane } from '../src/run.ts';
import { DESIGN_REFERENCE_WITHHELD_MARKER } from '../src/section-overlay.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { fakeModel, WATSON_DIR, type Filler } from './fixtures.ts';

const loadWatson = () => loadFamilyPackage(WATSON_DIR, 'watson');
const ENTRY = 'watson-r1.html';
const BRIEF = 'Watson, a design and technology studio in Los Angeles. Brand, product and motion work for ambitious teams.';
const SENTINEL = 'ZZ-DR-BOUNDARY-SENTINEL-9f3c1a-ZZ';
const SECTION_LABEL = 'section:hyperui:marketing/ctas/1';

const NULLABLE_ATOMS = ['awardCaption', 'businessEmail', 'jobsEmail', 'addressFirst', 'addressSecond', 'phone'];
const watsonFill: Filler = (key, _value, _at, limit) => (NULLABLE_ATOMS.includes(key) ? null : `New ${key} for Watson`.slice(0, limit ?? Infinity));

/** Wraps a `ModelCall` to record every request's `label` alongside its prompt, so an assertion
 * can be tied to ONE specific unit (the section fill) rather than "some" call among every unit
 * this run makes -- the re-audit's #1 finding against the prior version of this test. */
function recordingModel(base: ModelCall): ModelCall & { calls: Array<{ label: string | undefined; prompt: string }> } {
  const calls: Array<{ label: string | undefined; prompt: string }> = [];
  const wrapped = (async (request) => {
    calls.push({ label: request.label, prompt: request.user });
    return base(request);
  }) as ModelCall & { calls: typeof calls };
  wrapped.calls = calls;
  return wrapped;
}

type Save = { kind: 'page' | 'file'; name: string; content: unknown };

/** Collects every write a strict-less build makes, the same shape `AGENCY-SITE-STATE.md`, the
 * recipe and the approved-assets manifest actually go through in production -- the "build record"
 * BLOCK 1 requires the sentinel stay out of. */
function recordingPublisher(): ProjectPublisher & { saves: Save[] } {
  const saves: Save[] = [];
  return {
    projectId: 'p1',
    saves,
    async savePage(entry, html, manifest, _label) {
      saves.push({ kind: 'page', name: entry, content: { html, manifest } });
    },
    async saveFile(name, content, _encoding) {
      saves.push({ kind: 'file', name, content });
    },
    async deleteProject() {
      return 'deleted' as const;
    },
  };
}

test('designReference sentinel: reaches the model transport for the section unit only, and never onCall, RunReport, the real debug-dir writer, or a build record', async () => {
  const pkg = await loadWatson();
  const model = recordingModel(fakeModel({ fill: watsonFill }));
  const onCalls: Array<{ label: string; attempt: number; prompt: string; answer: string }> = [];
  const publisher = recordingPublisher();

  // The REAL cli.ts writer, exercised directly (BLOCK 1b) -- not a re-implementation. onCall
  // both records (for the in-memory assertions below) and forwards to the writer (for the
  // on-disk assertions), so the writer sees the exact same call sequence a real `--debug-dir`
  // build would.
  const debugDir = await mkdtemp(path.join(os.tmpdir(), 'agency-fast-lane-debug-'));
  const writeDebugFile: CliOnCall = createDebugDirOnCall(debugDir);
  const onCall: CliOnCall = (call) => {
    onCalls.push(call);
    writeDebugFile(call);
  };

  let report: Awaited<ReturnType<typeof runFastLane>>;
  try {
    report = await runFastLane({
      pkg,
      brief: BRIEF,
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model,
      modelName: 'fake',
      lockPaths: ['brand.name'],
      publisher,
      designReference: `Editorial layout, tight grid, restrained motion: ${SENTINEL}`,
      sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'watson-hero' }, directionId: 'modern-minimal' },
      onCall,
    });

    // 1. The MODEL TRANSPORT received the sentinel for the SECTION UNIT specifically, and for no
    //    other unit -- tied to the same call label throughout, not "some" prompt among all units.
    const sectionModelCalls = model.calls.filter((call) => call.label === SECTION_LABEL);
    const otherModelCalls = model.calls.filter((call) => call.label !== SECTION_LABEL);
    assert.ok(sectionModelCalls.length > 0, 'fixture assumption: the model must have been called for the section unit');
    assert.ok(sectionModelCalls.every((call) => call.prompt.includes(SENTINEL)), 'the section unit\'s own model prompt must carry the real design reference');
    assert.ok(otherModelCalls.length > 0, 'fixture assumption: other units (brand, sections, ...) must also have been filled');
    assert.ok(otherModelCalls.every((call) => !call.prompt.includes(SENTINEL)), 'no unit OTHER than the section fill may ever see the design reference');

    // 2. No onCall payload -- from ANY unit -- ever carries the sentinel; the section unit's own
    //    onCall payload carries only the withheld marker, tied to the SAME label as step 1.
    assert.equal(onCalls.length > 0, true, 'fixture assumption: onCall must have fired at least once');
    for (const call of onCalls) {
      assert.equal(call.prompt.includes(SENTINEL), false, `onCall prompt for ${call.label} must never carry the design reference`);
      assert.equal(call.answer.includes(SENTINEL), false, `onCall answer for ${call.label} must never carry the design reference`);
    }
    const sectionOnCalls = onCalls.filter((call) => call.label === SECTION_LABEL);
    assert.ok(sectionOnCalls.length > 0, 'the section fill must have called onCall');
    assert.ok(sectionOnCalls.every((call) => call.prompt.includes(DESIGN_REFERENCE_WITHHELD_MARKER)), 'the section unit\'s recorded onCall prompt must carry the withheld marker in place of the design reference');

    // 3. No RunReport field carries the sentinel.
    assert.equal(JSON.stringify(report).includes(SENTINEL), false, 'designReference must never surface in RunReport');

    // 4. No publisher build record (recipe.json, approved-assets.json, AGENCY-SITE-STATE.md, or
    //    any saved page) carries the sentinel.
    for (const save of publisher.saves) {
      assert.equal(JSON.stringify(save.content).includes(SENTINEL), false, `build record ${save.name} must never carry the design reference`);
    }
    assert.ok(publisher.saves.some((save) => save.name === 'AGENCY-SITE-STATE.md'), 'fixture assumption: the state note must have been written');

    // 5. The REAL `--debug-dir` writer (`createDebugDirOnCall`, imported from cli.ts -- not
    //    reproduced here) never wrote the sentinel to disk, and DID write the withheld marker for
    //    the section unit's own prompt file.
    const files = await readdir(debugDir);
    assert.ok(files.length > 0, 'fixture assumption: the real debug-dir writer must have written files');
    for (const file of files) {
      const content = await readFile(path.join(debugDir, file), 'utf8');
      assert.equal(content.includes(SENTINEL), false, `debug-dir file ${file} must never carry the design reference`);
    }
    // cli.ts's writer flattens `/` to `-` in the filename (the label itself is not sanitized in
    // the recorded prompt/answer content, only in the on-disk name).
    const sectionPromptFiles = files.filter((file) => file.includes(SECTION_LABEL.replace(/[/\\]/g, '-')) && file.endsWith('.prompt.txt'));
    assert.ok(sectionPromptFiles.length > 0, 'fixture assumption: the section fill must have written a prompt file');
    for (const file of sectionPromptFiles) {
      const content = await readFile(path.join(debugDir, file), 'utf8');
      assert.ok(content.includes(DESIGN_REFERENCE_WITHHELD_MARKER), `${file} must carry the withheld marker`);
    }
  } finally {
    await rm(debugDir, { recursive: true, force: true });
  }
});
