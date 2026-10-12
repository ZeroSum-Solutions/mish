export const PLUGIN_SHARE_ACTIONS = [
  'publish-github',
  'contribute-mish',
] as const;

export type PluginShareAction = (typeof PLUGIN_SHARE_ACTIONS)[number];
