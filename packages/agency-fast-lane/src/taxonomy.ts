/**
 * The design taxonomy: the controlled vocabularies a design profile is classified against
 * (`design-taxonomy.json`), loaded with `readFile` + `JSON.parse` (never import attributes) so
 * tsc and the test runner see the same code path, exactly as `atlas.ts` loads the Website Shape
 * Atlas. Every label's `definition` is written as a concrete situation and used verbatim as the
 * Jev question criterion text in `profile.ts` — this file only loads and validates the data.
 *
 * The validators check structural integrity that must hold for any correctly-formed taxonomy,
 * real or a test fixture: ids unique within each vocabulary, every definition non-empty, every
 * style axis has at least 3 named options (`unspecified` is added by `profile.ts` at question-build
 * time, mirroring how `route.ts` adds `skin`'s `unspecified` option — it is not stored here), and
 * every quality dimension carries exactly 5 ordered levels (Jev's Score primitive takes an ordered
 * `criteria` array; the design doc fixes the scale at 0-4). The *specific* content of the checked-in
 * taxonomy (28 sections, 24 components, 20 mechanics, 5 depth cues, 6 style axes, 7 quality
 * dimensions, 9 actions) is asserted by `tests/taxonomy.test.ts` directly against the loaded file.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type TaxonomyLabel = { id: string; definition: string };
export type QualityDimension = { id: string; rubric: string; levels: string[] };
export type TruthRiskQuestion = { id: string; instructions: string; criteriaTrue: string; criteriaFalse: string };

export type StyleAxes = {
  ground: TaxonomyLabel[];
  accent: TaxonomyLabel[];
  typography: TaxonomyLabel[];
  imagery: TaxonomyLabel[];
  topology: TaxonomyLabel[];
  density: TaxonomyLabel[];
};

export type DesignTaxonomy = {
  version: string;
  sections: TaxonomyLabel[];
  components: TaxonomyLabel[];
  mechanics: TaxonomyLabel[];
  depth: TaxonomyLabel[];
  style: StyleAxes;
  quality: QualityDimension[];
  truthRisk: TruthRiskQuestion;
  action: TaxonomyLabel[];
};

export const DEFAULT_TAXONOMY_PATH = path.join(import.meta.dirname, 'taxonomy/design-taxonomy.json');

const STYLE_AXIS_NAMES = ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const;
const MIN_STYLE_OPTIONS = 3;
const QUALITY_LEVEL_COUNT = 5;

function validateLabelList(name: string, list: TaxonomyLabel[]): void {
  if (list.length === 0) throw new Error(`design taxonomy: ${name} must have at least one label`);
  const ids = new Set<string>();
  for (const item of list) {
    if (ids.has(item.id)) throw new Error(`design taxonomy: duplicate id ${item.id} within ${name}`);
    ids.add(item.id);
    if (!item.definition || item.definition.trim().length === 0) {
      throw new Error(`design taxonomy: ${name}.${item.id} has an empty definition`);
    }
  }
}

/** Structural integrity only — see the file header. */
export function validateDesignTaxonomy(taxonomy: DesignTaxonomy): void {
  validateLabelList('sections', taxonomy.sections);
  validateLabelList('components', taxonomy.components);
  validateLabelList('mechanics', taxonomy.mechanics);
  validateLabelList('depth', taxonomy.depth);
  validateLabelList('action', taxonomy.action);

  for (const axis of STYLE_AXIS_NAMES) {
    const options = taxonomy.style[axis];
    validateLabelList(`style.${axis}`, options);
    if (options.length < MIN_STYLE_OPTIONS) {
      throw new Error(`design taxonomy: style.${axis} has ${options.length} option(s), needs at least ${MIN_STYLE_OPTIONS}`);
    }
  }

  if (taxonomy.quality.length === 0) throw new Error('design taxonomy: quality must have at least one dimension');
  const qualityIds = new Set<string>();
  for (const dimension of taxonomy.quality) {
    if (qualityIds.has(dimension.id)) throw new Error(`design taxonomy: duplicate quality dimension id ${dimension.id}`);
    qualityIds.add(dimension.id);
    if (dimension.levels.length !== QUALITY_LEVEL_COUNT) {
      throw new Error(`design taxonomy: quality.${dimension.id} has ${dimension.levels.length} level(s), needs exactly ${QUALITY_LEVEL_COUNT} ordered levels`);
    }
    for (const level of dimension.levels) {
      if (!level || level.trim().length === 0) throw new Error(`design taxonomy: quality.${dimension.id} has an empty level description`);
    }
  }

  if (!taxonomy.truthRisk.id || !taxonomy.truthRisk.instructions || !taxonomy.truthRisk.criteriaTrue || !taxonomy.truthRisk.criteriaFalse) {
    throw new Error('design taxonomy: truthRisk must have id, instructions, criteriaTrue and criteriaFalse');
  }
}

export async function loadDesignTaxonomy(file: string = DEFAULT_TAXONOMY_PATH): Promise<DesignTaxonomy> {
  const taxonomy = JSON.parse(await readFile(file, 'utf8')) as DesignTaxonomy;
  validateDesignTaxonomy(taxonomy);
  return taxonomy;
}
