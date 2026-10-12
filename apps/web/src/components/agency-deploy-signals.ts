/**
 * The two agency-site deploy signals, in a module of their own so ProjectView can read them
 * without importing FileViewer: FileViewer's module scope reads the deploy provider ids from
 * the providers registry, and a test that mocks the registry partially cannot evaluate it.
 */

/**
 * Agency-site projects exist to be handed to a client, so their preview is
 * meant to be public and "Make preview public" starts ticked for them. The
 * signal is either the persisted Skill (`agency-site`) or a bound
 * `example-agency-*` plugin; a project that says neither keeps the account's
 * deployment-protection default and starts unticked.
 */
export function isAgencySiteDeployProject(input: {
  skillId?: string | null;
  pluginId?: string | null;
}): boolean {
  return input.skillId === AGENCY_SITE_SKILL_ID
    || Boolean(input.pluginId?.startsWith(AGENCY_EXAMPLE_PLUGIN_ID_PREFIX));
}

/**
 * The two project facts the deploy modal's public-access default is read from.
 * One reader, so the ProjectView -> FileWorkspace -> FileViewer path cannot
 * drift apart from what `isAgencySiteDeployProject` expects.
 */
export function agencyDeployProjectSignals(project: {
  skillId?: string | null;
  metadata?: { exampleBinding?: { pluginId?: string | null } | null } | null;
}): { skillId: string | null; pluginId: string | null } {
  return {
    skillId: project.skillId ?? null,
    pluginId: project.metadata?.exampleBinding?.pluginId ?? null,
  };
}

const AGENCY_SITE_SKILL_ID = 'agency-site';
const AGENCY_EXAMPLE_PLUGIN_ID_PREFIX = 'example-agency-';
