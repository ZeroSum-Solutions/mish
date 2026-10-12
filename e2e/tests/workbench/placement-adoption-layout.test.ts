// @vitest-environment node

import { describe, expect, test } from 'vitest';
import {
  WORKBENCH_ADOPTION_EXECUTOR_ENV,
  WORKBENCH_ADOPTION_HELPER_LAYOUT,
  WORKBENCH_ADOPTION_HELPER_RECORD_SCHEMA,
  WORKBENCH_ADOPTION_ROOT_RECORD,
} from '@open-design/contracts';

import {
  PLACEMENT_ADOPTION_EXECUTOR_ENV,
  PLACEMENT_ADOPTION_HELPER_LAYOUT,
  PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA,
  PLACEMENT_ROOT_CREATION_RECORD,
} from '../../../tools/dev/src/placement-adoption-helper.ts';

/**
 * B4-1 C1: tools-dev writes the adoption helper and its record where the
 * daemon reads them. The daemon takes the layout from `packages/contracts`;
 * tools-dev has no contracts dependency, so its copy is pinned equal here.
 */
describe('placement adoption helper layout (tools-dev ↔ daemon contract)', () => {
  test('tools-dev writes exactly the layout, record schema and opt-in the daemon reads', () => {
    expect(PLACEMENT_ADOPTION_HELPER_LAYOUT.toolDir).toEqual(WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir);
    expect(PLACEMENT_ADOPTION_HELPER_LAYOUT.binary).toBe(WORKBENCH_ADOPTION_HELPER_LAYOUT.binary);
    expect(PLACEMENT_ADOPTION_HELPER_LAYOUT.record).toBe(WORKBENCH_ADOPTION_HELPER_LAYOUT.record);
    expect(PLACEMENT_ADOPTION_HELPER_RECORD_SCHEMA).toBe(WORKBENCH_ADOPTION_HELPER_RECORD_SCHEMA);
    expect(PLACEMENT_ADOPTION_EXECUTOR_ENV).toBe(WORKBENCH_ADOPTION_EXECUTOR_ENV);
    expect(PLACEMENT_ROOT_CREATION_RECORD).toEqual(WORKBENCH_ADOPTION_ROOT_RECORD);
  });
});
