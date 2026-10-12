/**
 * Preview-only responsive repairs, keyed by the exact pinned converter source name. These do
 * not change licensed source, registry payloads or conversion state. Selectors come from the
 * converted template/styles: keep them scoped to that composition, and re-check their bounds
 * when upgrading the converter. Unknown compositions receive no overrides.
 *
 * Append this CSS after the converted stylesheet. Diagram repairs resize their composition;
 * the comparison table keeps all columns and its own horizontal scrolling container.
 */
export function cultPreviewPresentationCss(internalName: string): string {
  switch (internalName) {
    case 'marketing-integrations-2':
      // The source has a fixed 280px orbit and 80px nodes. Fit the complete seven-spoke diagram,
      // including its tooltip panels, into a phone rather than clipping nodes at the page edge.
      return `@media (width < 40rem){
        #od-live-preview .cult-marketing-integrations-2 .c1f{min-height:640px;width:calc(100% - 32px);margin-inline:auto}
        #od-live-preview .cult-marketing-integrations-2 .ce{scale:.5}
        #od-live-preview .cult-marketing-integrations-2 .c1g{position:absolute;top:0;max-width:240px}
        #od-live-preview .cult-marketing-integrations-2 .c1i{font-size:24px;line-height:1.15}
        #od-live-preview .cult-marketing-integrations-2 .c1j{font-size:14px;line-height:1.5}
        #od-live-preview .cult-marketing-integrations-2 .c1b{font-size:22px;line-height:1.25}
        #od-live-preview .cult-marketing-integrations-2 .c1d{font-size:20px;line-height:1.4}
      }`;
    case 'marketing-integrations-vertical':
      // Five 80px cards plus four 8px gaps exceeded the source's padded mobile column.
      return `@media (width < 40rem){
        #od-live-preview .cult-marketing-integrations-vertical .hs1.hs1{width:clamp(40px,calc((100vw - 80px)/5),80px);height:clamp(40px,calc((100vw - 80px)/5),80px)}
      }`;
    case 'marketing-model-comparison-table-1':
      // Source .c2s has -1rem inline margins below 640px; .c2u is the actual scroll viewport.
      // Leave the table's intentional 800px minimum alone so every column stays reachable.
      return `@media (width < 40rem){
        #od-live-preview .cult-marketing-model-comparison-table-1 .c2s.c2u{margin-inline:0;max-width:100%;min-width:0}
      }`;
    case 'marketing-hero-ribbon':
      // The decorative wrapper is rotated 45 degrees and translated left; scale and recenter
      // the ribbon on phones while preserving its path, tiles, rotation and surrounding copy.
      return `@media (width < 40rem){
        #od-live-preview .cult-marketing-hero-ribbon .c3c.c3i{scale:.72;translate:0 0}
      }`;
    case 'ai-artifact-chart':
      // The harness preserves the source's split chat/artifact panels. Its monetary summary,
      // metrics and breakdown grids need one column in the narrow mobile artifact panel.
      return `@media (width < 40rem){
        body[data-cult-item="ai-artifact-chart"] #root .grid.grid-cols-3.gap-4.border-t.pt-2,
        body[data-cult-item="ai-artifact-chart"] #root .grid.grid-cols-2.gap-4{grid-template-columns:minmax(0,1fr)}
        body[data-cult-item="ai-artifact-chart"] #root .rounded-lg.border.bg-card.p-4 .flex.items-center.justify-between{flex-wrap:wrap;gap:8px}
        body[data-cult-item="ai-artifact-chart"] #root .grid.grid-cols-2.gap-4 .flex.items-center.justify-between{align-items:flex-start;flex-direction:column;gap:2px}
        body[data-cult-item="ai-artifact-chart"] #root .rounded-lg.border.bg-card.p-4 .space-y-1>.flex.items-center.gap-2{flex-wrap:wrap}
      }`;
    case 'feature-sticky-section':
    case 'feature-sticky-section-demo':
      // Source demo .flex.gap-8 gives a 176px sidebar most of a phone's width. Stack that
      // same navigation above its panels on phones, retaining sticky position and triggers.
      return `@media (width < 40rem){
        body[data-cult-item="${internalName}"] #root .flex.gap-8:has(>aside.w-44){flex-direction:column;gap:24px}
        body[data-cult-item="${internalName}"] #root aside.w-44{width:100%;position:sticky;top:1rem;z-index:10;background:var(--background)}
        body[data-cult-item="${internalName}"] #root aside.w-44>ul.sticky{flex-direction:row;flex-wrap:wrap}
      }`;
    default:
      return '';
  }
}
