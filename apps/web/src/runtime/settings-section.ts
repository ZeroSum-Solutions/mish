export type SettingsSection =
  | 'general'
  | 'labs'
  | 'execution'
  | 'workspace'
  | 'instructions'
  | 'media'
  | 'composio'
  | 'orbit'
  | 'routines'
  | 'integrations'
  | 'mcpClient'
  | 'language'
  | 'appearance'
  | 'critiqueTheater'
  | 'notifications'
  | 'pet'
  | 'designSystems'
  | 'projectLocations'
  | 'memory'
  | 'privacy'
  | 'licensedPacks'
  // 'library' is consumed by the EntryShell library route — App opens it
  // via this same openSettings entry point, so SettingsSection must
  // accept the token even though SettingsDialog itself has no Library
  // section. Reconcile follow-up: route library through a dedicated
  // navigate() call so openSettings only owns dialog-bound sections.
  | 'library'
  | 'about';

// Maps a requested section token onto the section that actually owns a nav
// item. Only tokens whose content is *folded into* another section belong
// here: language / appearance / notifications / pet / projectLocations /
// critiqueTheater all render inside General, so a deep link to any of them
// must land on General and highlight the General nav item. `pet` joined that
// list when #5517's General page absorbed the pet picker — the composer's
// "pet settings" entry point (App.openPetSettings) has no other destination,
// so leaving it unmapped would deep-link into a section that renders nothing.
//
// Sections that keep their own render block but no longer have a nav item
// (workspace, mcpClient, composio, designSystems) must NOT be listed: they
// stay individually addressable through `initialSection`, and folding them
// here would silently swallow a deep link into the wrong section.
// `privacy` and `about` must not be listed either — they own nav items, and
// mapping them to General used to send deep links to the wrong section with
// the wrong nav item highlighted.
export function normalizeSettingsSection(section: SettingsSection): SettingsSection {
  switch (section) {
    case 'language':
    case 'appearance':
    case 'notifications':
    case 'pet':
    case 'projectLocations':
    case 'critiqueTheater':
      return 'general';
    default:
      return section;
  }
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = ["general", "labs", "execution", "workspace", "instructions", "media", "composio", "orbit", "routines", "integrations", "mcpClient", "language", "appearance", "critiqueTheater", "notifications", "pet", "designSystems", "projectLocations", "memory", "privacy", "licensedPacks", "library", "about"];

export function parseSettingsSection(value: string | undefined): SettingsSection | undefined {
  // Library is a separate view, not a SettingsDialog section.
  if (value === 'library') return undefined;
  return SETTINGS_SECTIONS.find(section => section === value);
}
