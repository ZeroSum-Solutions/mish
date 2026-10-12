import { byokChoiceCompletenessIssues, FILE_UPLOAD_MAX_BYTES, parseModelPreflightRequest, type ModelPreflightMismatch, type ModelPreflightResult } from '@mish/contracts';
import { isKnownModel, sanitizeCustomModel } from '../runtimes/models.js';
import type { RuntimeAgentDef } from '../runtimes/types.js';

export interface ModelPreflightAgents {
  getAgentDef(agentId: string): RuntimeAgentDef | null | undefined;
  modelScopeForAgent(agentId: string): Promise<string | null>;
}

// Streaming protocols that forward an attached image to the model ONLY
// through an explicit per-adapter image channel gated by
// `RuntimeAgentDef.supportsImagePaths` (see its doc comment in
// runtimes/types.ts and attachPiRpcSession's `images` field). Every other
// shipped adapter is a file-access CLI that reads attachment bytes off disk
// through its own tool calls regardless of this flag — `claude.ts` and
// `codex.ts` both name the `buildArgs` parameter `_imagePaths` because they
// never read it — so treating `supportsImagePaths` as a general vision
// capability for those adapters would be a false positive. Scoping the
// check to the protocols that actually depend on the flag keeps this
// grounded in verified runtime behavior instead of a guess about which
// underlying model is multimodal.
const IMAGE_ROUTING_STREAM_FORMATS = new Set(['pi-rpc', 'acp-json-rpc']);

function requiresExplicitImageRouting(def: RuntimeAgentDef): boolean {
  return IMAGE_ROUTING_STREAM_FORMATS.has(def.streamFormat);
}

function modelKnown(def: RuntimeAgentDef, modelId: string, modelScope: string | null): boolean {
  if (modelId === 'default') return true;
  if (isKnownModel(def, modelId, modelScope)) return true;
  return def.supportsCustomModel !== false && sanitizeCustomModel(modelId) === modelId;
}

/**
 * Pure capability/attachment check for AC-R02.3: before a turn is submitted,
 * tell the caller whether the selected agent/model can actually take the
 * staged attachments, so a mismatch surfaces instead of silently dropping
 * content or failing deep inside a spawned run. Never mutates session state;
 * callers keep the previous usable selection and the drafted prompt on a
 * failed (`ok: false`) result themselves.
 */
export async function evaluateModelPreflight(agents: ModelPreflightAgents, input: unknown): Promise<ModelPreflightResult> {
  const request = parseModelPreflightRequest(input);
  const mismatches: ModelPreflightMismatch[] = [];
  const def = agents.getAgentDef(request.agentId);
  if (!def) {
    mismatches.push({ code: 'model-unavailable', message: `Agent "${request.agentId}" is not installed or not currently available` });
  } else if (request.agentId === 'byok-opencode') {
    // `byok-opencode` admission (`putSessionModel`'s `validateCompleteChoice`
    // in packages/contracts/src/api/workbench-model.ts) requires BOTH a
    // concrete raw model ID and a binding. Evaluate that exact completeness
    // rule here too, so a preflight reporting `ok: true` can never describe a
    // choice the PUT route would then reject (e.g. `{modelId: 'default'}`
    // with no binding — `modelKnown` alone would wrongly call that known).
    for (const issue of byokChoiceCompletenessIssues(request)) {
      mismatches.push({ code: 'model-unavailable', message: `Model "${request.modelId}" is not usable for byok-opencode: ${issue.message}` });
    }
  } else {
    const modelScope = await agents.modelScopeForAgent(request.agentId);
    if (!modelKnown(def, request.modelId, modelScope)) {
      mismatches.push({ code: 'model-unavailable', message: `Model "${request.modelId}" is not available for ${def.name}` });
    }
  }
  if (def) {
    const imageAttachments = (request.attachments ?? []).filter(attachment => attachment.kind === 'image');
    if (imageAttachments.length > 0 && requiresExplicitImageRouting(def) && def.supportsImagePaths !== true) {
      mismatches.push({
        code: 'image-attachments-unsupported',
        message: `${def.name} does not forward image attachments to its model`,
        attachmentNames: imageAttachments.map(attachment => attachment.name),
      });
    }
  }
  const oversized = (request.attachments ?? []).filter(attachment => typeof attachment.size === 'number' && attachment.size > FILE_UPLOAD_MAX_BYTES);
  if (oversized.length > 0) {
    mismatches.push({
      code: 'attachment-too-large',
      message: 'Attachment exceeds the 200 MiB upload limit',
      attachmentNames: oversized.map(attachment => attachment.name),
    });
  }
  return { agentId: request.agentId, modelId: request.modelId, ok: mismatches.length === 0, mismatches };
}
