/** Original Higgsfield media, embedded locally so static previews need no network permission. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import artwork from '@mish/21st-catalog/generated/preview-artwork/manifest.json' with { type: 'json' };

const directory = path.dirname(fileURLToPath(import.meta.resolve('@mish/21st-catalog/generated/preview-artwork/manifest.json')));
const images = new Map<string, string>();
function image(id: string): string | null {
  const entry = artwork.items.find((item) => item.id === id);
  if (!entry) return null;
  let uri = images.get(id);
  if (!uri) {
    uri = `data:image/webp;base64,${readFileSync(path.join(directory, entry.file)).toString('base64')}`;
    images.set(id, uri);
  }
  return uri;
}

/** Small avatars get portraits; editorial panels get photographs. Layout dimensions stay intact. */
export function cultPreviewArtwork(body: string, name: string): string {
  let index = 0;
  return body.replace(/<span\b([^>]*\bclass="[^"]*\bcult-img-box\b[^"]*"[^>]*)><\/span>/gi, (original, attributes: string) => {
    const i = index++;
    const portrait = /(?:team|testimonial|cta|waitlist)/.test(name) || name === 'sass-colorful';
    // The page and its constituent section use the same artwork sequence.
    const selection = portrait
      ? ['portrait-one', 'portrait-two', 'portrait-three', 'portrait-four', 'portrait-five', 'portrait-six']
      : name.includes('roadmap') ? ['studio', 'glass', 'landscape'] : ['glass', 'landscape', 'studio'];
    const uri = image(selection[i % selection.length]!);
    if (!uri) return original;
    const description = portrait ? 'Illustrative portrait of a fictional team member' : 'Original editorial study';
    return `<span${attributes}><img data-preview-artwork="${i + 1}" src="${uri}" alt="${description}" width="${portrait ? 320 : 960}" height="${portrait ? 427 : 540}" decoding="async"></span>`;
  });
}
