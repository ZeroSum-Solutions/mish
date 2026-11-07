/**
 * The Jev quality gate. After a build, TypeSafe Jev (typed yes/no "noul" questions) judges what the
 * model extracted: is the bio and headline sufficient and specific to this person, and how likely is
 * each extracted item (headline, themes, post and video titles) for a creator with these gathered
 * facts. Items under `GATE_ITEM_THRESHOLD` are taken off the page and listed in the report.
 *
 * The gate only removes or rejects. It never writes, rewrites or adds text. It fails open: no key,
 * a network failure, a bad status or an unreadable answer leaves the page exactly as built.
 * The key is read through the injected lookup and is never logged or returned.
 */
import { postSystemOne } from '@mish/agency-fast-lane/jev';
import type { CreatorFacts } from '@mish/linkpage';
import type { LinkPageBlock, LinkPageGate, LinkPageGateDrop, LinkPageGateItemKind, LinkPageSpec } from '@mish/contracts';

/** An item whose probability is under this is dropped from the page. */
export const GATE_ITEM_THRESHOLD = 0.2;
/** A bio and headline under this probability of being sufficient and specific are reported as insufficient. */
export const GATE_SUFFICIENCY_THRESHOLD = 0.4;

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 15_000;
const KEY_TIMEOUT_MS = 5_000;
const SHOWN_TEXT_MAX = 120;

export interface GateReviewInput {
  spec: LinkPageSpec;
  facts: CreatorFacts;
  /** Fields the creator typed themselves: trusted, so they are not judged as extracted items. */
  fromOptions: { headline?: boolean; bio?: boolean };
}

export interface GateReviewResult {
  spec: LinkPageSpec;
  gate: LinkPageGate;
}

export interface JevGateDeps {
  /** The daemon key store's Jev lookup. Rejecting means no key. */
  resolveKey: () => Promise<string>;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  keyTimeoutMs?: number;
}

export interface JevGate {
  review: (input: GateReviewInput) => Promise<GateReviewResult>;
}

interface Item { id: string; kind: LinkPageGateItemKind; text: string }

const round = (p: number): number => Math.round(p * 100) / 100;

/** The items to judge, in a fixed order: headline, themes, then post titles. */
function itemsOf(spec: LinkPageSpec, fromOptions: GateReviewInput['fromOptions']): Item[] {
  const texts: Array<{ kind: LinkPageGateItemKind; text: string }> = [];
  if (spec.profile.headline && !fromOptions.headline) texts.push({ kind: 'headline', text: spec.profile.headline });
  for (const theme of spec.profile.themes ?? []) if (theme) texts.push({ kind: 'theme', text: theme });
  for (const block of spec.blocks) {
    if (block.type !== 'posts') continue;
    for (const item of block.items) if (item.title) texts.push({ kind: 'post', text: item.title });
  }
  return texts.map((t, i) => ({ id: `item_${i}`, ...t }));
}

const SUFFICIENT_QUESTION = {
  type: 'noul',
  instructions: 'Are `headline` and `bio` together sufficient and specific to the person described in `creator`? They should say who this person is and what they make or do in a way that could not describe just anyone.',
  criteria: {
    true: 'The headline and bio name what this particular person makes or does, consistent with the facts in creator, with some concrete detail.',
    false: 'The headline and bio are empty, generic filler that could fit anyone, or say things the facts in creator do not support.',
  },
} as const;

const itemQuestion = (id: string) => ({
  type: 'noul',
  instructions: `How likely is it that a person with the profile and industry shown in \`creator\` would have this content: \`${id}.text\`? Its kind (headline, theme or post title) is in \`${id}.kind\`.`,
  criteria: {
    true: 'This content is what a person with this profile and industry would plausibly publish or be known for.',
    false: 'This content is unrelated to, or out of character for, a person with this profile and industry.',
  },
} as const);

function without(spec: LinkPageSpec, drop: Set<string>, items: Item[]): LinkPageSpec {
  const dropped = new Map(items.filter((i) => drop.has(i.id)).map((i) => [`${i.kind}\u0000${i.text}`, true]));
  const gone = (kind: LinkPageGateItemKind, text: string): boolean => dropped.has(`${kind}\u0000${text}`);
  const blocks: LinkPageBlock[] = [];
  for (const block of spec.blocks) {
    if (block.type !== 'posts') {
      blocks.push(block);
      continue;
    }
    const kept = block.items.filter((item) => !gone('post', item.title));
    if (kept.length > 0) blocks.push({ ...block, items: kept });
  }
  return {
    ...spec,
    profile: {
      ...spec.profile,
      headline: gone('headline', spec.profile.headline) ? '' : spec.profile.headline,
      themes: (spec.profile.themes ?? []).filter((theme) => !gone('theme', theme)),
    },
    blocks,
  };
}

/** The key, or undefined when there is none or the lookup stalls. */
async function keyOf(lookup: () => Promise<string>, ms: number): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const key = await Promise.race([
      Promise.resolve().then(lookup),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('key lookup timeout')), ms); }),
    ]);
    return key.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const open = (spec: LinkPageSpec, skipped: 'no-key' | 'unavailable'): GateReviewResult => ({ spec, gate: { ran: false, skipped, dropped: [] } });

function probabilityOf(answers: unknown, id: string): number | undefined {
  const answer = (answers as Record<string, { noul?: unknown } | undefined> | undefined)?.[id];
  const p = answer?.noul;
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}

export function createJevGate(deps: JevGateDeps): JevGate {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  return {
    async review({ spec, facts, fromOptions }) {
      const key = await keyOf(deps.resolveKey, deps.keyTimeoutMs ?? KEY_TIMEOUT_MS);
      if (!key) return open(spec, 'no-key');

      const bio = spec.profile.bio ?? '';
      const headline = spec.profile.headline ?? '';
      // Both typed by the creator: nothing a better read could fix, so nothing to judge.
      const askSufficiency = !(fromOptions.headline && fromOptions.bio);
      const noText = askSufficiency && !bio && !headline;
      const items = itemsOf(spec, fromOptions);
      const state: Record<string, unknown> = { creator: facts, bio, headline };
      const questions: Record<string, unknown> = {};
      if (askSufficiency && !noText) questions.sufficient = SUFFICIENT_QUESTION;
      for (const item of items) {
        state[item.id] = { kind: item.kind, text: item.text };
        questions[item.id] = itemQuestion(item.id);
      }
      const none = noText ? { insufficient: { reason: 'the page has no bio and no headline', probability: 0 } } : {};
      if (Object.keys(questions).length === 0) return { spec, gate: { ran: true, ...none, dropped: [] } };

      let answers: unknown;
      try {
        const raw = await postSystemOne({
          endpoint: JEV_ENDPOINT, model: JEV_MODEL, timeoutMs: deps.timeoutMs ?? JEV_TIMEOUT_MS, fetchImpl, key: async () => key, state, questions,
        });
        if (!raw.ok) return open(spec, 'unavailable');
        answers = (JSON.parse(raw.text) as { answers?: unknown }).answers;
        if (!answers || typeof answers !== 'object') return open(spec, 'unavailable');
      } catch {
        return open(spec, 'unavailable');
      }

      const dropped: LinkPageGateDrop[] = [];
      const drop = new Set<string>();
      for (const item of items) {
        const p = probabilityOf(answers, item.id);
        if (p === undefined || p >= GATE_ITEM_THRESHOLD) continue;
        drop.add(item.id);
        dropped.push({ kind: item.kind, text: item.text.slice(0, SHOWN_TEXT_MAX), probability: round(p) });
      }
      const sufficiency = questions.sufficient ? probabilityOf(answers, 'sufficient') : undefined;
      const rounded = sufficiency === undefined ? undefined : round(sufficiency);
      const insufficient = noText
        ? none.insufficient
        : rounded !== undefined && rounded < GATE_SUFFICIENCY_THRESHOLD
          ? { probability: rounded, reason: `Jev rates the bio and headline ${rounded} for being sufficient and specific to this person, under the ${GATE_SUFFICIENCY_THRESHOLD} needed` }
          : undefined;
      return {
        spec: drop.size > 0 ? without(spec, drop, items) : spec,
        gate: { ran: true, ...(rounded !== undefined ? { sufficiency: rounded } : {}), ...(insufficient ? { insufficient } : {}), dropped },
      };
    },
  };
}
