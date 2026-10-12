// The 40 paid MotionSites live templates, as a separate external starting-point list (design doc
// §4). Hand-curated, static, and checked in — NOT fetched live, because MotionSites' documented
// MCP tools (`list_prompts`/`search_prompts`/`get_prompt`/`get_related_prompts`) only cover its
// 530-row prompt library (`prompts_public`); the 40-template `lovable_templates` table has no MCP
// tool of its own (verified against the live tool schemas while building this bridge). Every
// `id`/`title`/`url` here is public browsing metadata from motionsites.ai/templates (title and
// existence are visible with no login; only the "Open in Lovable/Bolt" remix action is
// paywalled), sourced from the read-only inventory at
// `<private-notes>/mishh-genui-production/motionsites/inventory.json` →
// `templates_lovable_templates_table.items` (fetched 2026-09-24).
//
// The source table carries no `category` field for templates (unlike the prompt library), so most
// entries below have `category: undefined` and `spineAffinity: 'unclassified'` — a bare title
// ("Glow", "Shift", "Prism") is not evidence enough to assign a spine, matching
// `@open-design/section-catalog`'s own normalizer discipline (never guess, never default to
// `'MI'`). The handful with `spineAffinity` set below are the ones whose title itself states an
// unambiguous category that `shape-atlas.json`/`family-registry.json` maps confidently — same
// citation bar the normalizer applies to the prompt library's actual `category` column.

import type { MotionSitesStartingPoint } from '@open-design/contracts/api/motionsites';

const MOTIONSITES_TEMPLATES_BASE_URL = 'https://motionsites.ai/templates#';

function unclassified(id: string, title: string): MotionSitesStartingPoint {
  return { id, title, spineAffinity: 'unclassified', url: `${MOTIONSITES_TEMPLATES_BASE_URL}${id}` };
}

function classified(id: string, title: string, category: string, spineAffinity: MotionSitesStartingPoint['spineAffinity']): MotionSitesStartingPoint {
  return { id, title, category, spineAffinity, url: `${MOTIONSITES_TEMPLATES_BASE_URL}${id}` };
}

export const MOTIONSITES_STARTING_POINTS: readonly MotionSitesStartingPoint[] = [
  unclassified('73c46f6e-6cfb-406d-a943-f60a8a4c721d', 'AI Automation'),
  // shape-atlas.json TL.05 "Agency, consultancy, or studio", keywords include "agency".
  classified('f6cafabe-f404-44bd-a631-685e7bc8610a', 'Agency Template', 'Agency', ['TL']),
  unclassified('f3577f3c-71e2-489f-86c5-819bd5de224d', 'Analytics Platform'),
  unclassified('1995d6d6-92fc-4f53-a028-09df4d2acdf6', 'Background Gallery'),
  unclassified('f71a6186-7a0c-4b02-86ec-cc3dafbe9946', 'BuildAI'),
  unclassified('378cb8bc-e2e2-4bee-b04c-22a2820f0f46', 'Codezilla'),
  unclassified('50950b66-0399-4749-b496-1c8d40db2512', 'Converse'),
  unclassified('1c74ae5a-76cf-4fb9-be97-e416cf31b85b', 'Datacore'),
  unclassified('baa76d4e-de1c-4b5e-9e66-b1e9698d51fe', 'Design Rocket'),
  unclassified('91e599e6-4703-4b6a-801a-e7ef2e42ac53', 'Design Rocket Motion'),
  // shape-atlas.json CS.02 "docs/KB" archetype — the family-registry has no family serving it yet
  // (see scout-repo-families.md §1), but the archetype itself names this category unambiguously.
  classified('d689cb08-7116-4963-91ed-a67fb88a8bdf', 'Documentation', 'Documentation', ['CS']),
  // shape-atlas.json CO.01 "Ecommerce retailer", keywords include "ecommerce"/"commerce".
  classified('31ba3136-fd41-4884-9862-ea6ccba0ae76', 'E-commerce System', 'Ecommerce', ['CO']),
  unclassified('81b7a1e0-1cbb-46de-8fcf-454b46d109e6', 'Electric'),
  unclassified('9a67226d-14a9-4032-82d7-d69e6b673c06', 'Forge'),
  unclassified('ee72929b-6d47-41d1-acdb-9343b942dc83', 'Forma.co'),
  classified('00d765c8-4f67-4f7f-bb2a-72a3855d4cfd', 'Full Agency Template', 'Agency', ['TL']),
  unclassified('5d8af3ed-ceed-4ed2-b9ce-18fa0f6213bd', 'Glow'),
  unclassified('5c2a5d3c-151d-4129-b2de-bc0fa15f3545', 'Insight'),
  unclassified('d207284b-cea9-4fc1-b47d-72b4aaf8a77b', 'Lumen'),
  unclassified('0c379434-f877-41ea-a8fc-71bbb52ff354', 'Maestro Vision'),
  // shape-atlas.json TL.06 "Personal expert or portfolio", keywords include "portfolio".
  classified('9aed0fdf-9967-4c76-b56e-b3fa182e65e8', 'Michael Smith Portfolio', 'Portfolio', ['TL']),
  classified('688686e7-0494-4f27-b0d2-32690de88a12', 'Motion Portfolio', 'Portfolio', ['TL']),
  unclassified('1e224a8c-2a3c-40f3-9454-a0820b701235', 'MotionAI'),
  unclassified('45377b2a-74b8-47ff-8aa8-2e71d3a3a06f', 'Nebula Glow'),
  unclassified('6389b6cf-9321-4d42-8e6c-ba738d1e7cc5', 'Neon'),
  unclassified('5ce57acb-2330-4245-87ad-fe1cecc06660', 'Nexora'),
  unclassified('6c571b24-1d4f-43f7-a476-be3b04a1d5b9', 'Next Level Innovation'),
  unclassified('c21ae703-cd06-40f1-8ec7-0496c756f0eb', 'Nimbus Grid'),
  unclassified('465cc92e-2986-4f76-b14e-94f4df63d320', 'Nova Template'),
  unclassified('d7ff5e15-ef45-4022-8f2a-cf66fa2d3495', 'Platform Rocket'),
  unclassified('b1e64107-2a73-4fa3-ad57-bd0aab968693', 'Prism'),
  unclassified('e977f3fe-56d3-41c2-9438-96097a2118d2', 'Radiant'),
  unclassified('1906d86b-d715-4be5-9474-47c32a2991d0', 'Serein - Minimal Hero'),
  unclassified('662c8f48-57de-4e2d-ae11-b33686e1e1ed', 'Shift'),
  unclassified('3407a0f0-4e3c-45e0-96c9-4cc0c678d610', 'Ship Products'),
  unclassified('9438010c-edc5-41ae-a37b-a6b5a9e06524', 'Simple Start'),
  // Two distinct templates share the bare title "Strat" in the source table, which has no
  // `category` field to disambiguate them with (see the module doc). The table's own
  // `created_at` timestamp is the only other real, sourced field that differs between them, so it
  // is appended as a distinguishing subtitle rather than inventing a category — NIT from the
  // delta audit ("a UI rendering titles will show two identical cards").
  unclassified('b70cd7f6-7d6e-44ae-b00e-38e4529f2b77', 'Strat (2025-12-31)'),
  unclassified('0852d1cb-9761-445b-b252-99d86dceda4a', 'Strat (2025-12-18)'),
  unclassified('31742367-dc33-4890-97fd-942e26346280', 'Vertex Template'),
  unclassified('cd7386e3-1016-4c22-aa87-5c49a6f1ddd9', 'Wealth Builder'),
];
