/**
 * Streaming helpers: server-sent events from the model API, and progressive extraction of
 * completed `brand` and `sections[i]` objects from a JSON object that is still arriving.
 */

import type { Json } from './spine.ts';

/** Splits an SSE byte stream into `data:` payloads, holding back an unfinished trailing line. */
export class SseParser {
  #rest = '';

  push(chunk: string): string[] {
    this.#rest += chunk;
    const lines = this.#rest.split(/\r?\n/);
    this.#rest = lines.pop() ?? '';
    const out: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') out.push(data);
    }
    return out;
  }
}

export type StreamedUnit = { kind: 'brand'; value: Json } | { kind: 'section'; index: number; value: Json };

/**
 * Watches a JSON object stream of the shape `{"brand": {...}, "sections": [{...}, ...]}` and
 * reports each `brand` object and each `sections` element as soon as it closes. Key order does
 * not matter. A slice that does not parse is skipped; the caller's final parse decides.
 */
export class SectionStream {
  #buffer = '';
  #position = 0;
  #depth = 0;
  #inString = false;
  #escape = false;
  #stringStart = -1;
  #lastString = '';
  #topKey: string | null = null;
  #inSections = false;
  #sectionIndex = 0;
  #elementStart = -1;
  #brandStart = -1;

  push(chunk: string): StreamedUnit[] {
    this.#buffer += chunk;
    const out: StreamedUnit[] = [];
    for (let i = this.#position; i < this.#buffer.length; i += 1) {
      const char = this.#buffer[i]!;
      if (this.#inString) {
        if (this.#escape) this.#escape = false;
        else if (char === '\\') this.#escape = true;
        else if (char === '"') {
          this.#inString = false;
          if (this.#depth === 1) this.#lastString = this.#buffer.slice(this.#stringStart + 1, i);
        }
        continue;
      }
      if (char === '"') {
        this.#inString = true;
        this.#stringStart = i;
        continue;
      }
      if (char === ':' && this.#depth === 1) {
        this.#topKey = this.#lastString;
        continue;
      }
      if (char === '{' || char === '[') {
        this.#depth += 1;
        if (this.#depth === 2) {
          if (this.#topKey === 'sections' && char === '[') this.#inSections = true;
          else if (this.#topKey === 'brand' && char === '{') this.#brandStart = i;
        } else if (this.#depth === 3 && this.#inSections && char === '{') {
          this.#elementStart = i;
        }
        continue;
      }
      if (char === '}' || char === ']') {
        if (this.#depth === 3 && this.#inSections && char === '}' && this.#elementStart >= 0) {
          const value = tryParse(this.#buffer.slice(this.#elementStart, i + 1));
          const index = this.#sectionIndex;
          this.#sectionIndex += 1;
          this.#elementStart = -1;
          if (value !== undefined) out.push({ kind: 'section', index, value });
        } else if (this.#depth === 2) {
          if (this.#inSections && char === ']') this.#inSections = false;
          else if (this.#brandStart >= 0 && char === '}') {
            const value = tryParse(this.#buffer.slice(this.#brandStart, i + 1));
            this.#brandStart = -1;
            if (value !== undefined) out.push({ kind: 'brand', value });
          }
        }
        this.#depth -= 1;
      }
    }
    this.#position = this.#buffer.length;
    return out;
  }

  text(): string {
    return this.#buffer;
  }
}

function tryParse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Final parse of a model answer: tolerates code fences and prose around the object. With
 * `template` (the exact object the prompt asked the model to fill), an answer that is not valid
 * JSON only because of stray `}` closers is recovered too — see `withoutStrayClosers`.
 */
export function parseJsonObject(text: string, template?: Json): Json {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Json;
  } catch (firstError) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('model answer is not a JSON object');
    const sliced = trimmed.slice(start, end + 1);
    const parsed = tryParse(sliced);
    if (parsed !== undefined) return parsed;
    const recovered = template === undefined ? undefined : withoutStrayClosers(sliced, template);
    if (recovered !== undefined) return recovered;
    JSON.parse(sliced); // throws the parse error for the caller's repair message
    throw firstError;
  }
}

/** Positions of every `{` and `}` outside a JSON string in `text`. */
function bracePositions(text: string): { opens: number[]; closes: number[] } {
  const opens: number[] = [];
  const closes: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') opens.push(i);
    else if (char === '}') closes.push(i);
  }
  return { opens, closes };
}

/** Whether `value` has exactly `template`'s object keys and nesting (arrays by element; any string,
 * null or number leaf where the template has a leaf). */
export function hasTemplateShape(value: Json, template: Json): boolean {
  if (Array.isArray(template)) {
    return Array.isArray(value) && value.every((item, index) => hasTemplateShape(item, template[Math.min(index, template.length - 1)] ?? null));
  }
  if (template !== null && typeof template === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(template);
    const valueKeys = Object.keys(value);
    return valueKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key) && hasTemplateShape((value as Record<string, Json>)[key]!, (template as Record<string, Json>)[key]!));
  }
  return value === null || typeof value !== 'object';
}

const MAX_CLOSER_CANDIDATES = 2000;

/**
 * G8 dry run (halcyon x DeepSeek, `now-showing`, about 4 in 9 offline replays and one live cell):
 * the model closes an object early — a stray `}` after each `cardNAlt`, the last key of a card
 * group, as if every card were its own object — and repeats it on every retry, so the unit
 * exhausted its repair budget on a formatting slip. This removes EXACTLY the excess closers (more
 * `}` than `{` outside strings), choosing among the ones followed by a comma and the trailing ones,
 * and accepts a result only when it parses AND has the template's exact keys and nesting. Keys and
 * string values are never touched, so every shape-valid result is the same object the model wrote
 * key by key; every gate still checks it afterwards. `undefined` when no removal fits.
 */
function withoutStrayClosers(text: string, template: Json): Json | undefined {
  const { opens, closes } = bracePositions(text);
  const excess = closes.length - opens.length;
  if (excess <= 0 || excess > 6) return undefined;
  const commaFollowed = closes.filter((at) => /^\s*,/.test(text.slice(at + 1)));
  const trailing = closes.slice(-excess);
  let tried = 0;
  const attempt = (removed: ReadonlySet<number>): Json | undefined => {
    tried += 1;
    let out = '';
    for (let i = 0; i < text.length; i += 1) if (!removed.has(i)) out += text[i];
    const parsed = tryParse(out);
    return parsed !== undefined && hasTemplateShape(parsed, template) ? parsed : undefined;
  };
  const choose = (from: number, left: number, picked: number[]): Json | undefined => {
    if (tried >= MAX_CLOSER_CANDIDATES) return undefined;
    if (left === 0) {
      const tail = trailing.slice(trailing.length - (excess - picked.length)).filter((at) => !picked.includes(at));
      if (picked.length + tail.length !== excess) return undefined;
      return attempt(new Set([...picked, ...tail]));
    }
    for (let i = from; i < commaFollowed.length; i += 1) {
      const found = choose(i + 1, left - 1, [...picked, commaFollowed[i]!]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (let fromComma = Math.min(excess, commaFollowed.length); fromComma >= 0; fromComma -= 1) {
    const found = choose(0, fromComma, []);
    if (found !== undefined) return found;
  }
  return undefined;
}
