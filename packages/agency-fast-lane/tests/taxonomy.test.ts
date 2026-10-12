/**
 * The design taxonomy: loading, structural validation (unique ids, non-empty definitions, style
 * axes carry >=3 options, quality dimensions carry exactly 5 ordered levels), against both the
 * real checked-in `design-taxonomy.json` and small in-memory fixtures for the failure paths.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDesignTaxonomy, validateDesignTaxonomy, type DesignTaxonomy } from '../src/taxonomy.ts';

test('the checked-in taxonomy loads: version 1.0, 28 sections, 24 components, 20 mechanics, 5 depth, 6 style axes, 7 quality dims, 9 actions', async () => {
  const taxonomy = await loadDesignTaxonomy();
  assert.equal(taxonomy.version, '1.0');
  assert.equal(taxonomy.sections.length, 28);
  assert.equal(taxonomy.components.length, 24);
  assert.equal(taxonomy.mechanics.length, 20);
  assert.equal(taxonomy.depth.length, 5);
  assert.equal(Object.keys(taxonomy.style).length, 6);
  for (const axis of ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const) {
    assert.ok(taxonomy.style[axis].length >= 3, `style.${axis} has >= 3 options`);
  }
  assert.equal(taxonomy.quality.length, 7);
  for (const dim of taxonomy.quality) assert.equal(dim.levels.length, 5, `${dim.id} has 5 ordered levels`);
  assert.equal(taxonomy.action.length, 9);
  assert.ok(taxonomy.truthRisk.id === 'truth-risk');
});

test('every label across every vocabulary has a non-empty definition, and ids are unique within each vocabulary', async () => {
  const taxonomy = await loadDesignTaxonomy();
  const lists: { id: string; definition: string }[][] = [
    taxonomy.sections,
    taxonomy.components,
    taxonomy.mechanics,
    taxonomy.depth,
    ...Object.values(taxonomy.style),
    taxonomy.action,
  ];
  for (const list of lists) {
    const ids = new Set<string>();
    for (const item of list) {
      assert.ok(item.definition.trim().length > 0, `${item.id} has a non-empty definition`);
      assert.ok(!ids.has(item.id), `${item.id} is unique within its vocabulary`);
      ids.add(item.id);
    }
  }
});

test('validateDesignTaxonomy passes the checked-in taxonomy without throwing', async () => {
  const taxonomy = await loadDesignTaxonomy();
  assert.doesNotThrow(() => validateDesignTaxonomy(taxonomy));
});

function fixture(overrides: Partial<DesignTaxonomy> = {}): DesignTaxonomy {
  const label = (id: string) => ({ id, definition: `definition for ${id}` });
  return {
    version: '1.0',
    sections: [label('a'), label('b')],
    components: [label('a'), label('b')],
    mechanics: [label('a'), label('b')],
    depth: [label('a')],
    style: {
      ground: [label('g1'), label('g2'), label('g3')],
      accent: [label('a1'), label('a2'), label('a3')],
      typography: [label('t1'), label('t2'), label('t3')],
      imagery: [label('i1'), label('i2'), label('i3')],
      topology: [label('p1'), label('p2'), label('p3')],
      density: [label('d1'), label('d2'), label('d3')],
    },
    quality: [{ id: 'q1', rubric: 'D1', levels: ['0', '1', '2', '3', '4'] }],
    truthRisk: { id: 'truth-risk', instructions: 'x?', criteriaTrue: 'true', criteriaFalse: 'false' },
    action: [label('none')],
    ...overrides,
  };
}

test('validateDesignTaxonomy throws on a duplicate id within one vocabulary', () => {
  const taxonomy = fixture({ sections: [{ id: 'dup', definition: 'x' }, { id: 'dup', definition: 'y' }] });
  assert.throws(() => validateDesignTaxonomy(taxonomy), /duplicate/i);
});

test('validateDesignTaxonomy throws on an empty definition', () => {
  const taxonomy = fixture({ sections: [{ id: 'a', definition: '   ' }] });
  assert.throws(() => validateDesignTaxonomy(taxonomy), /definition/i);
});

test('validateDesignTaxonomy throws when a style axis has fewer than 3 options', () => {
  const taxonomy = fixture({ style: { ...fixture().style, accent: [{ id: 'one', definition: 'x' }] } });
  assert.throws(() => validateDesignTaxonomy(taxonomy), /accent/i);
});

test('validateDesignTaxonomy throws when a quality dimension does not have exactly 5 levels', () => {
  const taxonomy = fixture({ quality: [{ id: 'q1', rubric: 'D1', levels: ['0', '1', '2'] }] });
  assert.throws(() => validateDesignTaxonomy(taxonomy), /5 (ordered )?levels/i);
});
