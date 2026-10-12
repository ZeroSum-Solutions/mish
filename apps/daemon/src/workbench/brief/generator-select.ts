import { designBriefModelOutputSchema, type BriefTransformerLane } from '@mish/contracts';
import type { BriefGenerator, BriefGeneratorAvailability } from './generator.js';

export interface SelectableBriefGeneratorOptions {
  /** The saved Labs choice, read on every call so a switch takes effect without a restart. */
  readLane: () => Promise<BriefTransformerLane>;
  /** The default lane (D28.4). */
  terra: BriefGenerator;
  /** The opt-out lane, and the fallback for every `terra` failure. */
  claude: BriefGenerator;
  /** Gets a fixed reason code when `terra` falls back; never an error message. */
  onFallback?: (reason: 'unavailable' | 'failed' | 'invalid-output') => void;
}

/** Same parse as the service's first validation step, so a fallback happens before a repair turn is spent. */
function parses(text: string): boolean {
  try { return designBriefModelOutputSchema.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu, ''))).success; }
  catch { return false; }
}

/**
 * The transformer behind the Settings → Labs choice. `claude` runs alone.
 * `terra`, the default, gets the first call of each transformation only and falls back to
 * `claude` when it has no key, throws, times out, or answers with something
 * that does not parse as a brief. Every later call of the same transformation
 * (the service's repair turn, which shares its signal) goes to `claude`, so a
 * Terra answer the service rejects for intent drift still gets a Claude repair
 * and two Terra timeouts never stack. The switch can make Improve prompt
 * faster but never makes it fail more often. Cancellation is not a failure:
 * an aborted call is never retried on `claude`.
 */
export function createSelectableBriefGenerator(options: SelectableBriefGeneratorOptions): BriefGenerator {
  /** Transformations that already used their one Terra attempt, keyed by the service's per-transformation signal. */
  const terraTried = new WeakSet<AbortSignal>();
  const lane = async (): Promise<BriefTransformerLane> => { try { return await options.readLane(); } catch { return 'claude'; } };
  const viaClaude = async (...args: Parameters<BriefGenerator['generate']>) => ({ requestedModel: options.claude.modelId, ...await options.claude.generate(...args) });
  return {
    id: 'selectable',
    modelId: options.claude.modelId,
    billingLane: options.claude.billingLane,
    maxInputChars: Math.min(options.claude.maxInputChars, options.terra.maxInputChars),
    async available(): Promise<BriefGeneratorAvailability> {
      if (await lane() === 'terra' && (await options.terra.available()).available) return { available: true };
      return options.claude.available();
    },
    async generate(input, signal, transient) {
      if (!terraTried.has(signal) && await lane() === 'terra') {
        terraTried.add(signal);
        if ((await options.terra.available()).available) {
          try {
            const generation = await options.terra.generate(input, signal, transient);
            if (parses(generation.text)) return { requestedModel: options.terra.modelId, ...generation };
            options.onFallback?.('invalid-output');
          } catch (error) {
            if (signal.aborted) throw error;
            options.onFallback?.('failed');
          }
        } else options.onFallback?.('unavailable');
      }
      return viaClaude(input, signal, transient);
    },
  };
}
