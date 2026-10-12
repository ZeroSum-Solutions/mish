import { describe, expect, it } from 'vitest';
import type { DesignSystemSummary, PromptTemplateSummary, SkillSummary } from '../../src/types';
import {
  LOCALIZED_CONTENT_IDS,
  localizeDesignSystemSummary,
  localizePromptTemplateSummary,
  localizeSkillDescription,
  localizeSkillName,
  localizeSkillPrompt,
  hasLocalizedContent,
} from '../../src/i18n/content';
import { LOCALES } from '../../src/i18n/types';

describe('localized resource content', () => {

  it('prefers localized skill copy and falls back to english field-by-field', () => {
    // proves the bundle is preferred over the English source fields.
    const translatedSkill = {
      id: '8-bit-orbit-video-template',
      examplePrompt: '  English prompt from source.  ',
      description: '  English description from source.  ',
    } as unknown as SkillSummary;

    expect(localizeSkillPrompt('en', translatedSkill)).toBe('English prompt from source.');
    expect(localizeSkillDescription('en', translatedSkill)).toBe('English description from source.');

    // English source fields.
    const untranslatedSkill = {
      id: 'blog-post',
      examplePrompt: '  English prompt from source.  ',
      description: '  English description from source.  ',
    } as unknown as SkillSummary;

    expect(localizeSkillPrompt("en", untranslatedSkill)).toBe('English prompt from source.');
    expect(localizeSkillDescription("en", untranslatedSkill)).toBe(
      'English description from source.',
    );
  });

  it('uses inline skill display metadata before falling back to source fields', () => {
    const inlineSkill = {
      id: 'inline-skill',
      name: 'inline-skill',
      displayName: {
        en: 'Inline Skill',

      },
      description: ' English description from source. ',
      descriptionI18n: {
        en: 'English inline description.',

      },
      examplePrompt: ' English prompt from source. ',
      examplePromptI18n: {
        en: 'English inline prompt.',

      },
    } as unknown as SkillSummary;

    expect(localizeSkillName('en', inlineSkill)).toBe('Inline Skill');
    expect(localizeSkillDescription('en', inlineSkill)).toBe('English inline description.');
    expect(localizeSkillPrompt('en', inlineSkill)).toBe('English inline prompt.');
  });

  it('falls back to english design system summaries when localized copy is missing', () => {
    const englishOnlySystem = {
      id: 'not-a-real-design-system-id',
      summary: ' English summary from source. ',
      category: 'English category',
    } as DesignSystemSummary;

    expect(localizeDesignSystemSummary("en", englishOnlySystem)).toBe(' English summary from source. ');
  });

  it('prefers localized prompt template fields and falls back to english fields and tags', () => {
    const translatedTemplate = {
      id: '3d-stone-staircase-evolution-infographic',
      surface: 'image',
      title: 'English title',
      summary: 'English summary',
      category: 'Infographic',
      tags: ['3d', 'unknown-tag'],
      source: { repo: 'repo', license: 'MIT' },
    } satisfies PromptTemplateSummary;

    const localized = localizePromptTemplateSummary("en", translatedTemplate);
    expect(localized.title).toBe('English title');
    expect(localized.summary).toBe('English summary');
    expect(localized.category).toBe('Infographic');
    expect(localized.tags).toEqual(['3d', 'unknown-tag']);
    expect(
      localizePromptTemplateSummary("en", { ...translatedTemplate, category: 'Unknown category' }).category,
    ).toBe('Unknown category');

    const englishOnlyTemplate = {
      ...translatedTemplate,
      id: 'not-a-real-prompt-template-id',
      title: ' English title from source ',
      summary: ' English summary from source ',
      category: 'General',
      tags: ['unknown-tag'],
    } satisfies PromptTemplateSummary;

    expect(localizePromptTemplateSummary("en", englishOnlyTemplate)).toMatchObject({
      title: ' English title from source ',
      summary: ' English summary from source ',
      category: 'General',
      tags: ['unknown-tag'],
    });
  });
});
