# Neutral Product Usage

Agent guide for the Neutral Product package. Archetype 1 of the agency
design-system core. Promotion state lives in `promotion.json`.

## Read Order

1. Read this file.
2. Read `DESIGN.md` for rules on color, type, spacing, states, and voice.
3. Paste all of `tokens.css` (light `:root`, both dark blocks, and the
   reduced-motion block) into the first `<style>` of the artifact. Then use
   `var(--*)` only.
4. Use `components.manifest.json` for the component inventory. Open
   `components.html` when exact selectors or states matter.
5. Open the specimen closest to the task: `preview/specimen-website.html`,
   `preview/specimen-app.html`, `preview/specimen-document.html`, or
   `preview/specimen-campaign.html`.

## Design Highlights

- Neutral surfaces with one steel-blue accent. Accent marks the next action
  and the current location only.
- System font stack. Hierarchy from size and weight, not from a display face.
- 8px layout rhythm. 4px and 12px steps only inside components.
- Light mode by default. Dark mode through `data-theme="dark"` or the OS
  setting. `data-theme="light"` forces light.
- Form controls use `--border-strong` so their edges reach 3:1.
- Focus ring: surface-colored gap plus accent ring, on `:focus-visible` only.

## Do

- Keep one primary (accent-filled) button per view region.
- Show all states: hover, focus, disabled, error, loading, and empty.
- Label status with an icon and a word, not color alone.
- Use `tabular-nums` for numbers in tables.
- Mark sample data as sample data.

## Avoid

- Raw color values outside `tokens.css`. Use `color-mix()` with tokens for tints.
- New tokens or a second accent color.
- Gradients, glass effects, glows, emoji icons, and centered hero stacks.
- Loading remote fonts. The system uses platform fonts on purpose.
- Invented metrics or testimonials presented as real.
