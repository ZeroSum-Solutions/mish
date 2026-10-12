import { z } from 'zod';
import type { ByokChatProtocol } from './chat.js';
import type { LibraryAssetKind } from './library.js';

/** Existing BYOK chat routes only; this does not declare provider availability. */
const protocols = ['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'] as const satisfies readonly ByokChatProtocol[];
const defaultBaseUrls: Record<ByokChatProtocol, string> = {
  anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1', azure: '',
  google: 'https://generativelanguage.googleapis.com/v1beta', ollama: 'https://ollama.com',
  senseaudio: 'https://api.senseaudio.cn', aihubmix: 'https://aihubmix.com/v1',
};
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const publicId = z.string().trim().min(1).refine(
  value => !/[\s\\\x00-\x1f\x7f]/u.test(value) && !/^(?:\/|\.{1,2}(?:\/|$)|[A-Za-z]:[\\/])/u.test(value),
  'Expected a public identifier without whitespace, controls or filesystem paths',
);
const agentId = publicId.refine(value => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value), 'Expected an agent identifier');
const endpointMessage = 'Session pinning requires an HTTP(S) endpoint without userinfo, query or fragment; use a public base endpoint or keep the existing run-only configuration';
const publicEndpoint = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    const authority = value.match(/^https?:\/\/([^/]+)/iu)?.[1] ?? '';
    if (!authority || !['http:', 'https:'].includes(url.protocol) || !url.hostname || /[\s\\\x00-\x1f\x7f?#]/u.test(value) || authority.includes('@') || url.username || url.password) {
      ctx.addIssue({ code: 'custom', message: endpointMessage });
    }
  } catch { ctx.addIssue({ code: 'custom', message: endpointMessage }); }
});
const bindingInput = z.object({
  protocol: z.enum(protocols),
  baseUrl: z.string().trim(),
  apiVersion: z.string().trim().refine(value => value === '' || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value), 'Expected a structured API version').optional(),
  requiresApiKey: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.protocol === 'azure' && !value.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Azure session bindings require an explicit HTTP(S) endpoint' });
  else {
    const endpoint = publicEndpoint.safeParse(value.baseUrl || defaultBaseUrls[value.protocol]);
    if (!endpoint.success) for (const issue of endpoint.error.issues) ctx.addIssue({ ...issue, path: ['baseUrl', ...issue.path] });
  }
  if (value.protocol !== 'azure' && value.apiVersion !== undefined) ctx.addIssue({ code: 'custom', path: ['apiVersion'], message: 'API version is only supported for Azure session bindings' });
});

export type SessionByokBinding = {
  protocol: ByokChatProtocol;
  baseUrl: string;
  apiVersion?: string;
  requiresApiKey: boolean;
};

/** Mirrors byok-opencode's enabled route rules; credentials never enter here. */
function normalizeBinding(input: z.input<typeof bindingInput>): SessionByokBinding {
  const url = new URL(input.baseUrl || defaultBaseUrls[input.protocol]);
  const path = url.pathname.replace(/\/+$/u, '');
  const originOnly = path === '';
  // Retain the current builder's exact hostname policy, including IPv6's
  // bracketed-host mismatch. Correcting execution policy is a separate change.
  const localOllama = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  let normalizedPath = path;
  if (input.protocol === 'anthropic' && !/\/v\d+(?:\/|$)/u.test(path)) normalizedPath = `${path}/v1`;
  if (input.protocol === 'openai' && url.origin === 'https://api.openai.com' && originOnly) normalizedPath = '/v1';
  if (input.protocol === 'google' && url.origin === 'https://generativelanguage.googleapis.com' && originOnly) normalizedPath = '/v1beta';
  if (input.protocol === 'ollama') {
    if ((url.origin === 'https://ollama.com' && originOnly) || (localOllama && originOnly)) normalizedPath = `${path}/v1`;
    else if (path.endsWith('/api')) normalizedPath = `${path.slice(0, -4)}/v1`;
  }
  url.pathname = normalizedPath;
  const baseUrl = url.toString().replace(/\/+$/u, '');
  const requiresApiKey = input.requiresApiKey && !(input.protocol === 'ollama' && localOllama);
  const version = input.apiVersion?.trim();
  const apiVersion = input.protocol === 'azure'
    ? version || (/\/openai\/v\d+(?:$|\/)/u.test(normalizedPath) ? undefined : '2024-10-21')
    : undefined;
  return { protocol: input.protocol, baseUrl, requiresApiKey, ...(apiVersion === undefined ? {} : { apiVersion }) };
}

const bindingSchema = bindingInput.transform(normalizeBinding);
// Some existing native catalogs use display-form IDs (for example Antigravity).
// Known-model/custom policy belongs to the daemon; BYOK raw IDs remain strict.
const modelId = z.string().trim().min(1).max(200).refine(
  value => !/[\\\x00-\x1f\x7f]/u.test(value) && !/^(?:\/|\.{1,2}(?:\/|$)|[A-Za-z]:[\\/])/u.test(value),
  'Expected a public model identifier without controls or filesystem paths',
);
const choiceFields = { agentId, modelId, byokBinding: bindingSchema.optional() };
type ChoiceFields = { agentId: string; modelId: string; byokBinding?: SessionByokBinding | undefined };
/**
 * `byok-opencode` admission requires BOTH a concrete raw model ID (not
 * `'default'`, not the OpenCode provider-prefixed form) AND a binding.
 * Exported so the model preflight evaluator (`apps/daemon/src/workbench/
 * model-preflight.ts`) can report the exact same incompleteness as a
 * mismatch — otherwise a preflight could report `ok: true` for a choice
 * `putSessionModel`'s own `validateCompleteChoice` (below) would reject.
 */
export function byokChoiceCompletenessIssues(value: Pick<ChoiceFields, 'agentId' | 'modelId' | 'byokBinding'>): Array<{ path: 'modelId' | 'byokBinding'; message: string }> {
  if (value.agentId !== 'byok-opencode') return [];
  const issues: Array<{ path: 'modelId' | 'byokBinding'; message: string }> = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u.test(value.modelId)) issues.push({ path: 'modelId', message: 'BYOK requires a safe concrete raw model ID' });
  if (!value.byokBinding) issues.push({ path: 'byokBinding', message: 'BYOK session choices require a complete public binding' });
  if (value.modelId.toLowerCase() === 'default' || value.modelId.startsWith('mish-byok/')) issues.push({ path: 'modelId', message: 'BYOK session choices require a concrete raw model ID without the OpenCode provider prefix' });
  return issues;
}
function validateCompleteChoice(value: ChoiceFields, ctx: z.RefinementCtx): void {
  if (value.agentId === 'byok-opencode') {
    for (const issue of byokChoiceCompletenessIssues(value)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  } else if (value.byokBinding !== undefined) ctx.addIssue({ code: 'custom', path: ['byokBinding'], message: 'Native session choices forbid a BYOK binding' });
}
const choiceSchema = z.object(choiceFields).strict().superRefine(validateCompleteChoice);
const putSchema = z.object({ ...choiceFields, expectedRevision: safeInteger }).strict().superRefine(validateCompleteChoice);
const snapshotSchema = z.object({ sessionId: publicId, projectId: publicId, revision: safeInteger, choice: choiceSchema.nullable(), updatedAt: safeInteger }).strict();

export type SessionModelChoice = z.infer<typeof choiceSchema>;
export type SessionModelSnapshot = z.infer<typeof snapshotSchema>;
export type PutSessionModel = z.infer<typeof putSchema>;
export const parseSessionByokBinding = (input: unknown): SessionByokBinding => bindingSchema.parse(input);
export const canonicalizeSessionByokBinding = parseSessionByokBinding;
export const parseSessionModelChoice = (input: unknown): SessionModelChoice => choiceSchema.parse(input);
export const parseSessionModelSnapshot = (input: unknown): SessionModelSnapshot => snapshotSchema.parse(input);
export const parsePutSessionModel = (input: unknown): PutSessionModel => putSchema.parse(input);

/** Equality of public execution identity, never keys or a provider-account claim. */
export function sessionByokBindingsEqual(left: SessionByokBinding | undefined, right: SessionByokBinding | undefined): boolean {
  if (!left || !right) return left === right;
  const a = canonicalizeSessionByokBinding(left);
  const b = canonicalizeSessionByokBinding(right);
  return a.protocol === b.protocol && a.baseUrl === b.baseUrl && a.apiVersion === b.apiVersion && a.requiresApiKey === b.requiresApiKey;
}

/** Input/authority validation and revision/CAS decisions remain caller duties. */
export function sessionModelChoicesEqual(left: SessionModelChoice | null, right: SessionModelChoice | null): boolean {
  if (!left || !right) return left === right;
  return left.agentId === right.agentId && left.modelId === right.modelId && sessionByokBindingsEqual(left.byokBinding, right.byokBinding);
}

// --- Model/attachment preflight (AC-R02.3) -------------------------------
// Additive only: does not touch SessionModelSnapshot/PutSessionModel above.
// Checked before submit so a capability mismatch (an unavailable model, an
// agent that will not forward an image attachment to its model, or an
// oversize attachment) surfaces without sending a request the daemon would
// otherwise accept and then silently fail to honor.
const attachmentName = z.string().trim().min(1).max(255).refine(
  value => !/[\/\\\x00-\x1f\x7f]/u.test(value) && value !== '.' && value !== '..',
  'Expected an ordinary attachment name without path separators or control characters',
);
const preflightAttachmentKinds = ['image', 'color', 'design-system', 'font', 'html', 'text', 'url', 'video', 'file'] as const satisfies readonly LibraryAssetKind[];
const preflightAttachmentSchema = z.object({
  name: attachmentName,
  kind: z.enum(preflightAttachmentKinds),
  size: safeInteger.optional(),
  declaredMime: z.string().trim().min(1).max(255).optional(),
}).strict();
const preflightRequestSchema = z.object({
  agentId,
  modelId,
  // Optional: a `byok-opencode` candidate choice is only fully checkable with
  // its binding present (see `byokChoiceCompletenessIssues` above). Omitted
  // entirely for every non-BYOK agent, matching the PUT schema's own shape.
  byokBinding: bindingSchema.optional(),
  attachments: z.array(preflightAttachmentSchema).max(20).optional(),
}).strict();
const preflightMismatchCodeSchema = z.enum(['model-unavailable', 'image-attachments-unsupported', 'attachment-too-large']);
const preflightMismatchSchema = z.object({
  code: preflightMismatchCodeSchema,
  message: z.string().trim().min(1),
  attachmentNames: z.array(attachmentName).max(20).optional(),
}).strict();
const preflightResultSchema = z.object({
  agentId,
  modelId,
  ok: z.boolean(),
  mismatches: z.array(preflightMismatchSchema),
}).strict();

export type ModelPreflightAttachment = z.infer<typeof preflightAttachmentSchema>;
export type ModelPreflightRequest = z.infer<typeof preflightRequestSchema>;
export type ModelPreflightMismatchCode = z.infer<typeof preflightMismatchCodeSchema>;
export type ModelPreflightMismatch = z.infer<typeof preflightMismatchSchema>;
export type ModelPreflightResult = z.infer<typeof preflightResultSchema>;
export const parseModelPreflightRequest = (input: unknown): ModelPreflightRequest => preflightRequestSchema.parse(input);
export const parseModelPreflightResult = (input: unknown): ModelPreflightResult => preflightResultSchema.parse(input);
