import { describe, expect, it } from 'vitest';

import { parseDesignMd } from '../../src/runtime/design-md-parse';

it('reads explicit platform-font prose without including forbidden weights', () => {
  const parsed = parseDesignMd('# Neutral Product\n\n## Typography\nOne family for display and body (the platform UI font). Monospace for code.\n- Weights: 400 body, 500 labels, 600 headings. Do not use 700+ for headings.');
  expect(parsed.typography.display?.family).toBe('system-ui');
  expect(parsed.typography.body?.weights).toEqual([400, 500, 600]);
  expect(parsed.typography.mono?.family).toBe('ui-monospace');
});

// The brand-generated emitter shape (apps/daemon/src/brands/design-md.ts):
// YAML frontmatter + `## Color Palette` table + `## Typography` font lines +
// `## Voice & Tone` / `## Imagery` / `## Layout`. The web parser must round-trip
// this so a brand-derived design system renders its modules.
const BRAND_EMITTER_MD = [
  '---',
  'name: "The Economist"',
  'category: Brands',
  'surface: web',
  'colors:',
  '  economist-red: "#e3120b"',
  '  ink: "#0d0d0d"',
  '---',
  '',
  '# The Economist',
  '> Category: Brands',
  '> Surface: web',
  '*Go beyond breaking news*',
  'The Economist is a weekly newspaper covering world politics and economics.',
  '',
  '## Color Palette',
  '',
  '| Role | Name | Hex | Usage |',
  '| --- | --- | --- | --- |',
  '| accent | Economist Red | `#E3120B` | masthead, links, CTAs |',
  '| foreground | Ink | `#0D0D0D` | primary text |',
  '',
  '## Typography',
  '',
  '- **Display:** EconomistSans — weights 400, 700 — fallbacks: Source Sans 3, system-ui',
  '- **Body:** EconomistSerif — weights 400 — fallbacks: Georgia, serif',
  '',
  '## Voice & Tone',
  '',
  '- **Adjectives:** authoritative, incisive, witty',
  '- **Tone:** Plain, confident and analytical with a dry wit.',
  '',
  '### Messaging pillars',
  '- Go beyond breaking news',
  '- A single, coherent editorial voice',
  '',
  '### Vocabulary',
  '- **Use:** leader, why it matters',
  '- **Avoid:** clickbait, emoji',
  '',
  '## Imagery',
  '',
  '- **Style:** Bold conceptual editorial illustration.',
  '- **Subjects:** world leaders, markets',
  '- **Treatment:** flat colour over ink line',
  '- **Avoid:** stock-photo clichés',
  '',
  '## Layout',
  '',
  '- **Radius:** 0px',
  '- **Border weight:** 1px',
  '- **Spacing:** 8px baseline grid',
  '',
  '### Posture rules',
  '- White ground, near-black text, thin grey hairlines.',
].join('\n');

// A bundled preset shape (design-systems/*/DESIGN.md): numbered headings, bullet
// palette + `Families: primary=…` typography, no Voice/Imagery sections.
const PRESET_MD = [
  '# Design System Inspired by Agentic',
  '',
  '> Category: Themed & Unique',
  '> Conversational AI-first interface.',
  '',
  '## 2. Color',
  '',
  '- **Primary:** `#FF5701` — Token from style foundations.',
  '- **Surface:** `#FFFFFF` — Large backgrounds and cards.',
  '- **Text:** `#111827` — Body copy.',
  '',
  '## 3. Typography',
  '',
  '- **Families:** primary=Playfair Display, display=Playfair Display, mono=JetBrains Mono',
  '- **Weights:** 400, 600, 700',
].join('\n');

describe('parseDesignMd', () => {
  it('round-trips the brand emitter DESIGN.md shape', () => {
    const parsed = parseDesignMd(BRAND_EMITTER_MD);

    expect(parsed.name).toBe('The Economist');
    expect(parsed.tagline).toBe('Go beyond breaking news');
    expect(parsed.description).toContain('weekly newspaper');

    // Color table wins over frontmatter; hexes normalize to lowercase.
    const accent = parsed.colors.find((c) => c.hex === '#e3120b');
    expect(accent?.name).toBe('Economist Red');
    expect(accent?.usage).toContain('masthead');
    expect(parsed.colors.some((c) => c.hex === '#0d0d0d')).toBe(true);

    expect(parsed.typography.display?.family).toBe('EconomistSans');
    expect(parsed.typography.display?.weights).toContain(400);
    expect(parsed.typography.display?.fallbacks).toContain('Source Sans 3');
    expect(parsed.typography.body?.family).toBe('EconomistSerif');

    expect(parsed.voice.adjectives).toContain('authoritative');
    expect(parsed.voice.tone).toContain('dry wit');
    expect(parsed.voice.messagingPillars).toContain('Go beyond breaking news');
    expect(parsed.voice.vocabulary.use).toContain('leader');
    expect(parsed.voice.vocabulary.avoid).toContain('emoji');

    expect(parsed.imagery.style).toContain('editorial illustration');
    expect(parsed.imagery.subjects).toContain('markets');

    expect(parsed.layout.radius).toBe('0px');
    expect(parsed.layout.spacing).toContain('baseline grid');
    expect(parsed.layout.postureRules.length).toBeGreaterThan(0);
  });

  it('falls back to frontmatter colors when no palette table exists', () => {
    const md = ['---', 'name: "Acme"', 'colors:', '  brand: "#123456"', '---', '', '# Acme'].join('\n');
    const parsed = parseDesignMd(md);
    expect(parsed.colors).toHaveLength(1);
    expect(parsed.colors[0]?.hex).toBe('#123456');
  });

  it('parses the bundled preset DESIGN.md shape (numbered headings, bullet palette)', () => {
    const parsed = parseDesignMd(PRESET_MD);

    expect(parsed.name).toBe('Design System Inspired by Agentic');
    expect(parsed.category).toBe('Themed & Unique');

    expect(parsed.colors.map((c) => c.hex)).toEqual(
      expect.arrayContaining(['#ff5701', '#ffffff', '#111827']),
    );
    const primary = parsed.colors.find((c) => c.hex === '#ff5701');
    expect(primary?.role).toBe('accent');

    expect(parsed.typography.display?.family).toBe('Playfair Display');
    expect(parsed.typography.mono?.family).toBe('JetBrains Mono');
    expect(parsed.typography.display?.weights).toEqual(expect.arrayContaining([400, 600, 700]));
  });

  it('returns empty modules for an empty document without throwing', () => {
    const parsed = parseDesignMd('');
    expect(parsed.colors).toEqual([]);
    expect(parsed.typography.display).toBeUndefined();
    expect(parsed.voice.adjectives).toEqual([]);
  });
});


describe('source font identifiers', () => {
  it('still removes underscore emphasis from readable fields', () => {
    const parsed = parseDesignMd('# Study\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n| accent |  __Primary__  | #123456 | A __bold__ and _italic_ note |');
    expect(parsed.colors[0]?.name).toBe('Primary');
    expect(parsed.colors[0]?.usage).toBe('A bold and italic note');
  });

  it('preserves internal underscores in source CSS family names', () => {
    const parsed = parseDesignMd('# Study\n\n## Typography\n- **Display:** hurme_no2-webfont — fallbacks: Inter, sans-serif');
    expect(parsed.typography.display?.family).toBe('hurme_no2-webfont');
  });
});

describe('design system guidance', () => {
  it('preserves named light and dark values in semantic mode tables', () => {
    const parsed = parseDesignMd('# Neutral Product\n\n## Color\n| Role | Light | Dark | Use |\n| --- | --- | --- | --- |\n| `--bg` | #f8f8f7 | #111214 | Page canvas. |\n| `--accent-on` | #ffffff | #0b1820 | Text on accent. |');
    expect(parsed.colors).toEqual([
      { role: '--bg', name: '--bg (Light)', hex: '#f8f8f7', usage: 'Page canvas.' },
      { role: '--bg', name: '--bg (Dark)', hex: '#111214', usage: 'Page canvas.' },
      { role: '--accent-on', name: '--accent-on (Light)', hex: '#ffffff', usage: 'Text on accent.' },
      { role: '--accent-on', name: '--accent-on (Dark)', hex: '#0b1820', usage: 'Text on accent.' },
    ]);
  });

  it('retains explicit color limitations without inventing a swatch for malformed values', () => {
    const parsed = parseDesignMd('# Study\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n| source | Yellow | #f7f270 | Calls to action |\n\n### Source color limits\n- Inkwell Black was recorded as #17150; no valid color value is supplied.');
    expect(parsed.colors).toHaveLength(1);
    expect(parsed.colorNotes).toEqual(['Inkwell Black was recorded as #17150; no valid color value is supplied.']);
  });

  it('does not turn hex values in source limitation notes into palette rows', () => {
    const parsed = parseDesignMd('# Study\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n| source | Yellow | #f7f270 | Calls to action |\n\n### Source color limits\n- A gradient from #f7f270 to #000000 is retained as a source expression, rather than a solid swatch.');
    expect(parsed.colors).toHaveLength(1);
    expect(parsed.colorNotes?.[0]).toContain('#000000');
  });

  it('keeps Neutral Product radius continuations and its dedicated spacing rhythm', () => {
    const parsed = parseDesignMd('# Neutral Product\n\n## Spacing\nThe layout grid is 8px. `--space-2` (8), `--space-4` (16), and `--space-6` (24) set layout.\n\n## Layout\n- Marketing grid: 12 columns at 1280, 6 at 768, 1 at 360. Content is left\n  aligned. Heroes are left aligned with a product image on the right.\n- Radius: `--radius-sm` 6 for controls, `--radius-md` 8 for cards,\n  `--radius-lg` 12 for large media, `--radius-pill` for badges only.');
    expect(parsed.layout.radius).toContain('--radius-lg 12 for large media');
    expect(parsed.layout.radius).toContain('--radius-pill for badges only.');
    expect(parsed.layout.spacing).toContain('The layout grid is 8px.');
    expect(parsed.layout.spacing).not.toContain('12 columns');
    expect(parsed.layout.postureRules).toContain('Marketing grid: 12 columns at 1280, 6 at 768, 1 at 360. Content is left aligned. Heroes are left aligned with a product image on the right.');
  });

  it('retains every recorded palette role, including shared values and large palettes', () => {
    const rows = Array.from({ length: 16 }, (_, index) => `| token-${index} | Token ${index} | #${(index + 1).toString(16).padStart(6, '0')} | Recorded role ${index} |`);
    const parsed = parseDesignMd(`# Study\n\n## Colors\n| Role | Name | Hex | Usage |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n| surface | Card | #000001 | Card surface |`);
    expect(parsed.colors).toHaveLength(17);
    expect(parsed.colors.at(-1)?.usage).toBe('Card surface');
  });

  it('preserves wrapped explicit posture rules', () => {
    const parsed = parseDesignMd('# Study\n\n## Layout\n### Posture rules\n- Keep cards in one row.\n  Allow horizontal scrolling on phones.\n\n### Other notes\n- Exclude this group.');
    expect(parsed.layout.postureRules).toEqual(['Keep cards in one row. Allow horizontal scrolling on phones.']);
  });

  it('reads source imagery and layout prose instead of dropping unlabelled sections', () => {
    const parsed = parseDesignMd('# Field Guide\n\n## Imagery and graphics\nNatural-light rooms in rounded photo cards.\n\nNo abstract renders.\n\n## Layout system\nA centered 1200px frame with a 12-column grid.\n\n- Keep the hero left aligned.\n  Collapse to one column on phones.');
    expect(parsed.imagery.style).toContain('Natural-light rooms');
    expect(parsed.imagery.style).toContain('No abstract renders.');
    expect(parsed.layout.description).toContain('12-column grid');
    expect(parsed.layout.postureRules).toEqual(['Keep the hero left aligned. Collapse to one column on phones.']);
  });

  it.each([
    ['## Rules', '**Do**', "**Don't**"],
    ['## Do and avoid', '### Do', '### Avoid'],
    ["## Do's and Don'ts", '**Do**', '**Don’t**'],
  ])('preserves distinct source rules and wrapped lines for %s', (title, doLabel, avoidLabel) => {
    const parsed = parseDesignMd(`# Study\n\n${title}\n\n${doLabel}\n- Keep coral on the search trigger.\n  Preserve its documented role.\n\n${avoidLabel}\n- Do not use coral for body text.\n\n\`\`\`html\n- This is code, not a design rule.\n\`\`\`\n\n## Components\n- Not a rule either.`);
    expect(parsed.rules.do).toEqual(['Keep coral on the search trigger. Preserve its documented role.']);
    expect(parsed.rules.avoid).toEqual(['Do not use coral for body text.']);
  });
});

it('does not infer platform typography from a prohibition or a generic design-system mention', () => {
  for (const prose of ['Do not use system-ui fonts.', 'Avoid the platform UI font.', 'This design system font needs reviewing.']) {
    const parsed = parseDesignMd('# Test\n\n## Typography\n' + prose);
    expect(parsed.typography.display).toBeUndefined();
    expect(parsed.typography.body).toBeUndefined();
  }
});


describe('local font availability', () => {
  it('does not treat recorded source weights in availability notes as bundled weights', () => {
    const parsed = parseDesignMd("# Example\n\n## Typography\n- **Body:** 'Cal Sans Text UI' — weights: 400 — availability: Recorded weights 300, 500; bundled weights 400.\n");
    expect(parsed.typography.body?.weights).toEqual([400]);
  });
  it('keeps the real bundled family and explains the recorded source substitution', () => {
    const result = parseDesignMd("# Example\n\n## Typography\n\n- **Display:** 'Manrope' — weights: 400, 700 — source stack: `Satoshi, system-ui` — availability: Source: Satoshi. Free visual alternative; not the original typeface.\n");
    expect(result.typography.display?.family).toBe('Manrope');
    expect(result.typography.display?.notes).toContain('Source: Satoshi');
    expect(result.typography.display?.weights).toEqual([400, 700]);
  });
});
