import { z } from 'zod';

/** W1 searches these local cohorts. Other roster rows are explicit coverage gaps. */
export const RESOURCE_SOURCE_IDS = [
  'plugins', 'genui', 'sections', '21st-dev', 'cult', 'library', 'design-systems', 'project-tokens',
  'brief-derived-tokens', 'fonts', 'generated-media', 'refero', 'design-skills',
  'design-md', 'design-system-checklist', 'react-bits', 'react95', 'canvas-ui',
  'mobbin', 'motionsites', 'ai-sdk-agents', 'magic-patterns', 'shadcn', 'material-ui',
  'hyperui', 'motion', 'lucide', 'magic-ui', 'daisyui', 'heroui', 'creative-tim',
  'morphicons', 'gsap', 'hyperframes', 'aceternity', 'svelte-animations', 'cnblocks', 'animations',
] as const;
const text = z.string().min(1);
export const resourceRefSchema = z.object({
  sourceType: z.enum(['library', 'plugin', 'section', 'genui', 'font', 'skill', 'reference']),
  sourceId: z.enum(RESOURCE_SOURCE_IDS), itemId: text, revisionOrDigest: text,
}).strict();
export type ResourceRef = z.infer<typeof resourceRefSchema>;
