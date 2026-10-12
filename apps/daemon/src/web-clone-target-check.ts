import { extractWebCloneTargetUrls } from '@open-design/contracts';

import { assertPublicBrandUrl, type PublicUrlHostLookup } from './brands/safe-fetch.js';

const WEB_CLONE_TARGET_REFUSED_MESSAGE =
  'The website to clone is not a public web address. Enter a public http(s) URL, for example https://example.com.';

/**
 * The refusal message for a Website Clone create (D15) whose brief names no
 * public http(s) page — or names any address that is not public or does not
 * resolve — or `null` when the create may proceed. Only projects with
 * `metadata.intent === 'web-clone'` and a non-empty brief are gated; a project
 * created without a brief has no run to start yet. `lookup` replaces the
 * system resolver; tests inject a stub so they make no real DNS query.
 *
 * Best-effort pre-check on user intent only. It is NOT an SSRF or
 * DNS-rebinding control: the agent later fetches the site with its own tools,
 * under their own network policy, and DNS can answer differently by then.
 */
export async function webCloneTargetRefusal(
  metadata: unknown,
  pendingPrompt: unknown,
  lookup?: PublicUrlHostLookup,
): Promise<string | null> {
  if (!metadata || typeof metadata !== 'object') return null;
  if ((metadata as { intent?: unknown }).intent !== 'web-clone') return null;
  if (typeof pendingPrompt !== 'string' || !pendingPrompt.trim()) return null;
  const targets = extractWebCloneTargetUrls(pendingPrompt);
  if (targets.length === 0) return WEB_CLONE_TARGET_REFUSED_MESSAGE;
  try {
    await Promise.all(
      targets.map((target) =>
        assertPublicBrandUrl(target, { requireResolvable: true, ...(lookup ? { lookup } : {}) })),
    );
  } catch {
    return WEB_CLONE_TARGET_REFUSED_MESSAGE;
  }
  return null;
}
