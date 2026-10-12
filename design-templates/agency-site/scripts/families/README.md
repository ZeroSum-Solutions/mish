# Families

One folder per trusted family: `<family>/` with `contract.ts`, `slots.ts`, `render.ts`, `recipe.schema.json`, `tokens.json`, `tokens.theme.css`, `layout.css`, `runtime.css` or `motion.css`, `browser-source.ts`, `reference.fixture.json`, `interactions.json`, `DESIGN.md`, `README.md`, `render.test.ts`.

The built-in Agency Site skill registers `emmpo` and `watson` in `../family.ts` with static imports, and its `SKILL.md` lists the exact files the daemon freezes into a project. A further family (for example `maben`) lives here as the source of truth and ships in its own plugin package under `plugins/_official/examples/`, whose compiler copy registers only that family. The daemon freezes a selected skill together with its reference studies inside a fixed 1.5 MiB package budget (see `plugins/_official/shared/agency-compiler/README.md`), and that budget is kept for catalog components, not a third family in the built-in skill.
