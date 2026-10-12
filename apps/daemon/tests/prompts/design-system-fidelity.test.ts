import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { DESIGN_SYSTEM_BINDING_INSTRUCTION } from '@open-design/contracts';

describe('daemon design-system consumer fidelity', () => {
  it.each(['slim', 'classic'] as const)('uses prose-only guides without requesting absent CSS with %s core', (promptCoreVariant) => {
    const prompt = composeSystemPrompt({ promptCoreVariant, designSystemBody: '# Prose-only system' });
    expect(prompt).toContain('When tokens.css is supplied:');
    expect(prompt).toContain('do not search for missing tokens.css');
    expect(prompt).not.toContain('## Active design system tokens');
  });
  it.each(['slim', 'classic'] as const)('uses the shared binding contract with %s core', (promptCoreVariant) => {
    const css = ':root { --paper: #fafafa; }\n@media (prefers-color-scheme: dark) { :root { --paper: #111111; } }';
    const prompt = composeSystemPrompt({ promptCoreVariant, designSystemBody: '# Source', designSystemTokensCss: css });
    expect(prompt).toContain(DESIGN_SYSTEM_BINDING_INSTRUCTION);
    expect(prompt).toContain(css);
    expect(prompt).not.toContain('Paste the unscoped');
  });
});
