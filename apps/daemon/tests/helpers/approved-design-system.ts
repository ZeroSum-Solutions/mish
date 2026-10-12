import { readDesignSystemApproval, setDesignSystemApproval } from '../../src/design-systems/approval.js';
import { listUserDesignSystemFiles } from '../../src/design-systems/index.js';

/** Complete generated files before approving the exact fixture revision. */
export async function approveDesignSystemFixture(root: string, id: string): Promise<void> {
  await listUserDesignSystemFiles(root, id);
  const inspection = await readDesignSystemApproval(root, id);
  const approval = await setDesignSystemApproval(root, id, true, inspection.revision);
  if (approval.status !== 'approved') throw new Error(`Fixture approval failed: ${id}`);
}
