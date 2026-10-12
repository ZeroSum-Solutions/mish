import { describe, expect, it } from 'vitest';

import {
  buildSocialSharePayload,
  MISH_GITHUB_REPO_URL,
} from '../src/api/social-share';

describe('social-share contract', () => {
  it('builds Mishh Mashh repository share targets', () => {
    const payload = buildSocialSharePayload({
      kind: 'mish-repo',
      locale: 'zh-CN',
      title: 'Mishh Mashh GitHub',
      text: '推荐 Mishh Mashh',
    });

    expect(payload.url).toBe(MISH_GITHUB_REPO_URL);
    expect(payload.locale).toBe('zh-CN');
    expect(payload.platforms.some((target) => target.platform === 'x' && target.shareUrl?.includes('twitter.com/intent/tweet'))).toBe(true);
    expect(payload.platforms.some((target) => target.platform === 'xiaohongshu' && target.mode === 'copy-open')).toBe(true);
  });

  it('keeps deployed project links and the repo recommendation together', () => {
    const payload = buildSocialSharePayload({
      kind: 'project-html',
      locale: 'en',
      url: 'https://example.com/mish-demo',
      title: 'Demo',
      text: `Built with Mishh Mashh. Repo: ${MISH_GITHUB_REPO_URL}`,
      copyText: `Demo\nhttps://example.com/mish-demo\n${MISH_GITHUB_REPO_URL}`,
    });

    expect(payload.url).toBe('https://example.com/mish-demo');
    expect(payload.githubRepoUrl).toBe(MISH_GITHUB_REPO_URL);
    expect(payload.copyText).toContain(MISH_GITHUB_REPO_URL);
    expect(payload.platforms.find((target) => target.platform === 'telegram')?.shareUrl)
      .toContain('https%3A%2F%2Fexample.com%2Fmish-demo');
  });
});
