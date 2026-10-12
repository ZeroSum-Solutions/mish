// KIE Market contract: https://docs.kie.ai/market/google/nanobanana2
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertAndFetchExternalAsset } from '../connectionTest.js';
import type { ProviderImageContext } from './provider-image-context.js';
const API_ORIGIN = 'https://api.kie.ai';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function httpsUrl(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error(); const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); return url.href;
  } catch { throw new Error('invalid KIE image URL'); }
}
export async function renderKieImage(
  ctx: ProviderImageContext,
  credentials: { apiKey?: string; baseUrl?: string },
  onProgress?: (message: string) => void,
): Promise<{ bytes: Buffer; providerNote: string; suggestedExt: string }> {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error('no KIE credential — configure its API key in Settings / Media providers.');
  if (/\s/.test(apiKey)) throw new Error('invalid KIE API key');
  if (credentials.baseUrl && credentials.baseUrl.replace(/\/$/, '') !== API_ORIGIN) throw new Error('KIE uses https://api.kie.ai; custom API origins are unsupported');
  if (ctx.wireModel !== 'kie/nano-banana-2') throw new Error('unsupported KIE image model');
  const resolution = (ctx.resolution ?? '1K').toUpperCase();
  if (!['1K', '2K', '4K'].includes(resolution)) throw new Error('unsupported KIE resolution');
  const aspect = ctx.aspect ?? '1:1';
  if (!['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'].includes(aspect)) throw new Error('unsupported KIE aspect ratio');
  if (!ctx.prompt.trim() || ctx.prompt.length > 20000) throw new Error('KIE prompt must contain 1–20000 characters');
  if (ctx.imageRefs.some(ref => !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mime) || !ref.dataUrl.startsWith(`data:${ref.mime};base64,`))) throw new Error('unsupported KIE reference image');
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  async function api(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await fetch(url, { ...ctx.requestInit, ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error' }); }
    catch { throw new Error('KIE request failed; generation submissions are not automatically retried'); }
    if (!response.ok) throw Object.assign(new Error(`KIE HTTP ${response.status}`), { status: response.status, retryable: false });
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('invalid KIE response'); }
    if (!record(body)) throw new Error('invalid KIE response');
    if (body.code !== 200) throw Object.assign(new Error(`KIE API ${typeof body.code === 'number' ? body.code : 'error'}`), { ...(typeof body.code === 'number' && body.code >= 400 && body.code <= 599 ? { status: body.code } : {}), retryable: false });
    if (!record(body.data)) throw new Error('invalid KIE response data'); return body.data;
  }
  const imageUrls: string[] = [];
  for (const ref of ctx.imageRefs) {
    // Official upload origin; our key must not follow an HTTP redirect.
    const upload = await api('https://kieai.redpandaai.co/api/file-base64-upload', {
      method: 'POST', headers, body: JSON.stringify({ base64Data: ref.dataUrl, uploadPath: 'images/mishh-mashh', fileName: `${randomUUID()}.${ref.mime === 'image/jpeg' ? 'jpg' : ref.mime.split('/')[1]}` }),
    });
    imageUrls.push(httpsUrl(upload.downloadUrl));
  }
  const submitted = await api(`${API_ORIGIN}/api/v1/jobs/createTask`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'nano-banana-2', input: { prompt: ctx.prompt, image_input: imageUrls, aspect_ratio: aspect, resolution, output_format: 'png' } }),
  });
  const taskId = submitted.taskId;
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('invalid KIE task identifier');
  onProgress?.(`KIE task ${taskId}: waiting`);
  let delay = 2000; let failures = 0; let result: Record<string, unknown>;
  while (true) {
    try { await sleep(delay + Math.floor(Math.random() * 300), undefined, { signal }); }
    catch { throw new Error(`KIE generation timed out (task ${taskId}); check its status before retrying`); }
    delay = Math.min(10000, delay * 1.5);
    try {
      result = await api(`${API_ORIGIN}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: 'GET', headers }); failures = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!signal.aborted && failures++ < 5 && (/KIE (HTTP|API) (429|5\d\d)/.test(message) || message.startsWith('KIE request failed'))) continue;
      throw err;
    }
    if (result.taskId !== taskId) throw new Error('KIE task identifier changed');
    if (!['waiting', 'queuing', 'generating', 'success', 'fail'].includes(String(result.state))) throw new Error('invalid KIE task status');
    onProgress?.(`KIE task ${taskId}: ${result.state}`);
    if (result.state === 'fail') throw new Error('KIE image generation failed');
    if (result.state === 'success') break;
  }
  let output: unknown;
  try { output = JSON.parse(typeof result.resultJson === 'string' ? result.resultJson : ''); } catch { throw new Error('invalid KIE image result'); }
  if (!record(output) || !Array.isArray(output.resultUrls) || !output.resultUrls.length) throw new Error('KIE completed without an image');
  let image: Response;
  try { image = await assertAndFetchExternalAsset(httpsUrl(output.resultUrls[0]), { signal }); }
  catch { throw new Error('KIE output download failed'); }
  if (!image.ok) throw new Error(`KIE output HTTP ${image.status}`);
  const mime = image.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '')) throw new Error('KIE did not return an image');
  const bytes = Buffer.from(await image.arrayBuffer()); if (!bytes.length) throw new Error('KIE returned an empty image');
  return { bytes, suggestedExt: mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png', providerNote: `kie/nano-banana-2 · ${resolution} · ${aspect} · ${bytes.length} bytes` };
}
