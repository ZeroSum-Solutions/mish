/**
 * Design-system defaults in code.
 *
 * Every place in the product that falls back to a design system when the
 * user or project names none reads `DEFAULT_DESIGN_SYSTEM_ID`. Keep all
 * such defaults here so the promotion gate can check them in one place
 * (`scripts/design-system-promotion-gate.ts`,
 * `findUnallowedDefaultDesignSystems`). The rule is in
 * `docs/design-systems/QUALITY-STANDARD.md`, "Default design system":
 * a default must be `promoted`; while no bundled system is promoted, the
 * bundled `candidate` system may be the default.
 *
 * `neutral-product` is the only bundled design system since 2026-09-23.
 */
export const DEFAULT_DESIGN_SYSTEM_ID = 'neutral-product';

/** Every design-system id used as a default in code. The gate checks each one. */
export const DEFAULT_DESIGN_SYSTEM_IDS: readonly string[] = [DEFAULT_DESIGN_SYSTEM_ID];
