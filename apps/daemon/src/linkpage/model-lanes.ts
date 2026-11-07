/**
 * The lane table: for each job the link-page builder gives a model, the OpenRouter model ids to try,
 * in order. This is the one place to edit when a better or cheaper model appears (for example after
 * checking artificialanalysis.ai): change an id or reorder a list here and nothing else in the code
 * moves. A model that fails, or answers with something the step cannot use, hands the call to the
 * next id in its list. Ids are OpenRouter ids.
 *
 * Jobs:
 * - `understand`: reads a person from their pages, posts and bios (text only).
 * - `vision`: reads brand style from pictures (needs image input).
 */
import type { LlmJob } from '@mish/linkpage';

export const LINKPAGE_MODEL_TABLE: Readonly<Record<LlmJob, readonly string[]>> = {
  understand: ['anthropic/claude-sonnet-5.5'],
  // DeepSeek V4.1 Flash takes text and images on OpenRouter and is far cheaper; Sonnet 5.5 is the fallback.
  vision: ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5.5'],
};

/** Calls that name no job read a person: they use the first `understand` model. */
const DEFAULT_JOB: LlmJob = 'understand';

/**
 * The ordered model ids for a job. A non-blank `override` (the owner's pick, from
 * OD_LINKPAGE_VISION_MODEL for the vision job) goes first; the table's own ids follow it, so the
 * override still has a fallback.
 */
export function modelsForJob(job: LlmJob | undefined, override?: string): string[] {
  const table = LINKPAGE_MODEL_TABLE[job ?? DEFAULT_JOB];
  const first = override?.trim();
  return first ? [first, ...table.filter((id) => id !== first)] : [...table];
}

/**
 * Where the auto lane goes for its one retry when the quality gate calls the first read insufficient:
 * the lane after the one that answered. The Claude CLI is last, so it has no retry lane.
 */
export const LINKPAGE_RETRY_LANE: Readonly<Record<string, 'claude-cli' | undefined>> = {
  openrouter: 'claude-cli',
  deepseek: 'claude-cli',
};
