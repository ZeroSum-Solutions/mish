import { designSystemRunNotice, designSystemSelectability } from '@open-design/contracts';
import { listDesignSystems, type DesignSystemListOptions } from './index.js';

export class DesignSystemGenerationRefusal extends Error {
  constructor(readonly notice: import('@open-design/contracts').DesignSystemRunNotice) {
    super(`${notice.message}${notice.resolveCommand ? ' ' + notice.resolveCommand : ''}`);
  }
}

/** Generation body readers share the catalogue's revision-bound approval gate. */
export async function readGenerationDesignSystem(
  id: string,
  sources: readonly { root: string; options?: DesignSystemListOptions }[],
): Promise<string> {
  for (const { root, options } of sources) {
    const summary = (await listDesignSystems(root, { ...options, freshApproval: true })).find(kit => kit.id === id);
    if (!summary) continue;
    const verdict = designSystemSelectability(summary);
    if (!verdict.selectable) throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary, hasBody: false }));
    if (!summary.body?.trim()) throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary, hasBody: false }));
    return summary.body;
  }
  throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary: null, hasBody: false }));
}

/** Daemon-owned identity captured alongside an OD Next frozen prompt. */
export interface GenerationDesignSystemSelection {
  id: string | null;
  requestedId?: string | null;
  notice?: import('@open-design/contracts').DesignSystemRunNotice | null;
  approvalRevision?: string;
  editingKit?: boolean;
  catalogScope?: { workspaceId?: string; workspaceMemberId?: string };
}
