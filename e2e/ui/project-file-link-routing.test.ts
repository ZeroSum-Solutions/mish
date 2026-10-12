import { expect, test } from '@/playwright/suite';
import { ACTIVE_ARTIFACT_PREVIEW_SELECTOR } from '@/playwright/artifact-preview';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { expectAllProjectFilesActive, openAllProjectFiles } from '@/playwright/workspace';
import { T } from '@/timeouts';

test.describe.configure({ timeout: 30_000 });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test('[P1] assistant project file links open workspace tabs instead of new browser windows', async ({ page }) => {
  const { projectId, conversationId } = await seedProjectWithAssistantFileLink(page);

  await page.goto(`/projects/${projectId}/conversations/${conversationId}`, { waitUntil: 'domcontentloaded' });
  await waitForWorkspaceReady(page);
  await expect(page.getByText('已完成单文件原型：')).toBeVisible();

  const fileTab = page.getByRole('tab', { name: /index\.html/i });
  await expect(fileTab).toBeVisible();
  await openAllProjectFiles(page);
  await expectAllProjectFilesActive(page);

  const pageCountBefore = page.context().pages().length;
  const popupPromise = page.waitForEvent('popup', { timeout: 1_000 }).catch(() => null);
  await page.locator('.msg.assistant a.md-link', { hasText: 'index.html' }).click();
  const popup = await popupPromise;

  expect(popup).toBeNull();
  expect(page.context().pages()).toHaveLength(pageCountBefore);
  await expect(fileTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR).getByRole('heading', {
    name: 'Project file link target',
  })).toBeVisible();
});

test('[P1] a same-project preview link opens the target file at its fragment', async ({ page }) => {
  const projectId = await seedProjectWithFragmentLink(page);

  await page.goto(`/projects/${projectId}/files/about.html`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Loading Mishh Mashh…').waitFor({ state: 'hidden', timeout: T.medium }).catch(() => {});
  await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
  const aboutFrame = page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
  await expect(aboutFrame.getByRole('heading', { name: 'About page' })).toBeVisible({ timeout: T.medium });

  await aboutFrame.getByRole('link', { name: 'Go to target' }).click();

  await expect(page.getByRole('tab', { name: /index\.html/i })).toHaveAttribute('aria-selected', 'true');
  const indexFrame = page.frameLocator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR);
  const target = indexFrame.locator('#target');
  await expect(target).toBeInViewport({ timeout: T.medium });
  await expect(indexFrame.locator('#intro')).not.toBeInViewport();

  // The page sees a real fragment navigation, not just a scroll.
  const frameHandle = await page.locator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR).first().elementHandle();
  const frame = await frameHandle?.contentFrame();
  await expect.poll(async () => frame?.evaluate(() => window.location.hash)).toBe('#target');

  // A link to another fragment of the already-open file scrolls the live page.
  await indexFrame.getByRole('link', { name: 'Back to intro' }).click();
  await expect(indexFrame.locator('#intro')).toBeInViewport({ timeout: T.medium });
  await expect(target).not.toBeInViewport();
  await expect(page.getByRole('tab', { name: /index\.html/i })).toHaveAttribute('aria-selected', 'true');

  // A later plain link to the same file is a fresh navigation to the top; it
  // must not keep the earlier fragment.
  await indexFrame.getByRole('link', { name: 'Plain index' }).click();
  await expect(indexFrame.locator('#intro')).toBeInViewport({ timeout: T.medium });
  await expect(target).not.toBeInViewport();
  const plainHandle = await page.locator(ACTIVE_ARTIFACT_PREVIEW_SELECTOR).first().elementHandle();
  const plainFrame = await plainHandle?.contentFrame();
  await expect.poll(async () => plainFrame?.evaluate(() => window.location.hash)).toBe('');
});

async function seedProjectWithFragmentLink(page: Page): Promise<string> {
  const projectId = `file-link-fragment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectResponse = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name: 'File Link Fragment',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(projectResponse.ok(), `create project: ${await projectResponse.text()}`).toBeTruthy();

  const spacer = '<div style="height: 2400px">Spacer</div>';
  const pages: Record<string, string> = {
    'about.html': '<!doctype html><html><body><main><h1>About page</h1>'
      + '<a href="index.html#target">Go to target</a></main></body></html>',
    'index.html': '<!doctype html><html><body><main>'
      + '<section id="intro"><h1>Index intro</h1></section>'
      + spacer
      + '<section id="target"><h2>Target section</h2><a href="index.html#intro">Back to intro</a> '
      + '<a href="index.html">Plain index</a></section>'
      + spacer
      + '</main></body></html>',
  };
  for (const [name, content] of Object.entries(pages)) {
    const fileResponse = await page.request.post(`/api/projects/${projectId}/files`, {
      data: {
        name,
        content,
        artifactManifest: {
          version: 1,
          kind: 'html',
          title: name,
          entry: name,
          renderer: 'html',
          exports: ['html'],
        },
      },
    });
    expect(fileResponse.ok(), `seed ${name}: ${await fileResponse.text()}`).toBeTruthy();
  }
  return projectId;
}

async function seedProjectWithAssistantFileLink(
  page: Page,
): Promise<{ projectId: string; conversationId: string }> {
  const projectId = `file-link-routing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectResponse = await page.request.post('/api/projects', {
    data: {
      id: projectId,
      name: 'File Link Routing',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(projectResponse.ok(), `create project: ${await projectResponse.text()}`).toBeTruthy();
  const { conversationId } = (await projectResponse.json()) as { conversationId: string };

  const fileResponse = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'index.html',
      content: '<!doctype html><html><body><main><h1>Project file link target</h1></main></body></html>',
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: 'index.html',
        entry: 'index.html',
        renderer: 'html',
        exports: ['html'],
      },
    },
  });
  expect(fileResponse.ok(), `seed index.html: ${await fileResponse.text()}`).toBeTruthy();

  const localAbsoluteHref = `/Users/mac/open-design/open-design-preview-0.10.0/projects/File%20Link%20Routing/index.html`;
  const assistantText = `已完成单文件原型：[index.html](${localAbsoluteHref})。`;
  const assistantResponse = await page.request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/a-${projectId}`,
    {
      data: {
        role: 'assistant',
        content: assistantText,
        runStatus: 'succeeded',
        events: [{ kind: 'text', text: assistantText }],
        createdAt: Date.now() - 1_000,
      },
    },
  );
  expect(assistantResponse.ok(), `seed assistant message: ${await assistantResponse.text()}`).toBeTruthy();

  return { projectId, conversationId };
}

async function waitForWorkspaceReady(page: Page) {
  await page.getByText('Loading Mishh Mashh…').waitFor({ state: 'hidden', timeout: T.medium }).catch(() => {});
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.medium });
  await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
}
