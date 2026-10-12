# skills

This directory holds **functional skills** — capabilities the agent
invokes mid-task to do work on user input. Each skill is a folder with a
`SKILL.md` (frontmatter + body) and any side files (`assets/`,
`references/`, scripts, …) the workflow needs.

If the entry primarily *renders* a design artifact (deck, prototype,
image/video/audio template) it belongs under `../design-templates/`
instead. See `specs/current/skills-and-design-templates.md` for the
full split.

## Daemon plumbing

- Listed under `/api/skills` (functional only). User-imported skills
  shadow built-in entries with the same frontmatter `name`.
- Asset routes (`/api/skills/:id/example`, `/api/skills/:id/assets/*`)
  span both functional skills and design templates so existing
  `srcdoc`-rewritten URLs keep resolving after the split.
- Integrations → Skills surfaces this directory only. Renderable templates are
  read from the design-templates registry by the New project "Start from" rails;
  the redesigned home no longer has a top-level Templates tab.

## Adding a skill

1. Create `skills/<my-skill>/SKILL.md` with `name`, `description`,
   `triggers`, and `od.mode: utility` (or `design-system`) frontmatter.
2. Drop any side files alongside; reference them from the body using
   the relative-from-skill-root paths the daemon advertises in the
   skill preamble.
3. The daemon's lazy scanner picks the entry up on the next
   `/api/skills` request — no rebuild required during local dev.

## Bundled catalogue

The bundled catalogue is intentionally minimal: this public repository ships
only Website Clone (`web-clone/`). The supplemental agency reference studies
(Emmpo, Watson, Cult Heroes) are private content and are not published here;
do not recreate them, and keep code and tests working when they are absent.
Where they are installed, they apply captured design evidence to an existing
workflow without installing source-site code or replacing the project's
creation skill, and use the daemon's supported `design-system` mode with
`od.design_system.requires: false` to classify their design-constraint role.
Users can add their own skills without repopulating the application with
unrelated example workflows.
