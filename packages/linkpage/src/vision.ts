import type { Llm, Signal } from './types.ts';

// Reads brand style from pictures (a logo, a share image, product photos) with a vision-capable model.

const SYSTEM = `You look at images from a creator's brand and describe their visual style.
Answer with JSON only, in this shape:
{"colors":[{"hex":"#rrggbb","weight":1-10}],"fonts":[{"family":"Google Font name","weight":1-10}],"mood":"one word","imagery":"short phrase"}
Rules:
- colors: the dominant brand palette as hex codes, at most 6. Weight 10 is the most used colour.
- fonts: the type style you see in logos and graphics. Give a family name only if you recognise it confidently.
  Otherwise give the kind (serif, sans, mono or display) as a plausible Google Font family, for example
  serif -> "Cormorant Garamond", sans -> "Inter", mono -> "DM Mono", display -> "Abril Fatface".
- mood: one word such as warm, bold, calm, playful, editorial, raw.
- imagery: what the pictures show, in under 12 words.
Only describe what is visible. If an image shows no text or logo, return an empty fonts list.`;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const text = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const weight = (w: unknown): number => Math.min(10, Math.max(1, Math.round(Number(w)) || 1));

function fullHex(h: string): string {
  const x = h.toLowerCase();
  return x.length === 4 ? '#' + [...x.slice(1)].map((c) => c + c).join('') : x;
}

export interface VisionOptions {
  images?: string[];
  llm?: Llm;
  notes?: string;
}

interface VisionReply {
  colors?: { hex?: unknown; weight?: unknown }[];
  fonts?: { family?: unknown; weight?: unknown }[];
  mood?: unknown;
  imagery?: unknown;
}

export async function styleFromImages({ images, llm, notes = '' }: VisionOptions = {}): Promise<Signal | null> {
  const urls = (images || []).filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 6);
  if (!llm || !urls.length) return null;
  const r = (await llm.json({
    system: SYSTEM,
    user: `Describe the brand style in these ${urls.length} image(s).${notes ? ` Context: ${text(notes, 500)}` : ''}`,
    images: urls,
  })) as VisionReply | null | undefined;
  const seen = new Set();
  const colors = (Array.isArray(r?.colors) ? r.colors : [])
    .filter((c) => typeof c?.hex === 'string' && HEX.test(c.hex.trim()))
    .map((c) => ({ hex: fullHex((c.hex as string).trim()), weight: weight(c.weight) }))
    .filter((c) => !seen.has(c.hex) && seen.add(c.hex))
    .slice(0, 6);
  const fonts = (Array.isArray(r?.fonts) ? r.fonts : [])
    .map((f) => ({ family: text(f?.family, 60), weight: weight(f?.weight) }))
    .filter((f) => f.family)
    .slice(0, 3);
  return { source: 'vision', colors, fonts, mood: text(r?.mood, 24).toLowerCase(), imagery: text(r?.imagery, 120), notes: text(notes, 500) };
}
