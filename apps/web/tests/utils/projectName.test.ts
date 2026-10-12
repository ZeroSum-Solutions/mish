import { describe, expect, it } from 'vitest';

import {
  canAutoRenameProjectFromPrompt,
  deriveWebsiteCloneProjectName,
  summarizeProjectNameFromPrompt,
} from '../../src/utils/projectName';

describe('deriveWebsiteCloneProjectName', () => {
  it('respects an explicit project name in a clone brief', () => {
    expect(deriveWebsiteCloneProjectName('Website URL to clone: https://www.stripe.com/payments -- name the project "QA-0909 Stripe Payments Clone"'))
      .toBe('QA-0909 Stripe Payments Clone');
  });

  it('respects an unquoted requested project name', () => {
    expect(deriveWebsiteCloneProjectName('Website URL to clone: https://example.com. Name the project QA-0909 Example Clone.'))
      .toBe('QA-0909 Example Clone');
  });

  it('names a clone from its reference site when no title was requested', () => {
    expect(deriveWebsiteCloneProjectName('Website URL to clone: https://www.stripe.com/payments'))
      .toBe('Stripe Payments Clone');
  });

  it('uses the generic title only for an empty brief', () => {
    expect(deriveWebsiteCloneProjectName('')).toBe('Website Clone');
  });
});

describe('summarizeProjectNameFromPrompt', () => {
  it.each([
    ['Name the project "QA3-J1 Harbor Bakery". One-page bakery site.', 'QA3-J1 Harbor Bakery'],
    ['Build a prototype. Call this project Harbor Bakery.', 'Harbor Bakery'],
    ['Name the project “My QA3 Bakery”. Build a site.', 'My QA3 Bakery'],
  ])('uses the stated prototype name: %s', (brief, name) => {
    expect(summarizeProjectNameFromPrompt(brief)).toBe(name);
  });
  it.each([
    ['Name the project: Harbor and build a landing page', 'Harbor'],
    ['Call the project: Harbor.', 'Harbor'],
    ['Name the project Harbor and build a landing page', 'Harbor'],
    ['please NAME THE PROJECT harbor bakery, then create a homepage', 'harbor bakery'],
    ['Call this project Harbor Bakery; build a landing page', 'Harbor Bakery'],
    ['name the project harbor bakery. build a site', 'harbor bakery'],
    ['Name the project Harbor Bakery build a landing page', 'Harbor Bakery'],
    ['Call the project: Harbor then design a dashboard', 'Harbor'],
    ['Name the project Asana and build a landing page', 'Asana'],
    ['Call the project: Aspen.', 'Aspen'],
    ['Name the project Harbor launch a landing page', 'Harbor'],
    ['Name the project Harbor\nBuild a landing page', 'Harbor'],
    ['Name the project "Harbor and Home" and build a site', 'Harbor and Home'],
  ])('ends a loose naming request before the next instruction: %s', (brief, name) => {
    expect(summarizeProjectNameFromPrompt(brief)).toBe(name);
    expect(deriveWebsiteCloneProjectName(`https://example.com. ${brief}`)).toBe(name);
    expect(canAutoRenameProjectFromPrompt({ name, metadata: { kind: 'prototype', nameSource: 'generated' } }, brief)).toBe(false);
  });

  it.each([
    'Call the project manager to confirm the scope',
    'please call THE project MANAGER and build a dashboard',
    'Call the project developer to confirm the scope',
    'Call the project director for feedback',
    'Call the project designer',
    'Call this project manager before you start',
    'Call this project manager and build a dashboard',
    'call THIS project developer to confirm the scope',
    'Call the project owner before you start',
    'Call the project management team for feedback',
    'Build a project management dashboard',
    'Name the project. Build a landing page',
    'Name the projects Harbor and Marina',
  ])('does not lock a conversation title for a non-naming instruction: %s', (brief) => {
    expect(canAutoRenameProjectFromPrompt({ name: 'Untitled', metadata: { kind: 'prototype', nameSource: 'generated' } }, brief)).toBe(true);
    expect(deriveWebsiteCloneProjectName(`https://example.com. ${brief}`)).toBe('Example Clone');
  });

  it('summarizes Chinese first prompts into concise project names', () => {
    expect(
      summarizeProjectNameFromPrompt('先实现一下根据项目中的第一个prompt总结项目名称，并自动更改项目名称'),
    ).toBe('自动项目命名');
  });

  it('drops common English request prefixes', () => {
    expect(
      summarizeProjectNameFromPrompt('Please build a settings page for managing desktop pets'),
    ).toBe('Settings Page Managing Desktop Pets');
  });

  it('summarizes turn-this-into prompts by the requested artifact', () => {
    expect(
      summarizeProjectNameFromPrompt(
        'Turn this into an infographic: "5 habits of effective code reviewers — read the PR description first, review tests before implementation"',
      ),
    ).toBe('Infographic 5 Habits Effective Code Reviewers');
  });

  it('ignores code blocks and links before naming', () => {
    expect(
      summarizeProjectNameFromPrompt('Create a dashboard for https://example.com\n```ts\nconst x = 1\n```'),
    ).toBe('Dashboard');
  });

  it('protects explicit names from generated conversation titles', () => {
    const brief = 'Name the project "QA3-J1 Harbor Bakery". One-page bakery site.';
    expect(canAutoRenameProjectFromPrompt({ name: 'QA3-J1 Harbor Bakery', metadata: { kind: 'prototype', nameSource: 'prompt' } }, brief)).toBe(false);
    const generated = { name: 'Untitled', metadata: { kind: 'prototype' as const, nameSource: 'generated' as const } };
    expect(canAutoRenameProjectFromPrompt(generated, brief)).toBe(false);
    expect(canAutoRenameProjectFromPrompt(generated, brief, { allowRequestedName: true })).toBe(true);
  });

  it('only allows first-prompt renaming for generated project names', () => {
    expect(
      canAutoRenameProjectFromPrompt({
        name: 'Prototype',
        metadata: { kind: 'prototype', nameSource: 'generated' },
      }),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt({
        name: 'Imported Client Folder',
        metadata: { kind: 'prototype', nameSource: 'user' },
      }),
    ).toBe(false);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Turn this into an infographic: "5 habits of',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Infographic 5 Habits Effective Code Reviewers',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(true);
    expect(
      canAutoRenameProjectFromPrompt(
        {
          name: 'Design Router',
          metadata: { kind: 'prototype', nameSource: 'prompt' },
        },
        'Turn this into an infographic: "5 habits of effective code reviewers"',
      ),
    ).toBe(false);
    expect(canAutoRenameProjectFromPrompt({ name: 'Project', metadata: undefined })).toBe(false);
  });
});
