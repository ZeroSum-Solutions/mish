// Catalog entries for connectors Mish authenticates itself (see ../native-oauth.ts).
import { defineConnectorTool, type ConnectorCatalogDefinition } from '../catalog.js';
import { TIKTOK_SCOPES } from './tiktok.js';

const readSafety = { sideEffect: 'read', approval: 'auto', reason: 'Reads the connected TikTok account through the Display API; changes nothing.' } as const;

export const TIKTOK_NATIVE_TOOLS = {
  userInfo: 'tiktok_user_info',
  videoList: 'tiktok_video_list',
} as const;

/** Replaces the Composio TikTok entry of the same id while the native provider is installed. */
export const NATIVE_TIKTOK_DEFINITION: ConnectorCatalogDefinition = {
  id: 'tiktok',
  name: 'TikTok',
  provider: 'native',
  category: 'social',
  description: `Connect your own TikTok account with Mish's built-in sign-in. Mish asks TikTok for: ${TIKTOK_SCOPES.join(', ')}. It can read your profile, follower and like counts, and your latest videos. It cannot post.`,
  authentication: 'native',
  tools: [
    defineConnectorTool({
      name: TIKTOK_NATIVE_TOOLS.userInfo,
      title: 'Get TikTok profile',
      description: 'Read the connected TikTok profile: name, bio, avatar and counts.',
      requiredScopes: ['user.info.basic', 'user.info.profile', 'user.info.stats'],
      inputSchemaJson: { type: 'object', additionalProperties: false, properties: {} },
      safety: readSafety,
    }),
    defineConnectorTool({
      name: TIKTOK_NATIVE_TOOLS.videoList,
      title: 'List TikTok videos',
      description: 'Read the connected account\'s latest public videos (up to 20).',
      requiredScopes: ['video.list'],
      inputSchemaJson: { type: 'object', additionalProperties: false, properties: { max_count: { type: 'integer' } } },
      safety: readSafety,
    }),
  ],
  allowedToolNames: [TIKTOK_NATIVE_TOOLS.userInfo, TIKTOK_NATIVE_TOOLS.videoList],
  curatedToolNames: [TIKTOK_NATIVE_TOOLS.userInfo, TIKTOK_NATIVE_TOOLS.videoList],
  toolCount: 2,
  minimumApproval: 'auto',
};
