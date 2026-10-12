import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeMaxCaptureDraftGenerator } from '../../src/workbench/capture/draft-generator.js';
import { runClaudeProcess } from '../../src/workbench/review/reviewers/claude-visual.js';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { fileCaptureBytes, pngBytes } from './capture-fixture.js';
import { PRIVATE_METADATA, privateAnimatedWebp, privatePng } from './capture-metadata-fixture.js';
import { sniffRaster } from '../../src/workbench/capture/image.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function input(image = pngBytes(40, 30)) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'od-draft-generator-')); dirs.push(dataDir);
  const captures = createCaptureService({ dataDir, bytes: fileCaptureBytes(path.join(dataDir, 'bytes')) });
  const raster = sniffRaster(image)!;
  const capture = (await captures.import({ metadata: { projectId: 'p1', captureMode: 'upload', frame: { width: raster.width, height: raster.height } }, body: image, mediaType: raster.mediaType, idempotencyKey: 'shot', surface: 'web' })).view.capture;
  return { dataDir, request: { capture, image, prompt: 'Build a matching section.' } };
}
const output = { html: '<!doctype html><html><head><title>Fixture</title></head><body><h1>Hello</h1></body></html>', assumptions: ['The typeface is unknown.'] };

describe('capture draft vision subscription adapter', () => {
  it.each([['png', privatePng], ['webp', privateAnimatedWebp]] as const)('scrubs legacy %s metadata before the model Read and clears confined scratch', async (extension, image) => {
    const { dataDir, request } = await input(image());
    const generator = createClaudeMaxCaptureDraftGenerator({ dataDir, resolveBin: () => '/mock/claude', env: { HOME: '/fixture', PATH: '/fixture/bin', ANTHROPIC_API_KEY: 'blocked-value', OD_TOOL_TOKEN: 'blocked-token' }, run: async call => {
      expect(call.env).toEqual({ HOME: '/fixture', PATH: '/fixture/bin' });
      expect(call.args).toContain('--restricted'); expect(call.args).toContain('--strict-mcp-config');
      expect(call.args[call.args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
      expect(call.args[call.args.indexOf('--tools') + 1]).toBe('Read');
      expect(call.args[call.args.indexOf('--allowedTools') + 1]).toContain(call.cwd);
      expect(call.stdin).toContain('Build a matching section');
      const imagePath = path.join(call.cwd, `capture.${extension}`);
      expect((await readFile(imagePath)).toString()).not.toContain(PRIVATE_METADATA);
      return { exitCode: 0, stderr: '', stdout: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'read1', input: { file_path: imagePath } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'image', is_error: false }] } },
        { type: 'result', structured_output: output },
      ].map(frame => JSON.stringify(frame)).join('\n') };
    } });
    // A pre-change saved capture can still contain metadata: scrub at model staging too.
    expect(await generator.generate(request, new AbortController().signal)).toEqual(output);
    expect(await readdir(path.join(dataDir, 'workbench-capture-drafts/generation'))).toEqual([]);
  });

  it('rejects a mocks/ CLI replay without an observed image read or structured answer; never reaches a real provider', async () => {
    const { dataDir, request } = await input();
    const recordings = path.join(dataDir, 'recordings'); await mkdir(recordings);
    await writeFile(path.join(recordings, 'r14-fixture.jsonl'), JSON.stringify({ type: 'meta', trace_id: 'r14-fixture', model: 'fixture' }) + '\n' + JSON.stringify({ type: 'report', content: JSON.stringify(output) }) + '\n');
    const mockCli = path.resolve('../../mocks/bin/claude');
    const generator = createClaudeMaxCaptureDraftGenerator({ dataDir, resolveBin: () => mockCli, run: call => runClaudeProcess({ ...call, env: { ...call.env, OD_MOCKS_RECORDINGS_DIR: recordings, OD_MOCKS_TRACE: 'r14-fixture', OD_MOCKS_NO_DELAY: '1' } }) });
    await expect(generator.generate(request, new AbortController().signal)).rejects.toThrow('screenshot was not read');
    expect(await readdir(path.join(dataDir, 'workbench-capture-drafts/generation'))).toEqual([]);
  });
});
