import type { Readable } from 'node:stream';
import { parseTransientSessionProviderCarrier, type ByokChatProviderConfig } from '@open-design/contracts';
const MAX_PROVIDER_BYTES = 16_384;
export class ProviderStdinError extends Error {}
export function assertProviderStdinUsage(flags: Record<string, unknown>, command: string): void {
  if (!flags['byok-provider-stdin']) return;
  if (!['start','continue'].includes(command)) throw new ProviderStdinError('--byok-provider-stdin is supported by run start and continue');
  if (flags['prompt-file'] === '-') throw new ProviderStdinError('Provider and prompt cannot both consume stdin; use --message or a prompt file');
}
export function parseProviderStdin(text: string): ByokChatProviderConfig {
  try {
    if (Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_BYTES) throw new Error();
    return parseTransientSessionProviderCarrier(JSON.parse(text)) as ByokChatProviderConfig;
  } catch { throw new ProviderStdinError('Pass one strict provider JSON object on stdin within 16384 UTF8 bytes'); }
}
export async function readProviderStdin(stream: Readable): Promise<ByokChatProviderConfig> {
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      bytes += buffer.length;
      if (bytes > MAX_PROVIDER_BYTES) { stream.destroy(); throw new ProviderStdinError('Provider stdin exceeds 16384 UTF8 bytes'); }
      chunks.push(buffer);
    }
    return parseProviderStdin(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ProviderStdinError) throw error;
    throw new ProviderStdinError('Could not read provider JSON from stdin');
  }
}
