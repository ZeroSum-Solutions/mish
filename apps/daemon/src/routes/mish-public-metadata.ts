import type { Express } from 'express';
import type { MishGithubLatestReleaseResponse } from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { MishPublicMetadataService } from '../services/mish-public-metadata.js';

export interface RegisterMishPublicMetadataRoutesDeps extends RouteDeps<'http'> {
  mishPublicMetadata: MishPublicMetadataService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerMishPublicMetadataRoutes(
  app: Express,
  ctx: RegisterMishPublicMetadataRoutesDeps,
): void {
  const { mishPublicMetadata } = ctx;

  app.get('/api/github/mish/releases/latest', async (_req, res) => {
    try {
      const release = await mishPublicMetadata.readLatestReleaseInfo();
      const payload: MishGithubLatestReleaseResponse = {
        repo: 'ZeroSum-Solutions/mish',
        tag_name: release.tagName,
        html_url: release.htmlUrl,
        fetchedAt: release.fetchedAt,
        stale: release.stale,
      };
      res.json(payload);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });
}
