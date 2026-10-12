import type { InputFieldSpec } from '@open-design/contracts';
import type { Locale } from './types';

type PluginChromeKey =
  | 'about'
  | 'applying'
  | 'assets'
  | 'atoms'
  | 'author'
  | 'by'
  | 'capabilities'
  | 'capabilitiesHint'
  | 'claudePlugins'
  | 'closeDetails'
  | 'closeEsc'
  | 'connectors'
  | 'contextBundles'
  | 'contextBundlesHint'
  | 'contribute'
  | 'copy'
  | 'copied'
  | 'craft'
  | 'defaultPrefix'
  | 'designSpecOnly'
  | 'designSystem'
  | 'details'
  | 'detailsAria'
  | 'developerDetails'
  | 'examplePrefix'
  | 'exampleQuery'
  | 'exampleQueryHint'
  | 'genuiSurfaces'
  | 'genuiSurfacesHint'
  | 'homepage'
  | 'image'
  | 'inputs'
  | 'inputsHint'
  | 'installed'
  | 'license'
  | 'marketplaceId'
  | 'mcpServers'
  | 'moreWaysTo'
  | 'onFailurePrefix'
  | 'openContributePage'
  | 'openIssueOnGithub'
  | 'optional'
  | 'origin'
  | 'path'
  | 'persistsAt'
  | 'pinnedRef'
  | 'pluginInfo'
  | 'primary'
  | 'repeat'
  | 'required'
  | 'source'
  | 'spec'
  | 'skills'
  | 'trust'
  | 'untilPrefix'
  | 'version'
  | 'video'
  | 'audio'
  | 'workflow'
  | 'workflowHint';

const EN_PLUGIN_CHROME: Record<PluginChromeKey, string> = {
  about: 'About',
  applying: 'Applying…',
  assets: 'Assets',
  atoms: 'Atoms',
  author: 'Author',
  by: 'by',
  capabilities: 'Capabilities',
  capabilitiesHint: 'Permissions the plugin requests when applied.',
  claudePlugins: 'Claude plugins',
  closeDetails: 'Close details',
  closeEsc: 'Close (Esc)',
  connectors: 'Connectors',
  contextBundles: 'Context bundles',
  contextBundlesHint:
    'Skills, design systems, MCP servers and other refs the plugin will pull in at apply time.',
  contribute: 'Contribute',
  copy: 'Copy',
  copied: 'Copied',
  craft: 'Craft',
  defaultPrefix: 'default:',
  designSpecOnly:
    'This plugin ships only the design spec — open Plugin info to read DESIGN.md.',
  designSystem: 'Design system',
  details: 'details',
  detailsAria: '{title} details',
  developerDetails: 'Developer details',
  examplePrefix: 'e.g.',
  exampleQuery: 'Example query',
  exampleQueryHint: 'Inserted into the prompt textarea when you apply this plugin.',
  genuiSurfaces: 'GenUI surfaces',
  genuiSurfacesHint: 'Interactive prompts the plugin may surface during a run.',
  homepage: 'Homepage',
  image: 'Image',
  inputs: 'Inputs',
  inputsHint: 'Variables substituted into the example query at apply time.',
  installed: 'Installed',
  license: 'License',
  marketplaceId: 'Marketplace ID',
  mcpServers: 'MCP servers',
  moreWaysTo: 'More ways to {label}',
  onFailurePrefix: 'on failure:',
  openContributePage: 'Open the contribute page',
  openIssueOnGithub: 'Open an issue on GitHub',
  optional: 'Optional',
  origin: 'Origin',
  path: 'Path',
  persistsAt: 'persists at',
  pinnedRef: 'Pinned ref',
  pluginInfo: 'Plugin info',
  primary: 'primary',
  repeat: 'repeat',
  required: 'required',
  source: 'Source',
  spec: 'Spec',
  skills: 'Skills',
  trust: 'Trust',
  untilPrefix: 'until:',
  version: 'Version',
  video: 'Video',
  audio: 'Audio',
  workflow: 'Workflow',
  workflowHint:
    'Pipeline stages run in order. Atoms inside a stage run sequentially unless the stage repeats.',
};

// The plugin chrome, input labels, placeholders and display values ship in
// English only. The `locale` parameters stay so callers keep one signature
// if a shipped locale gains its own tables.
export function localizePluginInputLabel(_locale: Locale, field: InputFieldSpec): string {
  return field.label ?? field.name;
}

export function localizePluginPlaceholder(
  _locale: Locale,
  value: string | undefined,
  fallback: string = '',
): string {
  return value ?? fallback;
}

export function localizePluginDisplayValue(_locale: Locale, value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

export function localizePluginChrome(
  _locale: Locale,
  key: PluginChromeKey,
  vars: Record<string, string | number> = {},
): string {
  const phrase = EN_PLUGIN_CHROME[key];
  return phrase.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
