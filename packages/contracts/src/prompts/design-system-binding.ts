/** One consumer contract for legacy, API and OD Next generation. */
export const DESIGN_SYSTEM_BINDING_INSTRUCTION = `During Plan, bind the selected system's recorded roles to the product's canvas, surfaces, text, primary action, on-action text, links, borders, typography, spacing and component shapes. Use the supplied role-binding notes and usage evidence; never choose an accent by hue or palette order. Keep logo-only, decorative and informational colors within their recorded roles. A monochrome source stays monochrome.

During Build: When tokens.css is supplied: Copy the complete supplied tokens.css into the first style block, preserving all scoped theme overrides, media queries and reduced-motion rules, not just the first :root. Then include the package's render layer from its usage notes when supplied. Reference source or render-safe variables in the actual component declarations. Copying variables without using them does not apply a design system. Role aliases made from var() references are allowed; they add no new palette values. Do not replace the selected system with generic template colors or typography. If the package only supplies a prose guide, implement its documented roles, typography and layout directly; do not search for missing tokens.css or claim invented CSS as source tokens. The package's usage notes and the prohibition against generic substitutions also apply to prose-only guides.

Do not consume ambiguous ranges, prose, malformed colors or nonzero unitless lengths directly as CSS property values. Follow the package's documented render-safe substitute, keeping source evidence unchanged. If no source-backed resolution exists, use the explicitly labeled local fallback and state the limitation. Preserve recorded typography weights and role restrictions. When custom font files are absent, use the documented fallback stack with a generic family and disclose the substitution. Source captures are reference evidence, not invented product imagery.

For localStorage-based demos, a sandbox preview may block durable storage or supply temporary memory storage. Keep save-state labels accurate: changes that reset on reload are temporary demo state, not durably saved. Do not narrate sandbox infrastructure in the assistant reply. Preserve normal persistence outside the sandbox.

Use token references for product color declarations, including overlays; avoid raw colors outside the source/render layer. Keep these choices within Plan and Build; this contract adds no execution stages.`;

export function renderDesignSystemTokensBlock(tokensCss: string | undefined, title?: string): string {
  const css = tokensCss?.trim();
  return css ? `\n\n## Active design system tokens${title ? ` — ${title}` : ''}\n\n\`\`\`css\n${css}\n\`\`\`` : '';
}

export function renderDesignSystemUsageBlock(usageMd: string | undefined): string {
  const usage = usageMd?.trim();
  return usage ? `\n\n## How to use this design system\n\n${usage}` : '';
}
