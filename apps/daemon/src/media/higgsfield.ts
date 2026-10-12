// The subscription CLI owns OAuth, reference uploads, and provider submission.
// https://higgsfield.ai/mcp — use subscription credits, not the separate REST API.
import { setTimeout as sleep } from 'node:timers/promises';
import { assertAndFetchExternalAsset } from '../connectionTest.js';
import { runHiggsfieldCli } from './higgsfield-runtime.js';
import type { ProviderImageContext } from './provider-image-context.js';
const MODELS: Record<string, { job: string; resolutions: string[]; aspects: string[]; edits: boolean }> = {
  'higgsfield/gpt-image-2': { job: 'gpt_image_2', resolutions: ['1k', '2k', '4k'], aspects: ['auto', '1:1', '4:3', '3:4', '16:9', '21:9', '9:16', '3:2', '2:3', '4:5', '5:4'], edits: true },
  'higgsfield/nano-banana-pro': { job: 'nano_banana_pro', resolutions: ['1k', '2k', '4k'], aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'], edits: true },
  'higgsfield/recraft-v4.1': { job: 'recraft_v4_1', resolutions: ['1k', '2k'], aspects: ['1:1', '3:4', '4:3', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16'], edits: false },
};
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function json(text: string): unknown { try { return JSON.parse(text); } catch { throw new Error('invalid HiggsField CLI response'); } }
export async function renderHiggsfieldImage(
  ctx: ProviderImageContext,
  onProgress?: (message: string) => void,
  runCommand: (args: readonly string[], input?: string) => Promise<string> = runHiggsfieldCli,
): Promise<{ bytes: Buffer; providerNote: string; suggestedExt: string }> {
  const model = MODELS[ctx.wireModel];
  if (!model) throw new Error('unsupported HiggsField image model');
  const resolution = (ctx.resolution ?? (model.edits ? '2k' : '1k')).toLowerCase();
  const aspect = ctx.aspect ?? '1:1';
  if (!model.resolutions.includes(resolution)) throw new Error('unsupported HiggsField resolution');
  if (!model.aspects.includes(aspect)) throw new Error('unsupported HiggsField aspect ratio');
  if (!ctx.prompt.trim()) throw new Error('HiggsField prompt is required');
  if (!model.edits && ctx.imageRefs.length) throw new Error('Recraft accepts text only; choose GPT Image 2 or Nano Banana Pro to edit images');
  if (ctx.imageRefs.length > 14 || ctx.imageRefs.some(ref => !ref.abs || !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mime))) throw new Error('unsupported HiggsField reference image');
  if (ctx.quality && (model.job !== 'gpt_image_2' || !['low', 'medium', 'high'].includes(ctx.quality))) throw new Error('unsupported HiggsField quality');
  const args = ['generate', 'create', model.job, '--aspect_ratio', aspect, '--resolution', resolution];
  if (ctx.quality) args.push('--quality', ctx.quality);
  for (const ref of ctx.imageRefs) args.push('--image', ref.abs!);
  // Prompt travels on stdin, without a shell or credential in argv.
  // Never retry this call: a lost response may already have spent credits.
  const submitted = json(await runCommand(args, ctx.prompt));
  const first = Array.isArray(submitted) ? submitted[0] : submitted;
  const id = typeof first === 'string' ? first : record(first) ? first.id : undefined;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('invalid HiggsField job identifier');
  onProgress?.(`HiggsField job ${id}: queued`);
  let result: Record<string, unknown> | undefined;
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  let delay = 2000; let transientFailures = 0;
  while (true) {
    try { await sleep(delay, undefined, { signal }); }
    catch { throw new Error(`HiggsField generation timed out (job ${id}); check its status before retrying`); }
    delay = Math.min(10000, delay * 1.5);
    let value: unknown;
    try { value = json(await runCommand(['generate', 'get', id])); transientFailures = 0; }
    catch (err) { if (transientFailures++ < 3 && !signal.aborted) continue; throw err; }
    const job = Array.isArray(value) ? value[0] : value;
    if (!record(job) || job.id !== id) throw new Error('invalid HiggsField job response');
    if (!['queued', 'pending', 'in_progress', 'processing', 'running', 'completed', 'failed', 'nsfw', 'canceled', 'cancelled'].includes(String(job.status))) throw new Error('invalid HiggsField job status');
    onProgress?.(`HiggsField job ${id}: ${job.status}`);
    // `nsfw` is the job's only safety verdict, so it is also its category.
    if (['failed', 'nsfw', 'canceled', 'cancelled'].includes(String(job.status))) throw Object.assign(new Error(`HiggsField generation ${job.status}`), { ...(job.status === 'nsfw' ? { code: 'safety_rejection', category: 'safety.nsfw' } : {}), retryable: false });
    if (job.status === 'completed') { result = job; break; }
  }
  if (typeof result.result_url !== 'string') throw new Error('HiggsField completed without an image');
  let url: URL;
  try { url = new URL(result.result_url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
  catch { throw new Error('invalid HiggsField image URL'); }
  let image: Response;
  try { image = await assertAndFetchExternalAsset(url.href, { signal }); }
  catch { throw new Error('HiggsField output download failed'); }
  if (!image.ok) throw new Error(`HiggsField output HTTP ${image.status}`);
  const mime = image.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')) throw new Error('HiggsField did not return an image');
  const bytes = Buffer.from(await image.arrayBuffer());
  if (!bytes.length) throw new Error('HiggsField returned an empty image');
  return { bytes, suggestedExt: mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png', providerNote: `${ctx.wireModel} · subscription · ${resolution} · ${aspect} · ${bytes.length} bytes` };
}
